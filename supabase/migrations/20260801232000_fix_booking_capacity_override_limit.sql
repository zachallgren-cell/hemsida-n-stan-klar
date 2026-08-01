alter table public.booking_capacity_overrides
  add column if not exists extra_bookings smallint;

update public.booking_capacity_overrides
set extra_bookings = 1
where extra_bookings is null;

alter table public.booking_capacity_overrides
  alter column extra_bookings set default 1,
  alter column extra_bookings set not null;

alter table public.booking_capacity_overrides
  drop constraint if exists booking_capacity_overrides_extra_bookings_check;

alter table public.booking_capacity_overrides
  add constraint booking_capacity_overrides_extra_bookings_check
  check (extra_bookings between 1 and 3);

drop index if exists public.bookings_one_active_date_idx;

create or replace function private.enforce_booking_day_capacity()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  if new.status in ('pending', 'confirmed')
    and new.booking_date >= date '2026-07-15'
    and (
      select count(*)
      from public.bookings
      where booking_date = new.booking_date
        and status in ('pending', 'confirmed')
        and id <> new.id
    ) >= coalesce((
      select 1 + extra_bookings
      from public.booking_capacity_overrides
      where booking_date = new.booking_date
    ), 1)
  then
    raise exception 'booking_date_unavailable' using errcode = 'unique_violation';
  end if;
  return new;
end;
$$;

drop trigger if exists enforce_booking_day_capacity on public.bookings;
create trigger enforce_booking_day_capacity
before insert or update of booking_date, status on public.bookings
for each row execute function private.enforce_booking_day_capacity();
