# Availability synchronization between Daisy and Artisia

Technical case study for **Topic A: synchronize without overbooking**.

This project contains two complementary implementations:

- an in-memory business model for fast unit tests;
- a persistent implementation using Supabase, PostgreSQL migrations, Edge Functions, and HTTP integration tests.

Artisia is represented by a configurable local mock server that simulates successful bookings, booking conflicts, server errors, and timeouts.

## Getting started

Prerequisites: Node.js, Docker Desktop, and the Supabase CLI.

```bash
npm install
cp supabase/.env.example supabase/.env.local
supabase start
npm test
npm run test:integration
npm run test:webhook
npm run typecheck
```

`npm test` runs the fast business logic tests. These require neither Docker nor Supabase.

`npm run test:integration` resets the local Supabase database, starts the Artisia mock and the booking Edge Function, and checks the booking flow from HTTP requests to PostgreSQL.

`npm run test:webhook` checks signatures, duplicate delivery, event ordering, and external conflicts.

Both integration suites reset the local database, deleting its test data. Run them sequentially because they share the same database.

`npm run typecheck` checks `src/` and the TypeScript tests without generating files. It does not check the Deno Edge Functions in `supabase/functions/`.

## Using the APIs locally

After installing dependencies and starting Supabase as above, start the mock in one terminal:

```bash
node scripts/artisia-mock.mjs
```

In a second terminal, serve both functions with the local configuration:

```bash
supabase functions serve --no-verify-jwt --env-file supabase/.env.local
```

This demonstration mode disables JWT verification, as the booking tests do. The webhook still verifies its HMAC signature. Stop both processes before running integration tests, which start their own services.

### Configuration

| Variable | Use in this demonstration |
| --- | --- |
| `ARTISIA_BASE_URL` | `http://host.docker.internal:4010/v1`, allowing Docker to reach the mock |
| `ARTISIA_API_KEY` | `test-api-key`, the value expected by the local mock |
| `ARTISIA_WEBHOOK_SECRET` | `test-secret`, the local HMAC secret |
| `SUPABASE_URL` | URL supplied to the local Edge Functions runtime |
| `SUPABASE_SERVICE_ROLE_KEY` | Server key supplied to the local runtime, used by the functions to access PostgreSQL |

The three Artisia variables are defined in `supabase/.env.example`; copy this file to `supabase/.env.local`. These demonstration values belong to the mock, not a real Artisia account.

### Creating a Daisy booking

`POST /functions/v1/create-daisy-booking` expects a JSON object containing `slotId` (an existing slot UUID), `seats` (a positive integer), `customerName`, and `customerEmail` (nonempty strings). Current validation is minimal and does not check email address formatting.

The seeded slot has eight seats and is linked to session `art_ses_8812`:

```bash
curl -i http://127.0.0.1:54321/functions/v1/create-daisy-booking \
  -H 'Content-Type: application/json' \
  --data '{"slotId":"11111111-1111-1111-1111-111111111111","seats":1,"customerName":"Camille Example","customerEmail":"camille@example.com"}'
```

| Daisy HTTP code | Response / meaning |
| --- | --- |
| `200` | `{"status":"confirmed","bookingId":"<Daisy UUID>"}` after Artisia returns `201` |
| `202` | `{"status":"uncertain","message":"…"}`: seats remain held pending verification |
| `409` | `{"error":"Not enough seats"}` for insufficient local capacity, or `{"status":"cancelled","message":"…"}` after an Artisia rejection |
| `503` | `{"status":"unavailable","message":"…"}` when the partner publication prevents a new sale |
| `400` | `{"error":"…"}`: invalid body or failed local reservation |
| `405` | Unsupported method (`OPTIONS` is accepted for CORS) |
| `500` | Failed to save confirmation after the partner accepted the booking |

A `202` does not guarantee a later email: the worker and confirmation delivery are not implemented. The flow exposes no client idempotency key; repeating the request can create another booking.

### Sending a signed webhook

`POST /functions/v1/artisia-webhook` expects `event_id`, `type`, `occurred_at`, and `data`. Supported types are `booking.created`, `booking.cancelled`, and `session.updated`. Supply `data.session_id` and, for booking events, `data.booking_id`. For a creation, also supply `data.seats` (a positive integer); `data.customer` is optional. Session updates use `capacity`, `booked`, and `status` within `data`.

