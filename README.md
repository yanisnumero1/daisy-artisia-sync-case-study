# Daisy — Artisia availability synchronization

Take-home case study for **Sujet A: synchroniser sans jamais surréserver**.

The project contains two complementary implementations:

- a small in-memory domain model for fast unit tests;
- a persistent Supabase implementation with PostgreSQL migrations, Edge Functions and HTTP integration tests.

Artisia is represented by a configurable local HTTP mock that reproduces successful responses, conflicts, server errors and timeouts.

## Run

Prerequisites: Node.js, Docker Desktop and the Supabase CLI.

```bash
npm install
cp supabase/.env.example supabase/.env.local
supabase start
npm test
npm run test:integration
npm run typecheck
```

`npm test` runs the fast domain tests. `npm run test:integration` resets the local Supabase database, starts the Artisia mock and Edge Functions, then verifies the complete HTTP and PostgreSQL flow.

## Decisions

### Source of truth and data model

TPostgreSQL is the persistent source of truth. The Supabase migrations create:

- `slots`: Daisy slots and their local capacity;
- `slot_partners`: external publications and synchronization state;
- `bookings`: Daisy and Artisia reservations with their current status;
- `webhook_events`: signed partner events protected by a unique event identifier;
- `sync_conflicts`: ambiguous or external overbooking cases requiring artisan review.

The `reserve_daisy_seats` PostgreSQL function locks the slot with `SELECT ... FOR UPDATE`, checks partner health and remaining capacity, then creates the local hold in the same transaction.

The in-memory `Store` mirrors the same concepts and remains useful for fast domain tests. The Supabase implementation validates the behavior with real transactions, constraints, Edge Functions and HTTP calls.

### Two people take the last seat

Two Daisy requests for the same slot are serialized by the slot lock. The first request creates a local `pending` booking and calls Artisia. The second request sees no local availability and is rejected.

The harder case is one Daisy request and one direct Artisia request at exactly the same time. There is no distributed transaction and Artisia provides neither a reservation/hold endpoint nor optimistic concurrency. Therefore no client-side implementation can mathematically guarantee zero overbooking against direct partner sales.

The chosen policy is conservative:

1. reserve locally while the partner call is in progress;
2. confirm only after Artisia returns `201`;
3. on a definitive `409`, remove the local pending booking and tell the customer the slot was just taken;
4. on an ambiguous timeout/500, do **not** retry the non-idempotent `POST`; keep the seat held as `uncertain`, mark the slot `needs_review`, and reconcile before selling again;
5. if an external webhook would exceed local capacity, accept the webhook quickly, record a conflict, and surface it to the artisan for resolution.

This favors **not overbooking** over never blocking a sale. The artisan sees a degraded synchronization state and a temporary pause on new sales rather than silently accepting a reservation that may need to be refunded.

### Artisia unavailable for 20 minutes

The back-office displays the slot as degraded: existing confirmed reservations remain visible, but new reservations for a partner-connected slot are paused. This is intentionally conservative because Artisia has no reliable reconciliation cursor and the partner can still receive direct sales.

When Artisia returns, a worker calls `GET /sessions`, compares the aggregate `booked` count with known Daisy bookings, resolves any `uncertain` bookings when the counts match, and creates a `sync_conflict` when they do not. Since Artisia exposes no booking-level reconciliation, an unexplained difference cannot be auto-resolved safely; the artisan must review it.

In production I would run this worker with retries/backoff, a per-partner rate limiter below 60 requests per minute, and an alert when a slot remains degraded or needs review.

### Duplicate and out-of-order webhooks

The webhook handler verifies the HMAC over the raw body, then inserts `event_id` into a table with a unique constraint. A duplicate becomes a no-op. A unique constraint on `(partner_id, source_booking_id)` is a second protection against duplicate business effects.

The handler returns a `2xx` after durably recording the event, then processes it quickly. For `occurred_at` ordering, production code would keep the latest applied timestamp per external booking/session and ignore stale state transitions. A cancellation received before its creation would be stored as a tombstone and applied when the creation arrives.

