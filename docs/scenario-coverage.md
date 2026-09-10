# Synchronization scenario coverage

The implementation targets the supplied Artisia contract: non-idempotent booking POSTs, slow responses, empty 500s, fixed-minute rate limits, duplicate/out-of-order/missing webhooks and aggregate session reads. One workshop credential is configured per deployment; multi-workshop routing and multiple partner implementations remain out of scope.

Run `npm test`, `npm run typecheck`, `npm run test:integration`, and `npm run test:webhook`. The integration suites reset the same local Supabase database: run them sequentially. GitHub Actions also checks all three Deno Edge Functions.

| Scenario | Verification | Limit |
| --- | --- | --- |
| Booking accepted or rejected | HTTP and persisted state | Mock API |
| Two Daisy bookings take the last seat | Concurrent HTTP calls and PostgreSQL inventory | No distributed lock at Artisia |
| External sale during Daisy POST | Controlled response barrier plus signed webhook | Overbooking is surfaced, not impossible |
| Webhook echoes a known Daisy booking | One counted sale | Exact partner ID required |
| Webhook precedes POST response | Audit alias linked by exact partner ID | Temporary conservative double hold |
| Cancellation precedes POST response | Cancellation remains authoritative | No refund handling |
| Timeout with an unknown webhook | Identity remains ambiguous; seats held | No identity guessing from totals/customer data |
| Valid 4- and 6-second responses | Both confirm before the 7-second deadline | No load benchmark |
| 500 or timeout | No blind POST retry; uncertain inventory | Manual review may still be required |
| Partner 429 | Key blocked until next full minute; no POST retry | Contract does not prove the sale failed |
| Local rate budget exhausted | No HTTP POST; local hold released | All callers must use the shared limiter |
| Per-key rate limiting | 65 concurrent claims, only 60 granted; independent key; minute rollover | One workshop key configured in this demo |
| Duplicate delivery | Sequential and concurrent copies | No endurance benchmark |
| Out-of-order events | Queued cancellation and creation under an explicit database lock | Equal timestamps use cancellation precedence |
| Webhook contention | Non-2xx within five seconds; persisted event retry | Network latency cannot be universally guaranteed |
| Lost delivery | GET detects aggregate mismatch; sales blocked | Missing individual bookings cannot be reconstructed |
| Persisted unprocessed event | Recovery retries it without another webhook delivery | Bounded batch per pass |
| Matching totals with uncertainty | Reservation stays uncertain and under review | Identity needs independent evidence |
| Outage and recovery | Persisted backoff survives calls; safe GET resumes | Twenty-minute passage simulated through scheduling state |
| GET 429 | Next-minute retry persisted; no immediate retry | Other clients sharing the key may consume capacity |
| Local changes during GET | Snapshot deferred using slot version | Eventual, not distributed, consistency |
| Recovery authorization | Requires a server token | Production secret management is not deployed |

`node scripts/reconcile-artisia.mjs` runs recovery every minute; `--once` supports an external scheduler. Set `ARTISIA_RECOVERY_TOKEN` in the worker and Edge Function. Backoff lives in PostgreSQL, not process memory. A deployment supervisor is still required to keep the worker running.

Changing capacity with PATCH, bulk cancellations, workshop UI, alerts, encrypted per-workshop credentials and cross-partner propagation are documented extensions, not implemented claims. Aggregate equality never confirms uncertain bookings. Existing historical duplicates are not automatically rewritten by the migration.
