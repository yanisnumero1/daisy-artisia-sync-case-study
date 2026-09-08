-- The slot belongs to Daisy. Partner rows are publications of that same slot.
create table public.slots (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  starts_at timestamptz not null,
  duration_minutes integer not null check (duration_minutes > 0),
  capacity integer not null check (capacity >= 0),
  status text not null default 'published'
    check (status in ('published', 'cancelled')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- One row per external publication: one Daisy slot can exist on Artisia and
-- on another partner at the same time.
create table public.slot_partners (
  id uuid primary key default gen_random_uuid(),
  slot_id uuid not null references public.slots(id) on delete cascade,
  partner text not null,
  partner_session_id text not null,
  status text not null default 'published'
    check (status in ('published', 'cancelled')),
  last_known_capacity integer check (last_known_capacity >= 0),
  last_known_booked integer check (last_known_booked >= 0),
  last_synced_at timestamptz,
  sync_status text not null default 'healthy'
    check (sync_status in ('healthy', 'degraded', 'needs_review')),
  unique (slot_id, partner),
  unique (partner, partner_session_id)
);

create table public.bookings (
  id uuid primary key default gen_random_uuid(),
  slot_id uuid not null references public.slots(id),
  source text not null check (source in ('daisy', 'artisia')),
  source_booking_id text,
  seats integer not null check (seats > 0),
  customer_name text not null,
  customer_email text not null,
  status text not null default 'pending'
    check (status in ('pending', 'confirmed', 'uncertain', 'cancelled')),
  created_at timestamptz not null default now(),
  check (source = 'daisy' or source_booking_id is not null),
  unique (source, source_booking_id)
);

-- The event id is the idempotency key supplied by Artisia. A unique constraint
-- makes a duplicate webhook harmless even if two workers process it together.
create table public.webhook_events (
  id uuid primary key default gen_random_uuid(),
  partner text not null default 'artisia',
  event_id text not null,
  event_type text not null
    check (event_type in ('booking.created', 'booking.cancelled', 'session.updated')),
  payload jsonb not null,
  occurred_at timestamptz not null,
  received_at timestamptz not null default now(),
  processed_at timestamptz,
  status text not null default 'received'
    check (status in ('received', 'processed', 'ignored', 'stale', 'failed')),
  error text,
  unique (partner, event_id)
);

create index bookings_slot_id_idx on public.bookings(slot_id);
create index webhook_events_occurred_at_idx on public.webhook_events(occurred_at);
