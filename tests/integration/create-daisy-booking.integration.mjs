import { createHmac } from "node:crypto";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { after, before, beforeEach, test } from "node:test";
import postgres from "postgres";

const slotId = "11111111-1111-1111-1111-111111111111";
const functionUrl =
  "http://127.0.0.1:54321/functions/v1/create-daisy-booking";
const mockUrl = "http://127.0.0.1:4010";

let database;
let mockProcess;
let functionProcess;

function startProcess(command, args) {
  const child = spawn(command, args, {
    cwd: process.cwd(),
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });

  // Consume the logs so long-running child processes never block the tests.
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

      // Kong can return 503 before the Edge Function is actually ready.
      if (response.status === expectedStatus) {
        return;
      }
    } catch {
      // The service is still starting.
    }

    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  throw new Error(`Service did not become available: ${url}`);
}

async function setScenario(scenario) {
  const response = await fetch(`${mockUrl}/__scenario`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ scenario }),
  });

  assert.equal(response.status, 200);
}

async function createBooking({
  name,
  email,
  seats = 1,
}) {
  return fetch(functionUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      slotId,
      seats,
      customerName: name,
      customerEmail: email,
    }),
  });
}

before(
  async () => {
    // Start every integration run from the migrations and documented seed data.
    execFileSync("supabase", ["db", "reset"], {
      cwd: process.cwd(),
      stdio: "inherit",
    });

    database = postgres(
      "postgresql://postgres:postgres@127.0.0.1:54322/postgres",
      { max: 1 },
    );

    mockProcess = startProcess(process.execPath, [
      "scripts/artisia-mock.mjs",
    ]);
    await waitForStatus(`${mockUrl}/__state`, 200);

    functionProcess = startProcess("supabase", [
      "functions",
      "serve",
      "--no-verify-jwt",
      "--env-file",
      "supabase/.env.local",
    ]);
    await waitForStatus(functionUrl, 405);
    await waitForStatus("http://127.0.0.1:54321/functions/v1/artisia-webhook", 405);
  },
  { timeout: 60_000 },
);

