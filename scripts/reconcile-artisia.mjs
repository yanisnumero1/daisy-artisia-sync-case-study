// Run continuously under a process supervisor, or invoke --once from a scheduler.
// Backoff and rate limits live in PostgreSQL and survive process restarts.
const base = process.env.SUPABASE_URL ?? "http://127.0.0.1:54321";
const token = process.env.ARTISIA_RECOVERY_TOKEN;
if (!token) throw new Error("ARTISIA_RECOVERY_TOKEN is required");
async function run() {
  const response = await fetch(`${base}/functions/v1/reconcile-artisia`, {
    method: "POST", headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(45_000),
  });
  if (!response.ok) throw new Error(`Recovery returned HTTP ${response.status}`);
  console.log(JSON.stringify(await response.json()));
}
do {
  try { await run(); } catch (error) {
    console.error(error.message);
    if (process.argv.includes("--once")) process.exitCode = 1;
  }
  if (process.argv.includes("--once")) break;
  await new Promise((resolve) => setTimeout(resolve, 60_000));
} while (true);
