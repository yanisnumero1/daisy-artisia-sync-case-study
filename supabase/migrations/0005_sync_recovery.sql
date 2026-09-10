-- Add recovery support without rewriting historical bookings.
-- Slot locking serializes partner identity and event ordering decisions.
alter table public.slots add column sync_version bigint not null default 0;
create function public.bump_slot_sync_version() returns trigger language plpgsql
set search_path = public as $$
begin
  if TG_OP = 'DELETE' then
    update public.slots set sync_version = sync_version + 1 where id = old.slot_id;
    return old;
  end if;
  update public.slots set sync_version = sync_version + 1 where id = new.slot_id;
  return new;
end;
$$;
create trigger bookings_sync_version after insert or update or delete on public.bookings
for each row execute function public.bump_slot_sync_version();

create function public.record_sync_issue(p_slot_id uuid, p_event_id text, p_reason text)
returns void language sql security invoker set search_path = public as $$
  -- Callers hold the slot lock, so this check is serialized across processors.
  insert into public.sync_conflicts(slot_id, event_id, reason)
  select p_slot_id, p_event_id, p_reason where not exists (
    select 1 from public.sync_conflicts where slot_id = p_slot_id and reason = p_reason and resolved_at is null
  );
$$;

create or replace function public.process_artisia_webhook_event(p_event_id text)
returns text language plpgsql security invoker set search_path = public
set lock_timeout = '1500ms' as $$
declare
  e public.webhook_events; s public.slots; v_booking_id text;
  previous_at timestamptz; previous_type text; occupied integer;
