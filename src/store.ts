import type { Booking, Slot } from "./types.js";

/** Nonpersistent prototype: each instance owns its state and locks. */
export class Store {
  slots = new Map<string, Slot>();
  bookings = new Map<string, Booking>();
  processedEvents = new Set<string>();
  staleEvents = new Set<string>();
  latestExternalEventAt = new Map<string, string>();
  cancelledExternalBookings = new Map<string, string>();
  conflicts: Array<{ slotId: string; reason: string; eventId?: string }> = [];
  private locks = new Map<string, Promise<void>>();

  /**
   * Queues operations for the same slot; other slots remain independent.
   * This lock coordinates neither multiple processes nor direct Artisia sales.
   * The finally block releases the next operation even on failure; it does not roll back data.
   */
  async withSlotLock<T>(slotId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(slotId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    this.locks.set(slotId, current);
    await previous;
    try { return await operation(); } finally {
      release();
      // Do not delete the promise of an operation already queued behind this one.
      if (this.locks.get(slotId) === current) this.locks.delete(slotId);
    }
  }

  /** Pending and uncertain bookings still hold seats; cancelled bookings do not. */
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
