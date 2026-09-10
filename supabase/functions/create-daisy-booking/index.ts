import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { artisiaFetch, keyFingerprint, LocalRateLimit, rpc, type Database } from "../_shared/artisia.ts";

const headers = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type", "Content-Type": "application/json" };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers });
const uncertain = () => json({ status: "uncertain", message: "Veuillez patienter. Nous vérifions votre demande avant de la confirmer." }, 202);

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers });
  if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);
  const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  let input;
  try {
    input = await request.json();
    if (!input || typeof input.slotId !== "string" || !input.slotId ||
      typeof input.customerName !== "string" || !input.customerName.trim() ||
      typeof input.customerEmail !== "string" || !input.customerEmail.trim() ||
      !Number.isSafeInteger(input.seats) || input.seats <= 0) return json({ error: "Invalid booking request" }, 400);
  } catch { return json({ error: "Invalid JSON body" }, 400); }

  const { data: booking, error } = await db.rpc("reserve_daisy_seats", {
    p_slot_id: input.slotId, p_seats: input.seats,
    p_customer_name: input.customerName, p_customer_email: input.customerEmail,
  }).single<{ id: string }>();
  if (error) {
    if (error.message.includes("Not enough seats")) return json({ error: "Not enough seats" }, 409);
    if (error.message.includes("Partner synchronization unavailable")) return json({ status: "unavailable", message: "La disponibilité de ce créneau est en cours de vérification. Veuillez réessayer plus tard." }, 503);
    return json({ error: "Unable to reserve slot" }, 400);
  }

  try {
    const { data: publication, error: publicationError } = await db.from("slot_partners")
      .select("partner_session_id,status,sync_status").eq("slot_id", input.slotId).eq("partner", "artisia").single();
    if (publicationError || !publication || publication.status !== "published" || publication.sync_status !== "healthy") {
      await markUncertain(db, booking.id, input.slotId);
      return uncertain();
    }
    let response: Response;
    try {
      response = await artisiaFetch(db, await keyFingerprint(), `/sessions/${publication.partner_session_id}/bookings`, {
        method: "POST", body: JSON.stringify({ customer: { name: input.customerName, email: input.customerEmail }, seats: input.seats, external_ref: booking.id }),
      });
    } catch (error) {
      if (error instanceof LocalRateLimit) {
        // No HTTP request was sent: releasing this local hold is unambiguous.
        await markBooking(db, booking.id, "cancelled");
        return json({ status: "unavailable", message: "Le partenaire reçoit trop de demandes. Veuillez réessayer dans une minute." }, 503);
      }
      await markUncertain(db, booking.id, input.slotId);
      return uncertain();
    }
    if (response.status === 201) {
      let result;
      try {
        result = await response.json();
        if (typeof result.booking_id !== "string" || !result.booking_id || result.seats !== input.seats || result.status !== "confirmed") throw new Error("Invalid partner response");
      } catch {
        await markUncertain(db, booking.id, input.slotId);
        return uncertain();
      }
      // The slot lock links an early webhook by exact partner ID and preserves cancellation.
      const status = await rpc(db, "finish_artisia_booking", { p_booking_id: booking.id, p_partner_booking_id: result.booking_id });
      return json({ status, bookingId: booking.id }, status === "cancelled" ? 409 : 200);
    }
    if (response.status === 409) {
      await markBooking(db, booking.id, "cancelled");
      return json({ status: "cancelled", message: "Malheureusement, ce créneau vient d’être réservé par un autre client." }, 409);
    }
    // 429 and unexpected failures are not documented as proof that no sale occurred.
    await markUncertain(db, booking.id, input.slotId);
    return uncertain();
  } catch {
    // A failure saving a known partner result must still prevent further sales.
    try { await markUncertain(db, booking.id, input.slotId); } catch { /* Return a retryable server error, never a false confirmation. */ }
    return json({ error: "Booking state could not be saved" }, 500);
  }
});

async function markBooking(db: Database, id: string, status: string) {
  await rpc(db, "set_daisy_booking_state", { p_booking_id: id, p_status: status });
}
async function markUncertain(db: Database, id: string, _slotId: string) {
  await markBooking(db, id, "uncertain");
}