begin
  select * into e from public.webhook_events
  where partner = 'artisia' and event_id = p_event_id for update;
  if not found then raise exception 'Webhook event not found'; end if;
  if e.status in ('processed', 'ignored', 'stale') then return e.status; end if;
  select slots.* into s from public.slots slots
  join public.slot_partners sp on sp.slot_id = slots.id
  where sp.partner = 'artisia' and sp.partner_session_id = e.payload #>> '{data,session_id}'
  for update of slots;
  if not found then
    update public.webhook_events set status = 'failed', error = 'Unknown Artisia session' where id = e.id;
    return 'failed';
  end if;
  v_booking_id := e.payload #>> '{data,booking_id}';
  -- Read order AFTER acquiring the lock: observe the previous holder's commit.
  select occurred_at, event_type into previous_at, previous_type from public.webhook_events
  where partner = 'artisia' and id <> e.id and status in ('processed', 'ignored')
    and payload #>> '{data,session_id}' = e.payload #>> '{data,session_id}'
    and ((v_booking_id is not null and payload #>> '{data,booking_id}' = v_booking_id)
      or (v_booking_id is null and event_type = 'session.updated'))
  order by occurred_at desc, (event_type = 'booking.cancelled') desc limit 1;
  -- Cancellation wins equal partner timestamps; never compare to Daisy's clock.
  if previous_at > e.occurred_at or (previous_at = e.occurred_at
    and not (e.event_type = 'booking.cancelled' and previous_type = 'booking.created')) then
    update public.webhook_events set status = 'stale', processed_at = now(), error = null where id = e.id;
    return 'stale';
  end if;
  if e.event_type = 'booking.created' then
    if exists (select 1 from public.bookings b where b.slot_id = s.id and b.source_booking_id = v_booking_id) then
      update public.webhook_events set status = 'ignored', processed_at = now(), error = null where id = e.id;
      return 'ignored';
    end if;
    insert into public.bookings(slot_id, source, source_booking_id, seats, customer_name, customer_email, status)
    values (s.id, 'artisia', v_booking_id, (e.payload #>> '{data,seats}')::integer,
      coalesce(e.payload #>> '{data,customer,name}', 'Artisia customer'),
      coalesce(e.payload #>> '{data,customer,email}', ''), 'confirmed');
    -- No external_ref in webhooks: never guess identity from customer or seats.
    if exists (select 1 from public.bookings where slot_id = s.id and source = 'daisy'
      and source_booking_id is null and status in ('pending', 'uncertain')) then
      perform public.record_sync_issue(s.id, e.event_id, 'ambiguous_booking_identity');
      update public.slot_partners set sync_status = 'needs_review' where slot_id = s.id and partner = 'artisia';
    end if;
  elsif e.event_type = 'booking.cancelled' then
    update public.bookings b set status = 'cancelled' where b.slot_id = s.id and b.source_booking_id = v_booking_id;
  else
    update public.slot_partners set
      last_known_capacity = coalesce((e.payload #>> '{data,capacity}')::integer, last_known_capacity),
      last_known_booked = coalesce((e.payload #>> '{data,booked}')::integer, last_known_booked),
      last_synced_at = now(),
      status = case when e.payload #>> '{data,status}' = 'cancelled' then 'cancelled' else status end,
      sync_status = case when e.payload #>> '{data,status}' = 'cancelled' then 'needs_review' else sync_status end
    where slot_id = s.id and partner = 'artisia';
    update public.slots set sync_version = sync_version + 1 where id = s.id;
  end if;
  select coalesce(sum(seats), 0) into occupied from public.bookings
  where slot_id = s.id and status in ('pending', 'confirmed', 'uncertain');
  if occupied > s.capacity then
    perform public.record_sync_issue(s.id, e.event_id, 'external_overbooking');
    update public.slot_partners set sync_status = 'needs_review' where slot_id = s.id and partner = 'artisia';
  end if;
  update public.webhook_events set status = 'processed', processed_at = now(), error = null where id = e.id;
  return 'processed';
end;
$$;

-- Preserve the echo as an audit row, but exclude it from inventory after linking
-- the exact partner ID. No heuristic matching and no deletion of booking history.
alter table public.bookings add column merged_into uuid references public.bookings(id);
create function public.finish_artisia_booking(p_booking_id uuid, p_partner_booking_id text)
returns text language plpgsql security invoker set search_path = public as $$
declare
  b public.bookings; external_booking public.bookings;
  final_status text := 'confirmed'; last_type text;
begin
  select * into b from public.bookings where id = p_booking_id;
  if not found or b.source <> 'daisy' then raise exception 'Unknown Daisy booking'; end if;
  perform 1 from public.slots where id = b.slot_id for update;
  select * into b from public.bookings where id = p_booking_id;
  if b.source_booking_id is not null and b.source_booking_id <> p_partner_booking_id then
    raise exception 'Partner identity mismatch';
  end if;
  select * into external_booking from public.bookings
  where slot_id = b.slot_id and source_booking_id = p_partner_booking_id and id <> b.id and merged_into is null;
  if found then
    if external_booking.source <> 'artisia' or external_booking.seats <> b.seats then raise exception 'Partner identity mismatch'; end if;
    final_status := external_booking.status;
    -- This is an audit alias, not a cancellation request to Artisia.
    update public.bookings set merged_into = b.id, status = 'cancelled' where id = external_booking.id;
  end if;
  select event_type into last_type from public.webhook_events
  where partner = 'artisia' and payload #>> '{data,booking_id}' = p_partner_booking_id
    and payload #>> '{data,session_id}' = (select partner_session_id from public.slot_partners where slot_id = b.slot_id and partner = 'artisia')
    and status in ('processed', 'ignored')
  order by occurred_at desc, (event_type = 'booking.cancelled') desc limit 1;
  if last_type = 'booking.cancelled' or b.status = 'cancelled' then final_status := 'cancelled'; end if;
  update public.bookings set source_booking_id = p_partner_booking_id, status = final_status where id = b.id;
  if not exists (select 1 from public.bookings where slot_id = b.slot_id and source = 'daisy'
    and source_booking_id is null and status in ('pending', 'uncertain')) then
    update public.sync_conflicts set resolved_at = now()
    where slot_id = b.slot_id and reason = 'ambiguous_booking_identity' and resolved_at is null;
  end if;
  if external_booking.id is not null and
    (select coalesce(sum(seats), 0) from public.bookings where slot_id = b.slot_id and status <> 'cancelled')
    <= (select capacity from public.slots where id = b.slot_id) then
    update public.sync_conflicts set resolved_at = now()
    where slot_id = b.slot_id and reason = 'external_overbooking' and resolved_at is null;
  end if;
  -- Recovery checks remaining conditions before resuming sales.
  return final_status;
end;
$$;

-- Shared fixed-minute budget, keyed by SHA-256 fingerprint rather than a secret.
create table public.artisia_request_windows (
  key_id text primary key, minute_start timestamptz not null, used integer not null, blocked_until timestamptz
);
alter table public.artisia_request_windows enable row level security;
create function public.take_artisia_request(p_key_id text, p_now timestamptz default clock_timestamp())
returns boolean language plpgsql security invoker set search_path = public as $$
declare w public.artisia_request_windows;
begin
  insert into public.artisia_request_windows(key_id, minute_start, used)
  values (p_key_id, date_trunc('minute', p_now), 0) on conflict do nothing;
  select * into w from public.artisia_request_windows where key_id = p_key_id for update;
  if w.blocked_until > p_now then return false; end if;
  if w.minute_start <> date_trunc('minute', p_now) then
    update public.artisia_request_windows set minute_start = date_trunc('minute', p_now), used = 1, blocked_until = null where key_id = p_key_id;
    return true;
  end if;
  if w.used >= 60 then return false; end if;
  update public.artisia_request_windows set used = used + 1 where key_id = p_key_id;
  return true;
end;
$$;
create function public.block_artisia_key(p_key_id text) returns void
language sql security invoker set search_path = public as $$
  update public.artisia_request_windows set blocked_until = date_trunc('minute', clock_timestamp()) + interval '1 minute' where key_id = p_key_id;
$$;
create table public.artisia_recovery (
  key_id text primary key, next_attempt_at timestamptz not null default now(),
  failures integer not null default 0, last_error text, last_success_at timestamptz
);
alter table public.artisia_recovery enable row level security;
create function public.claim_artisia_recovery(p_key_id text) returns boolean
language plpgsql security invoker set search_path = public as $$
begin
  insert into public.artisia_recovery(key_id) values (p_key_id) on conflict do nothing;
  update public.artisia_recovery set next_attempt_at = clock_timestamp() + interval '1 minute'
  where key_id = p_key_id and next_attempt_at <= clock_timestamp();
  return found;
end;
$$;
create function public.finish_artisia_recovery(p_key_id text, p_error text default null, p_rate_limited boolean default false)
returns void language sql security invoker set search_path = public as $$
  update public.artisia_recovery set
    failures = case when p_error is null then 0 else least(failures + 1, 10) end,
    last_error = p_error,
    last_success_at = case when p_error is null then now() else last_success_at end,
    next_attempt_at = case when p_rate_limited then date_trunc('minute', clock_timestamp()) + interval '1 minute'
      when p_error is null then clock_timestamp() + interval '1 minute'
      else clock_timestamp() + make_interval(secs => least(1200, 60 * power(2, failures)::integer)) end
  where key_id = p_key_id;
  -- This deployment has one workshop key. Do not accept new sales after a
  -- failed poll; preserve stronger needs_review states and recover by GET.
  update public.slot_partners set sync_status = 'degraded'
  where partner = 'artisia' and sync_status = 'healthy' and p_error is not null;
$$;
create function public.reconcile_artisia_session(p_session jsonb, p_version bigint)
returns text language plpgsql security invoker set search_path = public as $$
declare s public.slots; known integer; ambiguous boolean; v_reason text;
begin
  select slots.* into s from public.slots slots join public.slot_partners sp on sp.slot_id = slots.id
  where sp.partner = 'artisia' and sp.partner_session_id = p_session->>'session_id' for update of slots;
  if not found then return 'unmapped'; end if;
  if p_version is null or s.sync_version <> p_version then return 'deferred'; end if;
  if exists (select 1 from public.webhook_events where partner = 'artisia' and status in ('processed', 'ignored')
    and payload #>> '{data,session_id}' = p_session->>'session_id'
    and occurred_at > (p_session->>'updated_at')::timestamptz) then return 'deferred'; end if;
  select coalesce(sum(seats),0), coalesce(bool_or(status in ('pending','uncertain')), false)
  into known, ambiguous from public.bookings where slot_id = s.id and status <> 'cancelled';
  if ambiguous then v_reason := 'uncertain_booking';
  elsif known <> (p_session->>'booked')::integer or s.capacity <> (p_session->>'capacity')::integer
    or p_session->>'status' = 'cancelled' then v_reason := 'aggregate_discrepancy'; end if;
  if v_reason is not null then
    perform public.record_sync_issue(s.id, 'reconcile:' || (p_session->>'session_id'), v_reason);
  else
    update public.sync_conflicts set resolved_at = now() where slot_id = s.id
    and reason in ('aggregate_discrepancy', 'uncertain_booking') and resolved_at is null;
  end if;
  update public.slot_partners set last_known_capacity = (p_session->>'capacity')::integer,
    last_known_booked = (p_session->>'booked')::integer, last_synced_at = now(), status = p_session->>'status',
    sync_status = case when v_reason is not null or s.status <> 'published' or known > s.capacity
      or exists (select 1 from public.sync_conflicts where slot_id = s.id and resolved_at is null)
      then 'needs_review' else 'healthy' end
  where slot_id = s.id and partner = 'artisia';
  return case when v_reason is null then 'checked' else 'needs_review' end;
end;
$$;

-- Only trusted server code may mutate recovery state or claim request budgets.
revoke all on function public.record_sync_issue(uuid,text,text) from public, anon, authenticated;
revoke all on function public.finish_artisia_booking(uuid,text) from public, anon, authenticated;
revoke all on function public.take_artisia_request(text,timestamptz) from public, anon, authenticated;
revoke all on function public.block_artisia_key(text) from public, anon, authenticated;
revoke all on function public.claim_artisia_recovery(text) from public, anon, authenticated;
revoke all on function public.finish_artisia_recovery(text,text,boolean) from public, anon, authenticated;
revoke all on function public.reconcile_artisia_session(jsonb,bigint) from public, anon, authenticated;
grant execute on function public.record_sync_issue(uuid,text,text), public.finish_artisia_booking(uuid,text),
  public.take_artisia_request(text,timestamptz), public.block_artisia_key(text), public.claim_artisia_recovery(text),
  public.finish_artisia_recovery(text,text,boolean), public.reconcile_artisia_session(jsonb,bigint) to service_role;

create function public.set_daisy_booking_state(p_booking_id uuid, p_status text)
returns void language plpgsql security invoker set search_path = public as $$
declare v_slot_id uuid;
begin
  if p_status not in ('cancelled','uncertain') then raise exception 'Invalid booking transition'; end if;
  select slot_id into v_slot_id from public.bookings where id = p_booking_id and source = 'daisy';
  if not found then raise exception 'Unknown Daisy booking'; end if;
  perform 1 from public.slots where id = v_slot_id for update;
  update public.bookings set status = p_status where id = p_booking_id and status = 'pending';
  if p_status = 'uncertain' then
    update public.slot_partners set sync_status = 'needs_review' where slot_id = v_slot_id and partner = 'artisia';
  end if;
end;
$$;
revoke all on function public.set_daisy_booking_state(uuid,text) from public, anon, authenticated;
grant execute on function public.set_daisy_booking_state(uuid,text) to service_role;

revoke all on function public.process_artisia_webhook_event(text) from public, anon, authenticated;
grant execute on function public.process_artisia_webhook_event(text) to service_role;
