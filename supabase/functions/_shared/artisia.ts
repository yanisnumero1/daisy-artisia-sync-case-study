import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

export type Database = ReturnType<typeof createClient>;
export async function keyFingerprint() {
  const key = Deno.env.get("ARTISIA_API_KEY");
  if (!key) throw new Error("Artisia key is not configured");
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(key));
  return Array.from(new Uint8Array(bytes), (value) => value.toString(16).padStart(2, "0")).join("");
}

export async function rpc(db: Database, name: string, args: Record<string, unknown>) {
  const { data, error } = await db.rpc(name, args);
  if (error) throw new Error(`Database operation failed: ${name}`);
  return data;
}

export class LocalRateLimit extends Error {}

export async function artisiaFetch(db: Database, keyId: string, path: string, options: RequestInit = {}) {
  if (!await rpc(db, "take_artisia_request", { p_key_id: keyId })) {
    throw new LocalRateLimit("Artisia request budget exhausted");
  }
  // No automatic POST retries. GET retries are scheduled persistently by recovery.
  const response = await fetch(`${Deno.env.get("ARTISIA_BASE_URL")}${path}`, {
    ...options,
    headers: { Authorization: `Bearer ${Deno.env.get("ARTISIA_API_KEY")}`, "Content-Type": "application/json" },
    signal: AbortSignal.timeout(7_000),
  });
  if (response.status === 429) await rpc(db, "block_artisia_key", { p_key_id: keyId });
  return response;
}
