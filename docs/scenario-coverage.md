# Synchronization scenario coverage

This matrix describes the scenarios documented in this repository. The original exercise specification is not included, so this is not a claim of complete compliance with an external specification.

Run the suites sequentially: both integration commands reset the same local Supabase database.

```bash
npm test
npm run typecheck
npm run test:integration
npm run test:webhook
```

The GitHub Actions workflow runs these checks with PostgreSQL and the local Artisia HTTP mock. Type checking covers the Node prototype, not the Deno Edge Functions.

| Scenario | Verification | Remaining limitation |
| --- | --- | --- |
| Artisia accepts a booking | Booking integration: HTTP result and persisted confirmation | Mock partner, not a live Artisia account |
| Artisia refuses with 409 | Booking integration: cancellation and released capacity | None within this simulated flow |
| Artisia returns 500 | Booking integration: uncertain booking and review state | Automatic recovery is not implemented |
| Partner times out | Booking integration: held seats and one outgoing POST | A short timeout simulates the failure; no 20-minute outage recovery test |
| Partner requires review | Booking integration: new sales blocked before a partner call | No workshop review interface |
| Two Daisy customers request the last seat | Concurrent HTTP requests through the Edge Function and PostgreSQL; one booking and one partner call | Does not exercise multiple remote platforms |
| External sale arrives during a Daisy reservation | Mock response held behind an explicit barrier; signed webhook arrives while the local hold is pending | Tests conflict detection and sales suspension, not an impossible cross-platform lock |
| Valid or invalid webhook signature | Webhook integration: response and stored state | Mock shared secret |
| Duplicate webhook deliveries | Sequential and three concurrent copies; exactly one event and booking | No load or endurance benchmark |
| Same external booking, distinct event IDs | Concurrent deliveries; one external booking | Does not cover an echo of a Daisy-origin booking |
| Old creation after cancellation | Tests both an existing booking and cancellation arriving before any creation | Concurrent ordering of distinct timestamps still needs a dedicated test |
| Session update/cancellation | Stored partner capacity, booked count, status, and review state | No automatic reconciliation of capacity discrepancies |
| Reconciliation | Unit test for matching aggregate totals | No persistent worker; aggregate equality does not identify individual bookings |

The in-flight race test deliberately records two accepted sales for one seat and requires a conflict plus `needs_review`. Its success proves that the conflict is surfaced and further sales stop; it does not prove that cross-platform overbooking is prevented.

The HTTP mock has a test-only `held` scenario and `POST /__release` endpoint. Together they control when a partner response is returned, so the overlap does not depend on an arbitrary sleep. Other scenarios remain `success`, `conflict`, `error`, and `slow`. Mock booking identifiers are unique within each scenario run.
