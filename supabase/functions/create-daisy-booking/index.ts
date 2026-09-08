import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

type BookingRequest = {
  slotId: string;
  seats: number;
  customerName: string;
  customerEmail: string;
};

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { ...corsHeaders, "Content-Type": "application/json" },
});

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  let input: BookingRequest;
  try {
    input = await request.json();
    if (!input.slotId || !input.customerName || !input.customerEmail || input.seats <= 0) {
      return json({ error: "Invalid booking request" }, 400);
    }
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  // Daisy reserves its own inventory first. The SQL function locks the slot,
  // so two simultaneous Daisy requests cannot both take the last seat.
  const { data: booking, error: reserveError } = await supabase
    .rpc("reserve_daisy_seats", {
      p_slot_id: input.slotId,
      p_seats: input.seats,
      p_customer_name: input.customerName,
      p_customer_email: input.customerEmail,
    })
    .single();

 if (reserveError) {
  const isCapacityConflict = reserveError.message.includes("Not enough seats");

  if (isCapacityConflict) {
    return json({ error: "Not enough seats" }, 409);
  }

  const isPartnerUnavailable = reserveError.message.includes(
    "Partner synchronization unavailable",
  );

  if (isPartnerUnavailable) {
    // A degraded partner state pauses new sales without creating a booking.
    return json(
      {
        status: "unavailable",
        message:
          "La disponibilité de ce créneau est en cours de vérification. Veuillez réessayer plus tard.",
      },
      503,
    );
  }

  return json({ error: "Unable to reserve slot" }, 400);
}

  const { data: publication, error: publicationError } = await supabase
    .from("slot_partners")
    .select("partner_session_id, status, sync_status")
    .eq("slot_id", input.slotId)
    .eq("partner", "artisia")
    .single();

  if (publicationError || !publication || publication.status !== "published" || publication.sync_status !== "healthy") {
    await markBooking(supabase, booking.id, "uncertain");
    return json({
      status: "uncertain",
      message: "Veuillez patienter. Nous vérifions votre demande avant de la confirmer.",
    }, 202);
  }

  let response: Response;
  try {
    response = await fetch(`${Deno.env.get("ARTISIA_BASE_URL")}/sessions/${publication.partner_session_id}/bookings`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${Deno.env.get("ARTISIA_API_KEY")}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        customer: { name: input.customerName, email: input.customerEmail },
        seats: input.seats,
        external_ref: booking.id,
      }),
      // A slow Artisia response must not leave a serverless invocation waiting forever.
      signal: AbortSignal.timeout(7_000),
    });
  } catch {
    await markUncertain(supabase, booking.id, input.slotId);
    return json({
      status: "uncertain",
      message: "Veuillez patienter. Nous vérifions votre demande avant de la confirmer.",
    }, 202);
  }

  if (response.status === 201) {
    const result = await response.json();
    const { error } = await supabase
      .from("bookings")
      .update({ status: "confirmed", source_booking_id: result.booking_id })
      .eq("id", booking.id)
      .eq("status", "pending");
    if (error) return json({ error: "Booking confirmation could not be saved" }, 500);
    return json({ status: "confirmed", bookingId: booking.id });
  }

  if (response.status === 409) {
    // Artisia explicitly says that the seats are no longer available. This is
    // the only failure for which it is safe to release the local pending hold.
    await markBooking(supabase, booking.id, "cancelled");
    return json({
      status: "cancelled",
      message: "Malheureusement, ce créneau vient d’être réservé par un autre client. Souhaitez-vous réserver un autre jour ?",
    }, 409);
  }

  // A 500, 429 or unexpected response is ambiguous: the POST may have reached
  // Artisia. Never retry it blindly; keep the seat blocked and reconcile later.
  await markUncertain(supabase, booking.id, input.slotId);
  return json({
    status: "uncertain",
    message: "Veuillez patienter. Nous vérifions votre demande avant de la confirmer.",
  }, 202);
});

async function markBooking(client: ReturnType<typeof createClient>, bookingId: string, status: string) {
  await client.from("bookings").update({ status }).eq("id", bookingId);
}

async function markUncertain(client: ReturnType<typeof createClient>, bookingId: string, slotId: string) {
  await markBooking(client, bookingId, "uncertain");
  await client
    .from("slot_partners")
    .update({ sync_status: "needs_review" })
    .eq("slot_id", slotId)
    .eq("partner", "artisia");
}
