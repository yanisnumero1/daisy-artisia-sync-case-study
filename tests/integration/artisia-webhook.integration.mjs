import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHmac } from "node:crypto";
import { after, before, beforeEach, test } from "node:test";
import postgres from "postgres";

const slotId = "11111111-1111-1111-1111-111111111111";
const functionUrl =
  "http://127.0.0.1:54321/functions/v1/artisia-webhook";
const webhookSecret = "test-secret";

let database;
let functionProcess;

function startProcess(command, args) {
  const child = spawn(command, args, {
    cwd: process.cwd(),
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });

  // Consume the logs so the child process never blocks the tests.
  child.stdout.resume();
  child.stderr.resume();

  return child;
}

async function waitForStatus(
  url,
  expectedStatus,
  timeoutMs = 30_000,
) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);

      // Kong can answer before the Edge Function is completely ready.
      if (response.status === expectedStatus) {
        return;
      }
    } catch {
      // The local service is still starting.
    }

    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  throw new Error(`Service did not become available: ${url}`);
}

function signBody(rawBody) {
  return createHmac("sha256", webhookSecret)
    .update(rawBody)
    .digest("hex");
}

async function sendWebhook(event, signature) {
  const rawBody = JSON.stringify(event);
  const digest = signature ?? signBody(rawBody);

  return fetch(functionUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Artisia-Signature": `sha256=${digest}`,
    },
    body: rawBody,
  });
}

function bookingCreatedEvent({
  eventId,
  bookingId,
  occurredAt,
  seats = 1,
  name = "Client Artisia",
  email = "client@example.com",
}) {
  return {
    event_id: eventId,
    type: "booking.created",
    occurred_at: occurredAt,
    data: {
      booking_id: bookingId,
      session_id: "art_ses_8812",
      seats,
      customer: {
        name,
        email,
      },
    },
  };
}

before(
  async () => {
    // Start every integration run from the migrations and seed data.
    execFileSync("supabase", ["db", "reset"], {
      cwd: process.cwd(),
      stdio: "inherit",
    });

    database = postgres(
      "postgresql://postgres:postgres@127.0.0.1:54322/postgres",
      { max: 1 },
    );

    functionProcess = startProcess("supabase", [
      "functions",
      "serve",
      "artisia-webhook",
      "--no-verify-jwt",
      "--env-file",
      "supabase/.env.local",
    ]);

    await waitForStatus(functionUrl, 405);
  },
  { timeout: 60_000 },
);

beforeEach(async () => {
  // Each scenario starts with the same healthy and empty slot.
  await database.begin(async (sql) => {
    await sql`delete from public.sync_conflicts`;
    await sql`delete from public.webhook_events`;
    await sql`delete from public.bookings`;

    await sql`
      update public.slot_partners
      set
        status = 'published',
        sync_status = 'healthy',
        last_known_booked = 0
      where slot_id = ${slotId}
        and partner = 'artisia'
    `;
  });
});

after(async () => {
  if (functionProcess && !functionProcess.killed) {
    functionProcess.kill("SIGTERM");
  }

  if (database) {
    await database.end({ timeout: 2 });
  }
});

test("rejects an invalid webhook signature", async () => {
  const event = bookingCreatedEvent({
    eventId: "evt_invalid_signature",
    bookingId: "art_bk_invalid_signature",
    occurredAt: "2026-09-08T14:00:00Z",
  });

  const response = await sendWebhook(event, "invalid");

  assert.equal(response.status, 401);
  assert.equal((await response.json()).error, "Invalid signature");

  const [events] = await database`
    select count(*)::integer as count
    from public.webhook_events
  `;

  assert.equal(events.count, 0);
});

test("processes a valid Artisia booking webhook", async () => {
  const event = bookingCreatedEvent({
    eventId: "evt_valid_booking",
    bookingId: "art_bk_valid_booking",
    occurredAt: "2026-09-08T14:00:00Z",
    seats: 2,
    name: "Emma Durand",
    email: "emma@example.com",
  });

  const response = await sendWebhook(event);

  assert.equal(response.status, 200);
  assert.equal((await response.json()).status, "processed");

  const [booking] = await database`
    select source, source_booking_id, seats, status
    from public.bookings
    where source_booking_id = 'art_bk_valid_booking'
  `;

  assert.equal(booking.source, "artisia");
  assert.equal(booking.source_booking_id, "art_bk_valid_booking");
  assert.equal(booking.seats, 2);
  assert.equal(booking.status, "confirmed");
});

test("acknowledges a duplicate without applying it twice", async () => {
  const event = bookingCreatedEvent({
    eventId: "evt_duplicate_booking",
    bookingId: "art_bk_duplicate_booking",
    occurredAt: "2026-09-08T14:00:00Z",
  });

  const firstResponse = await sendWebhook(event);
  const secondResponse = await sendWebhook(event);

  assert.equal(firstResponse.status, 200);
  assert.equal((await firstResponse.json()).status, "processed");
  assert.equal(secondResponse.status, 200);
  assert.equal((await secondResponse.json()).status, "duplicate");

  const [events] = await database`
    select count(*)::integer as count
    from public.webhook_events
    where event_id = 'evt_duplicate_booking'
  `;

  const [bookings] = await database`
    select count(*)::integer as count
    from public.bookings
    where source_booking_id = 'art_bk_duplicate_booking'
  `;

  assert.equal(events.count, 1);
  assert.equal(bookings.count, 1);
});