The `X-Artisia-Signature` header contains `sha256=` followed by the lowercase hexadecimal HMAC-SHA256 of the raw body. The transmitted body must exactly match the signed body, including whitespace and line breaks. Run this example in a third terminal using the secret from the example environment file:

```bash
node --input-type=module <<'JS'
import { createHmac } from 'node:crypto';
const body = JSON.stringify({
  event_id: 'evt_demo_001',
  type: 'booking.created',
  occurred_at: '2026-09-10T12:00:00Z',
  data: { session_id: 'art_ses_8812', booking_id: 'art_demo_001', seats: 1 }
});
const signature = 'sha256=' + createHmac('sha256', 'test-secret').update(body).digest('hex');
const result = await fetch('http://127.0.0.1:54321/functions/v1/artisia-webhook', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'X-Artisia-Signature': signature },
  body
});
console.log(result.status, await result.json());
JS
```

The first run against a freshly initialized database returns `200` with `{"status":"processed"}`; repeating the event returns `{"status":"duplicate"}`. Other possible business results under HTTP `200` are `stale`, `ignored`, and `failed`. In particular, an unknown session currently produces `failed` with HTTP `200`: the HTTP code alone does not prove that the event was applied. An external overbooking remains `processed`, with a conflict recorded in the database.

A missing or invalid signature returns `401`; invalid JSON or an invalid event envelope returns `400`; a method other than POST returns `405`. A missing secret, persistence failure, or SQL execution error returns `500`. Envelope validation does not fully validate `data`.

## Technical decisions

### Source of truth and data model

PostgreSQL is the persistent source of truth. Supabase migrations create these tables:

- `slots`: Daisy slots and their local capacity;
- `slot_partners`: partner publications and their synchronization state;
- `bookings`: Daisy and Artisia bookings with their current status;
- `webhook_events`: signed partner events protected by a unique identifier;
- `sync_conflicts`: external overbooking conflicts requiring review by the workshop owner.

The PostgreSQL function `reserve_daisy_seats` locks the slot with `SELECT ... FOR UPDATE`. It checks partner synchronization and remaining capacity, then creates the local hold in the same transaction.

This lock prevents two simultaneous Daisy reservations from consuming the same seat.

The in-memory `Store` illustrates the main business rules and supports fast unit tests. It does not exactly reproduce the Supabase implementation. The persistent flows described below correspond to the migrations and Edge Functions.

### Code map and implementation differences

| Location | Role |
| --- | --- |
| `src/sync.ts` | Business prototype: bookings, webhooks, and manual reconciliation |
| `src/store.ts` | In-memory state and a queue per slot |
| `src/partner.ts` | Partner contract and in-memory mock |
| `src/types.ts` | Prototype types |
| `supabase/migrations/` | Tables, constraints, and transactional operations; `0004` replaces the reservation function from `0002` |
| `supabase/functions/` | HTTP entry points and partner calls |
| `scripts/artisia-mock.mjs` | HTTP mock used by integration tests |
| `tests/` | Tests for the prototype and persistent flows |

| Situation | In-memory prototype | Supabase implementation |
| --- | --- | --- |
| Artisia rejects with `409` | Deletes the booking and throws an error | Keeps the booking as `cancelled`, returns `409` |
| Ambiguous partner result | Keeps `uncertain` and throws an error | Keeps `uncertain`, returns `202` |
| External booking exceeds capacity | Records a conflict without inserting the external booking | Inserts the `confirmed` booking, then records the conflict |
| Locking | Limited to one `Store` instance; held during the partner call | PostgreSQL lock during the local hold transaction; HTTP call happens afterward |
| `session.updated` | Records the event without updating the publication | Updates the publication fields supplied in the webhook |
| Reconciliation | Manually callable `reconcile()` method | No reconciliation worker or endpoint |

Prototype tests alone do not validate PostgreSQL guarantees: both integration suites must also run.

### Two customers book the last seat simultaneously

When both reservations originate in Daisy, PostgreSQL processes them sequentially using the slot lock.

