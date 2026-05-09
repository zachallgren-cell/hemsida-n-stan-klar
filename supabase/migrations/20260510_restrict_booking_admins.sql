create table if not exists public.admin_users (
  user_id uuid primary key references auth.users(id) on delete cascade,
  created_at timestamp with time zone not null default now()
);

alter table public.admin_users enable row level security;

insert into public.admin_users (user_id)
select id
from auth.users
on conflict (user_id) do nothing;

create or replace function public.is_booking_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.admin_users
    where user_id = auth.uid()
  );
$$;

revoke all on function public.is_booking_admin() from public;
grant execute on function public.is_booking_admin() to authenticated;

drop policy if exists "authenticated can read bookings" on public.bookings;
create policy "authenticated can read bookings"
on public.bookings
for select
to authenticated
using (public.is_booking_admin());

drop policy if exists "authenticated can update bookings" on public.bookings;
create policy "authenticated can update bookings"
on public.bookings
for update
to authenticated
using (public.is_booking_admin())
with check (public.is_booking_admin());

drop policy if exists "authenticated can delete bookings" on public.bookings;
create policy "authenticated can delete bookings"
on public.bookings
for delete
to authenticated
using (public.is_booking_admin());
