import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const jsonHeaders = { "Content-Type": "application/json" };

function response(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: jsonHeaders });
}

async function isValidSignature(rawBody: string, received: string | null, secret: string) {
  if (!received?.startsWith("sha256=")) return false;
  const expectedBytes = await crypto.subtle.sign(
    "HMAC",
    await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    ),
    new TextEncoder().encode(rawBody),
  );
  const expected = `sha256=${Array.from(new Uint8Array(expectedBytes))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")}`;
  if (expected.length !== received.length) return false;

  // Do not exit early while comparing the signature.
  let difference = 0;
  for (let index = 0; index < expected.length; index += 1) {
    difference |= expected.charCodeAt(index) ^ received.charCodeAt(index);
  }
  return difference === 0;
}

Deno.serve(async (request) => {
  if (request.method !== "POST") {
    return response({ error: "Method not allowed" }, 405);
  }

  const webhookSecret = Deno.env.get("ARTISIA_WEBHOOK_SECRET");

  if (!webhookSecret) {
    //Without this secret, Daisy cannot verify that the webhook really comes from Artisia.
    return response({ error: "Webhook secret is not configured" }, 500);
  }

  const rawBody = await request.text();
  const valid = await isValidSignature(
    rawBody,
    request.headers.get("X-Artisia-Signature"),
    webhookSecret,
  );
  if (!valid) return response({ error: "Invalid signature" }, 401);

  let event: { event_id?: string; type?: string; occurred_at?: string; data?: unknown };
  try {
    event = JSON.parse(rawBody);
  } catch {
    return response({ error: "Invalid JSON" }, 400);
  }
  const supportedTypes = new Set(["booking.created", "booking.cancelled", "session.updated"]);
  if (!event.event_id || !event.type || !supportedTypes.has(event.type) || !event.occurred_at || !event.data) {
    return response({ error: "Invalid Artisia event" }, 400);
  }

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  const { error: insertError } = await supabase.from("webhook_events").insert({
    partner: "artisia",
    event_id: event.event_id,
    event_type: event.type,
    payload: event,
    occurred_at: event.occurred_at,
  });

  if (insertError && insertError.code !== "23505") {
    // A non-2xx response asks Artisia to retry. The event is not acknowledged
    // until it is durably stored.
    return response({ error: "Could not persist event" }, 500);
  }

  // Duplicate event_id: it has already been stored and is safe to acknowledge.
  // If its previous processing failed, retry the database processor instead.
  const { data: storedEvent } = await supabase
    .from("webhook_events")
    .select("status")
    .eq("partner", "artisia")
    .eq("event_id", event.event_id)
    .single();

  if (storedEvent?.status === "processed" || storedEvent?.status === "ignored" || storedEvent?.status === "stale") {
    return response({ status: "duplicate" });
  }

  const { data: result, error: processError } = await supabase
    .rpc("process_artisia_webhook_event", { p_event_id: event.event_id });
  if (processError) return response({ error: "Could not process event" }, 500);

  return response({ status: result });
});
