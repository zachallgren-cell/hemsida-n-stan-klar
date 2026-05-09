alter table public.bookings
  drop column if exists personal_number,
  drop column if exists map_link;
