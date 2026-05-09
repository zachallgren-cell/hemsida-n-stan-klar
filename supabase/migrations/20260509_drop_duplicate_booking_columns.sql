update public.bookings
set housing_type = house_size
where housing_type is null
  and house_size is not null;

update public.bookings
set address = location
where address is null
  and location is not null;

alter table public.bookings
  drop column if exists house_size,
  drop column if exists location,
  drop column if exists wash_type,
  drop column if exists service;
