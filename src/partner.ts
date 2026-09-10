import type { ArtisiaBookingResponse, ArtisiaSession } from "./types.js";

export class PartnerError extends Error {
  constructor(
    message: string,
    public readonly kind: "conflict" | "rate_limit" | "server" | "timeout" | "not_found",
  ) {
    super(message);
  }
}

/** Prototype contract; externalRef provides correlation, not an idempotency guarantee. */
export interface PartnerClient {
  listSessions(): Promise<ArtisiaSession[]>;
  createBooking(input: {
    sessionId: string;
    customer: { name: string; email: string };
    seats: number;
    externalRef: string;
  }): Promise<ArtisiaBookingResponse>;
  deleteBooking(bookingId: string): Promise<void>;
}

/** In-memory unit test mock, separate from the HTTP server in scripts/artisia-mock.mjs. */
export class MockArtisia implements PartnerClient {
  sessions = new Map<string, ArtisiaSession>();
  bookings = new Map<string, { sessionId: string; seats: number }>();
  nextBookingNumber = 1;
  behavior: "normal" | "conflict" | "server_error" | "timeout" = "normal";

  addSession(session: ArtisiaSession) {
    this.sessions.set(session.session_id, structuredClone(session));
  }

  async listSessions() {
    return [...this.sessions.values()].map((session) => ({ ...session }));
  }

  async createBooking(input: {
    sessionId: string;
    customer: { name: string; email: string };
    seats: number;
    externalRef: string;
  }) {
    if (this.behavior === "timeout") throw new PartnerError("Artisia timeout", "timeout");
    if (this.behavior === "server_error") throw new PartnerError("Artisia 500", "server");

    const session = this.sessions.get(input.sessionId);
    if (!session) throw new PartnerError("Session not found", "not_found");
    const available = session.capacity - session.booked;
    if (this.behavior === "conflict" || available < input.seats) {
      throw new PartnerError("Not enough seats", "conflict");
    }

    const bookingId = `art_bk_${String(this.nextBookingNumber++).padStart(4, "0")}`;
    this.bookings.set(bookingId, { sessionId: input.sessionId, seats: input.seats });
    session.booked += input.seats;
    session.updated_at = new Date().toISOString();
    return { booking_id: bookingId, seats: input.seats, status: "confirmed" as const };
  }

  async deleteBooking(bookingId: string) {
    const booking = this.bookings.get(bookingId);
    if (!booking) return;
    const session = this.sessions.get(booking.sessionId);
    if (session) session.booked -= booking.seats;
    this.bookings.delete(bookingId);
  }
}
