-- Create a predictable slot for local development and integration tests.
insert into public.slots (
  id,
  title,
  starts_at,
  duration_minutes,
  capacity,
  status
) values (
  '11111111-1111-1111-1111-111111111111',
  'Tour de potier débutant',
  now() + interval '7 days',
  120,
  8,
  'published'
);

-- Connect the local Daisy slot to the session exposed by the Artisia mock.
insert into public.slot_partners (
  slot_id,
  partner,
  partner_session_id,
  status,
  last_known_capacity,
  last_known_booked,
  sync_status
) values (
  '11111111-1111-1111-1111-111111111111',
  'artisia',
  'art_ses_8812',
  'published',
  8,
  0,
  'healthy'
);