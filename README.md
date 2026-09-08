# Daisy — Artisia availability synchronization

Take-home case study for **Sujet A : synchroniser sans jamais surréserver**.

The implementation is deliberately focused on the domain service rather than a full Next.js screen. The important behavior is executable and tested; the partner is represented by `MockArtisia`.

## Run

```bash
npm install
npm test
npm run typecheck
```

## Decisions

### Source of truth and data model

The real implementation would use PostgreSQL with the following tables:

- `slots`: Daisy slot, capacity, Artisia session id, partner sync state;
- `bookings`: source (`daisy` or `artisia`), seats, source booking id, status;
- `webhook_events`: unique `event_id`, signature result, received/processed timestamps;
- `sync_conflicts`: ambiguous requests and external overbooking cases requiring attention.

The in-memory `Store` mirrors those concepts. A PostgreSQL implementation would protect a slot with a transaction and `SELECT ... FOR UPDATE`, plus unique constraints on `(partner_id, source_booking_id)` and `webhook_events.event_id`.

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

- local-to-partner booking flow;
- slot-level serialization;
- partner conflicts;
- uncertain timeout/500 state;
- signed, duplicate-safe webhooks;
- external booking conflicts;
- aggregate reconciliation;
- tests for these behaviors.

Not implemented in this focused exercise:

- a Next.js UI;
- persistent PostgreSQL adapter;
- a real queue/worker;
- multiple partners and per-partner credentials;
- automated resolution of aggregate discrepancies, which Artisia's API does not make safely possible.

These would be the next increments after validating the domain behavior.

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