beforeEach(async () => {
  // Each scenario gets the same healthy slot with no previous bookings.
  await database.begin(async (sql) => {
    await sql`delete from public.sync_conflicts`;
    await sql`delete from public.webhook_events`;
    await sql`delete from public.bookings`;
    await sql`update public.slots set capacity = 8 where id = ${slotId}`;

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

  await setScenario("success");
});

after(async () => {
  if (functionProcess && !functionProcess.killed) {
    functionProcess.kill("SIGTERM");
  }

  if (mockProcess && !mockProcess.killed) {
    mockProcess.kill("SIGTERM");
  }

  if (database) {
    await database.end({ timeout: 2 });
  }
});

test("confirms a booking after Artisia returns 201", async () => {
  const response = await createBooking({
    name: "Alice Moreau",
    email: "alice@example.com",
    seats: 2,
  });

  assert.equal(response.status, 200);
  assert.equal((await response.json()).status, "confirmed");

  const [booking] = await database`
    select source, source_booking_id, seats, status
    from public.bookings
    where customer_email = 'alice@example.com'
  `;

  assert.equal(booking.source, "daisy");
  assert.equal(booking.source_booking_id, "art_bk_mock_001");
  assert.equal(booking.seats, 2);
  assert.equal(booking.status, "confirmed");
});

test("releases the local hold after Artisia returns 409", async () => {
  await setScenario("conflict");

  const response = await createBooking({
    name: "Bastien Leroy",
    email: "bastien@example.com",
    seats: 3,
  });

  assert.equal(response.status, 409);
  assert.equal((await response.json()).status, "cancelled");

  const [booking] = await database`
    select source_booking_id, status
    from public.bookings
    where customer_email = 'bastien@example.com'
  `;

  assert.equal(booking.source_booking_id, null);
  assert.equal(booking.status, "cancelled");

  const [availability] = await database`
    select coalesce(sum(seats), 0)::integer as occupied_seats
    from public.bookings
    where status in ('pending', 'confirmed', 'uncertain')
  `;

  assert.equal(availability.occupied_seats, 0);
});

test("keeps the booking uncertain after Artisia returns 500", async () => {
  await setScenario("error");

  const response = await createBooking({
    name: "Chloe Robert",
    email: "chloe@example.com",
    seats: 3,
  });

  assert.equal(response.status, 202);
  assert.equal((await response.json()).status, "uncertain");

  const [booking] = await database`
    select source_booking_id, status
    from public.bookings
    where customer_email = 'chloe@example.com'
  `;

  const [publication] = await database`
    select sync_status
    from public.slot_partners
    where slot_id = ${slotId}
      and partner = 'artisia'
  `;

  assert.equal(booking.source_booking_id, null);
  assert.equal(booking.status, "uncertain");
  assert.equal(publication.sync_status, "needs_review");
});

test("pauses new sales while the partner needs review", async () => {
  await setScenario("error");

  const firstResponse = await createBooking({
    name: "Thomas Garcia",
    email: "thomas@example.com",
  });

  assert.equal(firstResponse.status, 202);

  // A healthy mock must not be called while the stored partner state is degraded.
  await setScenario("success");

  const secondResponse = await createBooking({
    name: "Eva Martin",
    email: "eva@example.com",
  });

  assert.equal(secondResponse.status, 503);
  assert.equal((await secondResponse.json()).status, "unavailable");

  const [evaBookings] = await database`
    select count(*)::integer as count
    from public.bookings
    where customer_email = 'eva@example.com'
  `;

  const mockStateResponse = await fetch(`${mockUrl}/__state`);
  const mockState = await mockStateResponse.json();

  assert.equal(evaBookings.count, 0);
  assert.equal(mockState.bookingRequestCount, 0);
});

test(
  "does not retry the non-idempotent POST after a timeout",
  { timeout: 15_000 },
  async () => {
    await setScenario("slow");

    const startedAt = Date.now();
    const response = await createBooking({
      name: "Nora Lefevre",
      email: "nora@example.com",
      seats: 2,
    });
    const durationMs = Date.now() - startedAt;

    assert.equal(response.status, 202);
    assert.equal((await response.json()).status, "uncertain");
    assert.ok(durationMs >= 6_500);

    const [booking] = await database`
      select status
      from public.bookings
      where customer_email = 'nora@example.com'
    `;

    const mockStateResponse = await fetch(`${mockUrl}/__state`);
    const mockState = await mockStateResponse.json();

    assert.equal(booking.status, "uncertain");
    assert.equal(mockState.bookingRequestCount, 1);
  },
);

async function waitForPartnerCall() {
  const deadline = Date.now() + 4_000;
  while (Date.now() < deadline) {
    const state = await (await fetch(`${mockUrl}/__state`)).json();
    if (state.bookingRequestCount === 1) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("Daisy did not reach the partner barrier");
}

test("serializes simultaneous HTTP bookings for the last PostgreSQL seat", async () => {
  await database`update public.slots set capacity = 1 where id = ${slotId}`;
  const responses = await Promise.all([
    createBooking({ name: "First", email: "first@example.com" }),
    createBooking({ name: "Second", email: "second@example.com" }),
  ]);
  assert.deepEqual(responses.map((response) => response.status).sort(), [200, 409]);
  const bookings = await database`select status, seats from public.bookings where slot_id = ${slotId}`;
  assert.equal(bookings.length, 1);
  assert.equal(bookings[0].status, "confirmed");
  assert.equal(bookings[0].seats, 1);
  const state = await (await fetch(`${mockUrl}/__state`)).json();
  assert.equal(state.bookingRequestCount, 1);
});

test("records an external sale during an in-flight Daisy booking and pauses sales", async () => {
  await database`update public.slots set capacity = 1 where id = ${slotId}`;
  await setScenario("held");
  const pendingResponse = createBooking({ name: "Daisy", email: "race@example.com" });
  try {
    await waitForPartnerCall();
    const [hold] = await database`select status from public.bookings where slot_id = ${slotId}`;
    assert.equal(hold.status, "pending");
    const body = JSON.stringify({
      event_id: "evt_inflight", type: "booking.created", occurred_at: "2026-09-10T15:00:00Z",
      data: { session_id: "art_ses_8812", booking_id: "art_direct", seats: 1 },
    });
    const signature = "sha256=" + createHmac("sha256", "test-secret").update(body).digest("hex");
    const webhook = await fetch("http://127.0.0.1:54321/functions/v1/artisia-webhook", {
      method: "POST", headers: { "Content-Type": "application/json", "X-Artisia-Signature": signature }, body,
    });
    assert.equal(webhook.status, 200);
    assert.equal((await webhook.json()).status, "processed");
  } finally {
    await fetch(`${mockUrl}/__release`, { method: "POST" });
  }
  assert.equal((await pendingResponse).status, 200);
  const bookings = await database`select status from public.bookings where slot_id = ${slotId}`;
  assert.equal(bookings.length, 2);
  assert.ok(bookings.every((booking) => booking.status === "confirmed"));
  const conflicts = await database`select reason from public.sync_conflicts where slot_id = ${slotId}`;
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0].reason, "external_overbooking");
  const [publication] = await database`select sync_status from public.slot_partners where slot_id = ${slotId}`;
  assert.equal(publication.sync_status, "needs_review");
  assert.equal((await createBooking({ name: "Later", email: "later@example.com" })).status, 503);
  const state = await (await fetch(`${mockUrl}/__state`)).json();
  assert.equal(state.bookingRequestCount, 1);
});
