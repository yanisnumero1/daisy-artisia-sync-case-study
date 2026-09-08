create table public.sync_conflicts (
  id uuid primary key default gen_random_uuid(),
  slot_id uuid not null references public.slots(id),
  event_id text not null,
  reason text not null,
  created_at timestamptz not null default now(),
  resolved_at timestamptz
);

-- Applies one already-authenticated webhook. The slot lock makes the
-- capacity check and booking insert one atomic operation.
create or replace function public.process_artisia_webhook_event(p_event_id text)
returns text
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_event public.webhook_events;
  v_slot public.slots;
  v_publication public.slot_partners;
  v_booking_id text;
  v_seats integer;
  v_occupied integer;
  v_previous_at timestamptz;
  v_payload jsonb;
begin
  select * into v_event
  from public.webhook_events
  where event_id = p_event_id
    and partner = 'artisia'
  for update;

  if not found then
    raise exception using errcode = 'P0002', message = 'Webhook event not found';
  end if;

  if v_event.status in ('processed', 'ignored', 'stale') then
    return v_event.status;
  end if;

  v_payload := v_event.payload;
  v_booking_id := v_payload #>> '{data,booking_id}';

  -- Ignore an older event delivered after a newer event for the same booking.
  select max(occurred_at) into v_previous_at
  from public.webhook_events
  where partner = 'artisia'
    and event_id <> p_event_id
    and status in ('processed', 'ignored', 'stale')
    and v_booking_id is not null
    and payload #>> '{data,booking_id}' = v_booking_id;

  if v_previous_at is not null and v_previous_at >= v_event.occurred_at then
    update public.webhook_events
    set status = 'stale', processed_at = now()
    where event_id = p_event_id;
    return 'stale';
  end if;

  select s.* into v_slot
  from public.slots s
  join public.slot_partners sp on sp.slot_id = s.id
  where sp.partner = 'artisia'
    and sp.partner_session_id = v_payload #>> '{data,session_id}'
  for update of s;

  if not found then
    update public.webhook_events
    set status = 'failed', error = 'Unknown Artisia session', processed_at = now()
    where event_id = p_event_id;
    return 'failed';
  end if;

  select sp.* into v_publication
  from public.slot_partners sp
  where sp.slot_id = v_slot.id
    and sp.partner = 'artisia'
    and sp.partner_session_id = v_payload #>> '{data,session_id}';

  if v_event.event_type = 'booking.created' then
    if exists (
      select 1 from public.bookings
      where source = 'artisia' and source_booking_id = v_booking_id
    ) then
      update public.webhook_events
      set status = 'ignored', processed_at = now()
      where event_id = p_event_id;
      return 'ignored';
    end if;

    v_seats := coalesce((v_payload #>> '{data,seats}')::integer, 1);
    select coalesce(sum(seats), 0)::integer into v_occupied
    from public.bookings
    where slot_id = v_slot.id
      and status in ('pending', 'confirmed', 'uncertain');

    insert into public.bookings (
      slot_id, source, source_booking_id, seats,
      customer_name, customer_email, status
    ) values (
      v_slot.id,
      'artisia',
      v_booking_id,
      v_seats,
      coalesce(v_payload #>> '{data,customer,name}', 'Client Artisia'),
      coalesce(v_payload #>> '{data,customer,email}', ''),
      'confirmed'
    );

    if v_occupied + v_seats > v_slot.capacity then
      update public.slot_partners
      set sync_status = 'needs_review'
      where id = v_publication.id;

      insert into public.sync_conflicts (slot_id, event_id, reason)
      values (v_slot.id, p_event_id, 'external_overbooking');
    end if;

  elsif v_event.event_type = 'booking.cancelled' then
    update public.bookings
    set status = 'cancelled'
    where source = 'artisia' and source_booking_id = v_booking_id;

  elsif v_event.event_type = 'session.updated' then
    update public.slot_partners
    set last_known_capacity = coalesce((v_payload #>> '{data,capacity}')::integer, last_known_capacity),
        last_known_booked = coalesce((v_payload #>> '{data,booked}')::integer, last_known_booked),
        last_synced_at = now(),
        status = case when v_payload #>> '{data,status}' = 'cancelled' then 'cancelled' else status end,
        sync_status = case when v_payload #>> '{data,status}' = 'cancelled' then 'needs_review' else sync_status end
    where id = v_publication.id;
  end if;

  update public.webhook_events
  set status = 'processed', processed_at = now()
  where event_id = p_event_id;
  return 'processed';
end;
$$;