The first request holds the last seat with a `pending` booking. The second waits for that transaction to finish, sees no remaining capacity, and is rejected before calling Artisia.

The scenario is more complex when one customer books in Daisy while another books directly through Artisia:

1. Daisy checks local availability and holds the last seat as `pending`.
2. At the same time, Artisia sells that seat through its own platform.
3. Both operations can succeed because the platforms share neither a distributed transaction nor a common lock.
4. Daisy then receives the webhook confirming the direct Artisia booking.
5. Daisy stores that external booking as `confirmed`, reflecting a sale already accepted by the partner.
6. The system detects that total booked seats exceed capacity.
7. It records a `sync_conflict`, changes synchronization to `needs_review`, and blocks new sales for the slot.
8. The workshop owner must determine which booking can be moved or cancelled. A dedicated conflict review interface remains outside this exercise's scope.

Overbooking can therefore occur when the two platforms sell the same last seat before exchanging their updated state. Without a shared reservation or concurrency mechanism supplied by Artisia, Daisy alone cannot guarantee that this never happens. An idempotency key would prevent duplicate requests, but would not by itself coordinate independent sales across platforms.

I chose a conservative policy:

1. Daisy holds seats locally before calling the partner.
2. The outgoing Daisy booking becomes `confirmed` only when Artisia returns `201`.
3. An Artisia `409` cancels the local booking and informs the customer that the slot is no longer available.
4. A timeout or `500` does not trigger an automatic retry of the non-idempotent POST. The booking stays `uncertain`, seats remain held, and synchronization becomes `needs_review`.
5. An external webhook that causes overbooking records the partner's accepted sale, creates a conflict, and stops new sales.

This policy reduces overbooking risk and suspends new sales as soon as uncertainty is detected. It does not eliminate the race between independent platforms. The stored synchronization state makes the issue available for review; displaying it to the workshop owner requires the planned interface. Holding capacity can lose a sale, but avoids silently confirming an uncertain booking.

### Artisia is unreachable for 20 minutes

When Artisia does not respond, Daisy cannot tell whether the request failed or the partner created the booking before the connection was lost.

The booking becomes `uncertain`. Its seats remain held to prevent resale, and synchronization becomes `needs_review`.

During this period:

- existing confirmed bookings remain stored;
- the stored synchronization state indicates that review is needed;
- new sales for the affected slot are suspended;
- the customer receives `202 Accepted`, indicating that the request is awaiting verification.

Daisy does not automatically retry booking creation. Artisia's booking POST is not idempotent, so another attempt could create a second booking if the first succeeded without returning a response.

The planned recovery process calls `GET /sessions` and compares Artisia's aggregate booked seats with Daisy's known bookings.

If the totals match, the prototype restores `healthy` and confirms the slot's `uncertain` bookings. If they differ, it keeps `needs_review`. Creating a `sync_conflict` during reconciliation is not implemented; current persistent conflicts are created when webhooks reveal overbooking.

An aggregate total cannot reliably identify individual bookings. Matching totals do not prove which bookings succeeded, and the prototype does not close existing conflicts. This simplified reconciliation is covered by business model tests but is insufficient for reliable production recovery.

There is no scheduled background reconciliation in this exercise. In production, a worker would run it with spaced attempts, a rate below 60 requests per minute, and an alert when a slot remains in `needs_review` too long.

### Duplicate or out-of-order webhooks

Before processing, the Edge Function verifies the HMAC signature against the raw request body and the shared Artisia secret. An invalid signature returns `401` without storing an event.

Valid events are stored in `webhook_events`. The unique constraint on `(partner, event_id)` prevents the same event from being stored twice, including concurrent duplicate deliveries.

When an already handled event arrives again, Daisy returns HTTP `200` with `duplicate`, acknowledging delivery without applying a second business effect.

A second protection checks the Artisia booking identifier. The unique constraint on `(source, source_booking_id)` and the check before insertion prevent duplicate Artisia records for the same external booking.

For event ordering, the PostgreSQL function looks up the latest handled `occurred_at` for the same Artisia booking. An incoming event with an older or equal timestamp becomes `stale` and does not change the booking.

