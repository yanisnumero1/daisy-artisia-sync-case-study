import crypto from "node:crypto";
import { PartnerError, type PartnerClient } from "./partner.js";
import { Store } from "./store.js";
import type { Booking, PartnerWebhook } from "./types.js";

/** In-memory business model; differences from the Supabase flow are documented in the README. */
export class SyncService {
  constructor(
    private readonly store: Store,
    private readonly partner: PartnerClient,
    private readonly webhookSecret = "test-secret",
  ) {}

  /**
   * Holds seats before contacting the partner and keeps this lock throughout the call.
   * An error can leave an uncertain booking in memory: it does not necessarily mean
   * that booking creation failed at Artisia.
   */
  async bookInDaisy(input: {
    id: string; slotId: string; seats: number; customerName: string; customerEmail: string;
  }): Promise<Booking> {
    const slot = this.store.slots.get(input.slotId);
    if (!slot) throw new Error("Unknown slot");

    return this.store.withSlotLock(input.slotId, async () => {
      if (slot.syncState !== "healthy") {
        throw new Error("Réservation temporairement indisponible : synchronisation Artisia dégradée.");
      }
      if (this.store.availableSeats(input.slotId) < input.seats) {
        throw new Error("Ce créneau n'a plus assez de places.");
      }

      const booking: Booking = {
        id: input.id,
        slotId: input.slotId,
        source: "daisy",
        seats: input.seats,
        customerName: input.customerName,
        customerEmail: input.customerEmail,
        status: "pending",
        createdAt: new Date().toISOString(),
      };
      this.store.bookings.set(booking.id, booking);

      try {
        const response = await this.partner.createBooking({
          sessionId: slot.partnerSessionId,
          customer: { name: input.customerName, email: input.customerEmail },
          seats: input.seats,
          externalRef: input.id,
        });
        booking.status = "confirmed";
        booking.sourceBookingId = response.booking_id;
        return booking;
      } catch (error) {
        if (error instanceof PartnerError && error.kind === "conflict") {
          // The prototype deletes the hold; Supabase retains a cancelled row.
          this.store.bookings.delete(booking.id);
          throw new Error("Artisia vient de prendre la dernière place. La réservation n'a pas été confirmée.");
        }
        // A timeout or 500 may have happened after Artisia committed the booking.
        // We keep the seat held and require reconciliation instead of retrying a non-idempotent POST.
        booking.status = "uncertain";
        slot.syncState = "needs_review";
        throw new Error("Réservation reçue mais confirmation partenaire incertaine. Elle sera vérifiée.");
      }
    });
  }

  /**
   * The caller must supply an event parsed from the same rawBody that was signed.
   * Dates are compared as strings: use a consistent ISO UTC format.
   * In-memory deduplication is not a substitute for PostgreSQL unique constraints.
   */
  async receiveWebhook(rawBody: string, signature: string, event: PartnerWebhook) {
    this.verifySignature(rawBody, signature);
    if (this.store.processedEvents.has(event.event_id)) return { status: "duplicate" as const };

    const slot = [...this.store.slots.values()].find((candidate) => candidate.partnerSessionId === event.data.session_id);
    if (!slot) throw new Error("Unknown Artisia session");

    return this.store.withSlotLock(slot.id, async () => {
      this.store.processedEvents.add(event.event_id);
      const eventKey = event.data.booking_id ?? event.data.session_id;
      const previousAt = this.store.latestExternalEventAt.get(eventKey);
      if (previousAt && event.occurred_at <= previousAt) {
        this.store.staleEvents.add(event.event_id);
        return { status: "stale" as const };
      }
      this.store.latestExternalEventAt.set(eventKey, event.occurred_at);
      if (event.type === "booking.created") {
        const cancelledAt = event.data.booking_id
          ? this.store.cancelledExternalBookings.get(event.data.booking_id)
          : undefined;
        if (cancelledAt && cancelledAt >= event.occurred_at) {
          return { status: "stale" as const };
        }
        const alreadyKnown = [...this.store.bookings.values()].some(
          (booking) => booking.sourceBookingId === event.data.booking_id,
        );
        if (alreadyKnown) return { status: "duplicate" as const };

        const seats = event.data.seats ?? 0;
        // Only the conflict is retained here. SQL also records the external sale.
        if (this.store.availableSeats(slot.id) < seats) {
          slot.syncState = "needs_review";
          this.store.conflicts.push({ slotId: slot.id, eventId: event.event_id, reason: "external_overbooking" });
          return { status: "accepted_for_review" as const };
        }
        const booking: Booking = {
          id: `external:${event.data.booking_id}`,
          source: "artisia",
          sourceBookingId: event.data.booking_id,
          slotId: slot.id,
          seats,
          customerName: event.data.customer?.name ?? "Client Artisia",
          customerEmail: event.data.customer?.email ?? "",
          status: "confirmed",
          createdAt: event.occurred_at,
        };
        this.store.bookings.set(booking.id, booking);
      } else if (event.type === "booking.cancelled" && event.data.booking_id) {
        this.store.cancelledExternalBookings.set(event.data.booking_id, event.occurred_at);
        const booking = [...this.store.bookings.values()].find(
          (candidate) => candidate.sourceBookingId === event.data.booking_id,
        );
        if (booking) booking.status = "cancelled";
      }
      return { status: "processed" as const };
    });
  }

  /**
   * Simplified manual reconciliation, without a worker or per-slot locking.
   * Matching totals confirm all uncertain bookings for the slot,
   * but do not establish their identity at Artisia. A mismatch leaves needs_review
   * without creating a conflict; existing conflicts are not closed.
   */
  async reconcile() {
    const sessions = await this.partner.listSessions();
    for (const session of sessions) {
      const slot = [...this.store.slots.values()].find((candidate) => candidate.partnerSessionId === session.session_id);
      if (!slot) continue;
      const knownSeats = [...this.store.bookings.values()]
        .filter((booking) => booking.slotId === slot.id && booking.status !== "cancelled")
        .reduce((sum, booking) => sum + booking.seats, 0);
      slot.partnerBooked = session.booked;
      if (knownSeats !== session.booked) slot.syncState = "needs_review";
      else {
        slot.syncState = "healthy";
        for (const booking of this.store.bookings.values()) {
          if (booking.slotId === slot.id && booking.status === "uncertain") booking.status = "confirmed";
        }
      }
    }
  }

  private verifySignature(rawBody: string, received: string) {
    const expected = `sha256=${crypto.createHmac("sha256", this.webhookSecret).update(rawBody).digest("hex")}`;
    if (received.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(received), Buffer.from(expected))) {
      throw new Error("Invalid webhook signature");
    }
  }
}
