-- Creates the local hold before calling Artisia.
-- The row lock is the database equivalent of the in-memory slot lock used
-- by the first prototype: two concurrent Daisy requests cannot both consume
-- the last seat.
create or replace function public.reserve_daisy_seats(
  p_slot_id uuid,
  p_seats integer,
  p_customer_name text,
  p_customer_email text
)
returns public.bookings
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_slot public.slots;
  v_occupied integer;
  v_booking public.bookings;
begin
  if p_seats <= 0 then
    raise exception using errcode = '22023', message = 'The number of seats must be positive';
  end if;

  -- FOR UPDATE serializes all reservations for this slot until the insert
  -- below is committed or rolled back.
  select * into v_slot
  from public.slots
  where id = p_slot_id
  for update;

  if not found then
    raise exception using errcode = 'P0002', message = 'Slot not found';
  end if;

  if v_slot.status <> 'published' then
    raise exception using errcode = 'P0001', message = 'Slot is not available';
  end if;

  select coalesce(sum(seats), 0)::integer into v_occupied
  from public.bookings
  where slot_id = p_slot_id
    and status in ('pending', 'confirmed', 'uncertain');

  if v_occupied + p_seats > v_slot.capacity then
    raise exception using errcode = 'P0001', message = 'Not enough seats';
  end if;

  insert into public.bookings (
    slot_id,
    source,
    seats,
    customer_name,
    customer_email,
    status
  ) values (
    p_slot_id,
    'daisy',
    p_seats,
    p_customer_name,
    p_customer_email,
    'pending'
  )
  returning * into v_booking;

  return v_booking;
end;
$$;
