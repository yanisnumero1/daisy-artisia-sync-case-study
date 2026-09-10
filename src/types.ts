export type BookingSource = "daisy" | "artisia";
/** pending and uncertain consume capacity just as confirmed does. */
export type BookingStatus = "pending" | "confirmed" | "uncertain" | "cancelled";

export interface Slot {
  id: string;
  title: string;
  capacity: number;
  partnerSessionId: string;
  partnerBooked: number;
  syncState: "healthy" | "degraded" | "needs_review";
}

export interface Booking {
  id: string;
  slotId: string;
  source: BookingSource;
  sourceBookingId?: string;
  seats: number;
  customerName: string;
  customerEmail: string;
  status: BookingStatus;
  createdAt: string;
}

export interface ArtisiaSession {
  session_id: string;
  external_ref: string | null;
  title: string;
  starts_at: string;
  duration_minutes: number;
  capacity: number;
  booked: number;
  status: "published" | "cancelled";
  updated_at: string;
}

export interface ArtisiaBookingResponse {
  booking_id: string;
  seats: number;
  status: "confirmed";
}

export interface PartnerWebhook {
  event_id: string;
  type: "booking.created" | "booking.cancelled" | "session.updated";
  occurred_at: string;
  data: {
    booking_id?: string;
    session_id: string;
    seats?: number;
    customer?: { name: string; email: string };
  };
}
