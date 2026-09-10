import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { artisiaFetch, keyFingerprint, LocalRateLimit, rpc } from "../_shared/artisia.ts";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
/**
 * Runs one authenticated recovery pass for this deployment's workshop credential.
 * A persisted one-minute claim prevents overlapping normal passes and survives restarts.
 * Replays a bounded batch of durable events, then compares a GET snapshot with local
 * slot versions. Matching totals never establish an uncertain booking's identity.
 * checked means the pass completed, not that every publication is healthy.
 */
Deno.serve(async (request) => {
  if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);
  // Required even when local testing disables the gateway's JWT verification.
  const token = Deno.env.get("ARTISIA_RECOVERY_TOKEN");
  if (!token || request.headers.get("Authorization") !== `Bearer ${token}`) return json({ error: "Unauthorized" }, 401);
  const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  let keyId: string;
  try { keyId = await keyFingerprint(); } catch { return json({ error: "Partner configuration missing" }, 500); }
  try {
    if (!await rpc(db, "claim_artisia_recovery", { p_key_id: keyId })) return json({ status: "deferred" });
    // Retry durable events independently of partner delivery. A bad event must not
    // starve the rest: failed events are moved to the back by processed_at.
    const { data: pending, error: pendingError } = await db.from("webhook_events").select("event_id")
      .in("status", ["received", "failed"]).order("processed_at", { nullsFirst: true }).limit(10);
    if (pendingError) throw pendingError;
    for (const event of pending ?? []) {
      try { await rpc(db, "process_artisia_webhook_event", { p_event_id: event.event_id }); }
      catch { /* Leave the persisted event for the next recovery pass. */ }
      const { error } = await db.from("webhook_events").update({ processed_at: new Date().toISOString() }).eq("event_id", event.event_id);
      if (error) throw error;
    }
    const { data: publications, error } = await db.from("slot_partners")
      .select("slot_id,partner_session_id,slots(sync_version)").eq("partner", "artisia");
    if (error) throw error;
    let response: Response;
    try { response = await artisiaFetch(db, keyId, "/sessions"); }
    catch (error) {
      if (error instanceof LocalRateLimit) {
        await rpc(db, "finish_artisia_recovery", { p_key_id: keyId, p_error: "rate_limit", p_rate_limited: true });
        return json({ status: "deferred" });
      }
      throw error;
    }
    if (!response.ok) {
      await rpc(db, "finish_artisia_recovery", { p_key_id: keyId, p_error: `HTTP ${response.status}`, p_rate_limited: response.status === 429 });
      return json({ status: "retry_scheduled" }, 202);
    }
    const body = await response.json();
    if (!Array.isArray(body.sessions)) throw new Error("Invalid sessions response");
    const ids = new Set<string>();
    for (const session of body.sessions) {
      if (typeof session.session_id !== "string" || ids.has(session.session_id) ||
        !Number.isSafeInteger(session.booked) || session.booked < 0 ||
        !Number.isSafeInteger(session.capacity) || session.capacity < 0 ||
        !["published", "cancelled"].includes(session.status) || !Number.isFinite(Date.parse(session.updated_at))) throw new Error("Invalid session");
      ids.add(session.session_id);
    }
    const results = [];
    for (const publication of publications ?? []) {
      const session = body.sessions.find((entry: { session_id: string }) => entry.session_id === publication.partner_session_id);
      if (!session) {
        const { error } = await db.from("slot_partners").update({ sync_status: "needs_review" }).eq("slot_id", publication.slot_id).eq("partner", "artisia");
        if (error) throw error;
        results.push("missing");
        continue;
      }
      // Supabase's relation is a single slot for this foreign key.
      const slot = publication.slots as unknown as { sync_version: number };
      results.push(await rpc(db, "reconcile_artisia_session", { p_session: session, p_version: slot.sync_version }));
    }
    await rpc(db, "finish_artisia_recovery", { p_key_id: keyId });
    return json({ status: "checked", results });
  } catch {
    try { await rpc(db, "finish_artisia_recovery", { p_key_id: keyId, p_error: "Recovery unavailable" }); } catch { /* The claim lease expires even after a database outage. */ }
    return json({ status: "retry_scheduled" }, 202);
  }
});