test("keeps a booking cancelled when an older event arrives later", async () => {
  const creation = bookingCreatedEvent({
    eventId: "evt_booking_created",
    bookingId: "art_bk_ordered_events",
    occurredAt: "2026-09-08T14:00:00Z",
    email: "ordered@example.com",
  });

  const cancellation = {
    event_id: "evt_booking_cancelled",
    type: "booking.cancelled",
    occurred_at: "2026-09-08T14:05:00Z",
    data: {
      booking_id: "art_bk_ordered_events",
      session_id: "art_ses_8812",
    },
  };

  const lateCreation = bookingCreatedEvent({
    eventId: "evt_booking_created_late",
    bookingId: "art_bk_ordered_events",
    occurredAt: "2026-09-08T14:02:00Z",
    email: "ordered@example.com",
  });

  assert.equal((await sendWebhook(creation)).status, 200);
  assert.equal((await sendWebhook(cancellation)).status, 200);

  const lateResponse = await sendWebhook(lateCreation);

  assert.equal(lateResponse.status, 200);
  assert.equal((await lateResponse.json()).status, "stale");

  const [booking] = await database`
    select status
    from public.bookings
    where source_booking_id = 'art_bk_ordered_events'
  `;

  assert.equal(booking.status, "cancelled");
});

test("flags an external booking that exceeds the slot capacity", async () => {
  // This uncertain Daisy booking still holds two seats.
  await database`
    insert into public.bookings (
      slot_id,
      source,
      seats,
      customer_name,
      customer_email,
      status
    )
    values (
      ${slotId},
      'daisy',
      2,
      'Lucas Bernard',
      'lucas@example.com',
      'uncertain'
    )
  `;

  const event = bookingCreatedEvent({
    eventId: "evt_external_overbooking",
    bookingId: "art_bk_external_overbooking",
    occurredAt: "2026-09-08T14:10:00Z",
    seats: 7,
    name: "Nora Lefevre",
    email: "nora@example.com",
  });

  const response = await sendWebhook(event);

  assert.equal(response.status, 200);
  assert.equal((await response.json()).status, "processed");

  const [publication] = await database`
    select sync_status
    from public.slot_partners
    where slot_id = ${slotId}
      and partner = 'artisia'
  `;

  const [conflict] = await database`
    select reason, resolved_at
    from public.sync_conflicts
    where event_id = 'evt_external_overbooking'
  `;

  const [externalBooking] = await database`
    select status
    from public.bookings
    where source_booking_id = 'art_bk_external_overbooking'
  `;

  assert.equal(publication.sync_status, "needs_review");
  assert.equal(conflict.reason, "external_overbooking");
  assert.equal(conflict.resolved_at, null);
  assert.equal(externalBooking.status, "confirmed");
});

test("applies three concurrently delivered copies of a webhook only once", async () => {
  const event = bookingCreatedEvent({ eventId: "evt_concurrent", bookingId: "art_concurrent", occurredAt: "2026-09-10T15:00:00Z" });
  const responses = await Promise.all(Array.from({ length: 3 }, () => sendWebhook(event)));
  assert.ok(responses.every((response) => response.status === 200));
  const [events] = await database`select count(*)::integer as count from public.webhook_events where event_id = 'evt_concurrent'`;
  const [bookings] = await database`select count(*)::integer as count from public.bookings where source_booking_id = 'art_concurrent'`;
  assert.equal(events.count, 1);
  assert.equal(bookings.count, 1);
});

test("deduplicates the same external booking under concurrent distinct event IDs", async () => {
  const responses = await Promise.all(["evt_same_a", "evt_same_b"].map((eventId) =>
    sendWebhook(bookingCreatedEvent({ eventId, bookingId: "art_same", occurredAt: "2026-09-10T15:00:00Z" }))));
  assert.ok(responses.every((response) => response.status === 200));
  const [bookings] = await database`select count(*)::integer as count from public.bookings where source_booking_id = 'art_same'`;
  assert.equal(bookings.count, 1);
});

test("does not resurrect a booking when cancellation arrives before its creation", async () => {
  const cancellation = { event_id: "evt_cancel_first", type: "booking.cancelled", occurred_at: "2026-09-10T15:05:00Z",
    data: { session_id: "art_ses_8812", booking_id: "art_cancel_first" } };
  assert.equal((await sendWebhook(cancellation)).status, 200);
  const late = await sendWebhook(bookingCreatedEvent({ eventId: "evt_create_late", bookingId: "art_cancel_first", occurredAt: "2026-09-10T15:00:00Z" }));
  assert.equal((await late.json()).status, "stale");
  const [bookings] = await database`select count(*)::integer as count from public.bookings where source_booking_id = 'art_cancel_first' and status <> 'cancelled'`;
  assert.equal(bookings.count, 0);
});

test("updates partner session data and pauses a cancelled publication", async () => {
  const response = await sendWebhook({ event_id: "evt_session_cancelled", type: "session.updated", occurred_at: "2026-09-10T15:00:00Z",
    data: { session_id: "art_ses_8812", capacity: 6, booked: 2, status: "cancelled" } });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).status, "processed");
  const [publication] = await database`select status, sync_status, last_known_capacity, last_known_booked from public.slot_partners where slot_id = ${slotId}`;
  assert.equal(publication.status, "cancelled");
  assert.equal(publication.sync_status, "needs_review");
  assert.equal(publication.last_known_capacity, 6);
  assert.equal(publication.last_known_booked, 2);
});
