alter table public.bookings
  add column if not exists transport_type text,
  add column if not exists sea_miles text,
  add column if not exists coordinates text;

comment on column public.bookings.transport_type is 'Om jobbet gäller fastland eller om båttransport behövs.';
comment on column public.bookings.sea_miles is 'Ungefär antal sjömil från Svinnige marina.';
comment on column public.bookings.coordinates is 'Koordinater eller exakt plats för båttransportjobb.';
