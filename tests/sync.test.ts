import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import { MockArtisia, PartnerError } from "../src/partner.js";
import { Store } from "../src/store.js";
import { SyncService } from "../src/sync.js";
import type { PartnerWebhook } from "../src/types.js";

function setup() {
  const partner = new MockArtisia();
  partner.addSession({
    session_id: "art_ses_8812", external_ref: "slot-1", title: "Tour de potier débutant",
    starts_at: "2027-01-16T14:00:00+01:00", duration_minutes: 120, capacity: 8, booked: 0,
    status: "published", updated_at: new Date().toISOString(),
  });
  const store = new Store();
  store.slots.set("slot-1", { id: "slot-1", title: "Tour de potier débutant", capacity: 8, partnerSessionId: "art_ses_8812", partnerBooked: 0, syncState: "healthy" });
  return { partner, store, service: new SyncService(store, partner) };
}

function signed(event: PartnerWebhook) {
  const raw = JSON.stringify(event);
  const signature = `sha256=${crypto.createHmac("sha256", "test-secret").update(raw).digest("hex")}`;
  return { raw, signature };
}

describe("Daisy / Artisia synchronization", () => {
  it("books in Daisy and mirrors the booking to Artisia", async () => {
    const { service, store, partner } = setup();
    const booking = await service.bookInDaisy({ id: "daisy-1", slotId: "slot-1", seats: 2, customerName: "Camille", customerEmail: "camille@example.com" });
    expect(booking.status).toBe("confirmed");
    expect(store.availableSeats("slot-1")).toBe(6);
    expect((await partner.listSessions())[0].booked).toBe(2);
  });

  it("serializes two simultaneous Daisy bookings for the last seat", async () => {
    const { service, store, partner } = setup();
    const slot = store.slots.get("slot-1")!;
    slot.capacity = 1;
    const results = await Promise.allSettled([
      service.bookInDaisy({ id: "daisy-a", slotId: "slot-1", seats: 1, customerName: "A", customerEmail: "a@example.com" }),
      service.bookInDaisy({ id: "daisy-b", slotId: "slot-1", seats: 1, customerName: "B", customerEmail: "b@example.com" }),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect((await partner.listSessions())[0].booked).toBe(1);
  });

  it("does not retry an ambiguous non-idempotent POST after a timeout", async () => {
    const { service, store, partner } = setup();
    partner.behavior = "timeout";
    await expect(service.bookInDaisy({ id: "daisy-timeout", slotId: "slot-1", seats: 1, customerName: "A", customerEmail: "a@example.com" })).rejects.toThrow("incertaine");
    expect(store.bookings.get("daisy-timeout")?.status).toBe("uncertain");
    expect(store.slots.get("slot-1")?.syncState).toBe("needs_review");
  });

  it("processes a webhook once and ignores the duplicate event", async () => {
    const { service, store } = setup();
    const event: PartnerWebhook = { event_id: "evt-1", type: "booking.created", occurred_at: "2027-01-14T09:31:07Z", data: { booking_id: "art-bk-1", session_id: "art_ses_8812", seats: 1, customer: { name: "Sofia", email: "sofia@example.com" } } };
    const { raw, signature } = signed(event);
    await expect(service.receiveWebhook(raw, signature, event)).resolves.toEqual({ status: "processed" });
    await expect(service.receiveWebhook(raw, signature, event)).resolves.toEqual({ status: "duplicate" });
    expect(store.bookings.size).toBe(1);
  });

  it("rejects invalid webhook signatures", async () => {
    const { service } = setup();
    const event: PartnerWebhook = { event_id: "evt-invalid", type: "booking.created", occurred_at: new Date().toISOString(), data: { booking_id: "art-bk-x", session_id: "art_ses_8812", seats: 1 } };
    await expect(service.receiveWebhook(JSON.stringify(event), "sha256=wrong", event)).rejects.toThrow("Invalid webhook signature");
  });

  it("flags an external booking that races with the last Daisy seat", async () => {
    const { service, store } = setup();
    await service.bookInDaisy({ id: "daisy-last", slotId: "slot-1", seats: 7, customerName: "A", customerEmail: "a@example.com" });
    const event: PartnerWebhook = { event_id: "evt-race", type: "booking.created", occurred_at: new Date().toISOString(), data: { booking_id: "art-bk-race", session_id: "art_ses_8812", seats: 2 } };
    const { raw, signature } = signed(event);
    await expect(service.receiveWebhook(raw, signature, event)).resolves.toEqual({ status: "accepted_for_review" });
    expect(store.conflicts[0].reason).toBe("external_overbooking");
    expect(store.slots.get("slot-1")?.syncState).toBe("needs_review");
  });

  it("reconciles an uncertain booking when Artisia's aggregate matches", async () => {
    const { service, store, partner } = setup();
    partner.behavior = "normal";
    await service.bookInDaisy({ id: "daisy-1", slotId: "slot-1", seats: 1, customerName: "A", customerEmail: "a@example.com" });
    store.bookings.get("daisy-1")!.status = "uncertain";
    store.slots.get("slot-1")!.syncState = "needs_review";
    await service.reconcile();
    expect(store.bookings.get("daisy-1")?.status).toBe("confirmed");
    expect(store.slots.get("slot-1")?.syncState).toBe("healthy");
  });

  it("ignores an older webhook delivered after a newer one", async () => {
    const { service, store } = setup();
    const newer: PartnerWebhook = { event_id: "evt-new", type: "booking.created", occurred_at: "2027-01-14T09:31:10Z", data: { booking_id: "art-bk-order", session_id: "art_ses_8812", seats: 1 } };
    const older: PartnerWebhook = { ...newer, event_id: "evt-old", occurred_at: "2027-01-14T09:30:00Z", type: "booking.cancelled" };
    const first = signed(newer);
    const second = signed(older);
    await service.receiveWebhook(first.raw, first.signature, newer);
    await expect(service.receiveWebhook(second.raw, second.signature, older)).resolves.toEqual({ status: "stale" });
    expect(store.bookings.get("external:art-bk-order")?.status).toBe("confirmed");
  });

  it("keeps the conflict behavior explicit", () => {
    expect(new PartnerError("x", "conflict").kind).toBe("conflict");
  });
});
