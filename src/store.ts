import type { Booking, Slot } from "./types.js";

export class Store {
  slots = new Map<string, Slot>();
  bookings = new Map<string, Booking>();
  processedEvents = new Set<string>();
  staleEvents = new Set<string>();
  latestExternalEventAt = new Map<string, string>();
  cancelledExternalBookings = new Map<string, string>();
  conflicts: Array<{ slotId: string; reason: string; eventId?: string }> = [];
  private locks = new Map<string, Promise<void>>();

  async withSlotLock<T>(slotId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(slotId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    this.locks.set(slotId, current);
    await previous;
    try { return await operation(); } finally {
      release();
      if (this.locks.get(slotId) === current) this.locks.delete(slotId);
    }
  }

  committedSeats(slotId: string) {
    return [...this.bookings.values()]
      .filter((booking) => booking.slotId === slotId && ["pending", "confirmed", "uncertain"].includes(booking.status))
      .reduce((total, booking) => total + booking.seats, 0);
  }

  availableSeats(slotId: string) {
    const slot = this.slots.get(slotId);
    if (!slot) throw new Error(`Unknown slot ${slotId}`);
    return slot.capacity - this.committedSeats(slotId);
  }
}