The cost is one small event row per webhook plus indexes and periodic retention/archiving. That is a good trade-off for avoiding duplicate bookings.

### Why I do not retry `POST /bookings` blindly

The endpoint is explicitly non-idempotent. A timeout means the request may have succeeded remotely. Retrying can create two bookings. A 409 is safe to interpret as a definitive rejection; a timeout or 500 is not. The implementation therefore moves the Daisy booking to `uncertain` and reconciles using the only available partner signal, the aggregate session count.

## Scope and deliberate omissions

Implemented:

- persistent PostgreSQL schema and constraints;
- atomic local booking holds with slot-level locking;
- Daisy-to-Artisia booking Edge Function;
- signed and duplicate-safe Artisia webhook Edge Function;
- partner conflict and uncertain booking states;
- stale webhook protection;
- local HTTP mock for `201`, `409`, `500` and timeout scenarios;
- deterministic local seed data;
- nine fast domain tests;
- five full Supabase integration tests.

Not implemented in this focused exercise:

- a Next.js user interface;
- a production queue or scheduled reconciliation worker;
- encrypted per-workshop partner credential storage;
- customer email notifications;
- an artisan interface for reviewing and resolving conflicts;
- automatic resolution when Artisia only exposes an aggregate booking count.

These are deliberate product increments rather than hidden assumptions. The current implementation focuses on the synchronization rules and the failure modes that can lead to overbooking.

## Automated verification

```bash
npm test
npm run test:integration
npm run typecheck

## Production evolution

I would replace the in-memory lock with a PostgreSQL transaction, use an outbox for outbound synchronization, encrypt partner API keys, add structured audit logs and metrics, and expose the artisan-facing states `healthy`, `degraded`, and `needs_review`. Metrics would include booking conflict rate, uncertain booking count/age, reconciliation drift, webhook duplicate rate, and partner latency/error rate.

## Journal de bord

Planned work: first read the partner contract, then model the failure modes, implement the smallest state machine, add tests, and document trade-offs. The main blocking point is structural: Artisia's non-idempotent booking endpoint and aggregate-only reconciliation prevent a perfect exactly-once guarantee. I chose to make that limitation explicit and protect the artisan with a conservative pause rather than hide it behind retries.

## Tri de tickets — appétence personnelle

1. **5** — investigate the 60% widget abandonment with product analytics and a reproducible journey;
2. **1** — repair the partner date contract and add contract tests;
3. **7** — reconcile accounting exports with bank statements and trace the source of truth;
4. **2** — profile and improve the slow calendar;
5. **8** — establish a design system and reusable primitives;
6. **6** — design a clean public integration contract;
7. **4** — add the course-type filter;
8. **3** — add in-person TPE payments to the booking flow.

This says I am most attracted to problems combining user behavior, product diagnosis, data consistency, and real integrations. I still value product polish and small features, but I prefer first understanding the underlying failure mode and its business impact.

## First two weeks at Daisy

**Days 1–2:** install the project, run the tests, understand deployment and monitoring, and map the main domain entities and user journeys.

**Days 3–4:** shadow an artisan or support session, reproduce one real workflow locally, and read the most sensitive integration and billing code with a developer.

**Days 5–7:** take a small production-relevant ticket, deliver it with tests and a review, and document anything surprising in the codebase.

**Days 8–10:** investigate one reliability or performance signal, propose a small improvement with measurable acceptance criteria, and align with the team on priorities for the following month.

I would avoid a large refactor during onboarding: first learn the product's invariants and the team's operating habits.

## Question I would ask before starting

**Question:** Is the intended product invariant that Daisy must never accept a booking unless every connected channel has confirmed it, or can Daisy accept while synchronization is eventually consistent?

**Assumption used here:** the business prioritizes avoiding overbooking because it creates refunds and customer damage, so a connected slot is paused when the partner state is uncertain. I would validate this with the team before implementing the production policy.