For example, if Daisy has handled a cancellation at `14:05` and later receives a creation event from `14:02`, the booking remains cancelled. Business event time is used instead of request arrival order.

The cost of this idempotency mechanism is limited:

- one stored row per unique webhook event;
- two unique constraints and their indexes;
- a lookup for the latest handled event before applying a change;
- a future archival or deletion policy as the event table grows.

This cost is justified by avoiding duplicate reservations or repeated cancellation effects.

### Why I do not automatically retry the booking POST

Artisia's booking creation endpoint is not idempotent. Two identical requests can create two different bookings.

A `409` explicitly rejects the request, so Daisy changes the local booking to `cancelled` and releases its seats.

A timeout or `500` is ambiguous: Artisia may have created the booking before the connection failed or an error occurred while returning the response. Repeating the request could create another booking.

In this situation, Daisy:

1. does not retry the POST;
2. keeps the local booking as `uncertain`;
3. continues holding its seats;
4. sets synchronization to `needs_review`;
5. tells the customer that the request requires verification.

Subsequent reconciliation is a planned persistent recovery step. Automatic confirmation emails and a full recovery workflow are not implemented.

## Exercise scope

### Implemented

- A persistent PostgreSQL schema with constraints.
- Atomic local seat reservation using a slot lock.
- An Edge Function that creates a Daisy booking and submits it to Artisia.
- An Edge Function that receives and verifies signed Artisia webhooks.
- Duplicate webhook protection and timestamp-based event ordering checks.
- Booking statuses: `pending`, `confirmed`, `cancelled`, and `uncertain`.
- Synchronization states used by the flows: `healthy` and `needs_review`.
- External overbooking detection and conflict recording.
- Blocking new sales when partner state is uncertain.
- An Artisia HTTP mock simulating `201`, `409`, `500`, and timeouts.
- Reproducible local data through `seed.sql`.
- Nine fast business logic tests.
- Sixteen integration tests across booking and webhook flows.

### Intentionally outside scope

- A Next.js user interface.
- An automatic background reconciliation worker.
- A production queue for outgoing synchronization.
- Encrypted storage of a separate Artisia key for each workshop.
- Actual delivery of customer confirmation emails.
- An interface for workshop owners to inspect and resolve conflicts.
- Fully automatic resolution when Artisia provides only aggregate booking counts.

These are possible product and technical extensions. The exercise focuses on synchronization rules and failures that could lead to overbooking.

## Automated verification

See [scenario coverage](docs/scenario-coverage.md) for the tested behaviors and remaining limitations.

Run the fast in-memory business logic tests:

```bash
npm test
```

Run booking integration tests, which reset Supabase and exercise PostgreSQL, the Edge Function, and the Artisia HTTP mock:

```bash
npm run test:integration
```

Run webhook integration tests for signatures, duplicates, ordering, and external conflicts:

```bash
npm run test:webhook
```

Check TypeScript without generating files:

```bash
npm run typecheck
```

Coverage includes:

- simultaneous Daisy requests for the last seat;
- confirmation after an Artisia `201`;
- rejection after an Artisia `409`;
- an ambiguous `500` response;
- a timeout without an automatic retry;
- valid and invalid HMAC signatures;
- duplicate webhook delivery;
- an older event arriving after a newer one;
- an external booking that exceeds slot capacity;
- blocking new sales when the partner requires review.

## Planned production improvements

I would keep PostgreSQL as the source of truth and progressively add:

- an outbox table to persist outgoing synchronization work reliably;
- a reconciliation worker for partner errors and outages;
- retries with progressive backoff for operations that are safe to replay;
- encryption for workshop-specific API keys;
- structured logs tracing each booking and webhook;
- alerts for bookings that remain `uncertain` too long;
- a workshop interface showing `healthy`, `degraded`, and `needs_review`;
- an action for the workshop owner to resolve or close a conflict.

Key monitoring metrics would include:

- the count and age of `uncertain` bookings;
- the booking conflict rate;
- discrepancies detected during reconciliation;
- duplicate webhook deliveries;
- partner response times and error rates;
- how long each slot remains in `needs_review`.

These metrics would help detect partner degradation and assess its impact on workshop sales.
