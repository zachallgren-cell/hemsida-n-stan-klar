create schema if not exists private;

create or replace function private.is_booking_admin()
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

revoke all on function private.is_booking_admin() from public;
revoke all on function private.is_booking_admin() from anon;
revoke all on function private.is_booking_admin() from authenticated;

drop policy if exists "authenticated can read bookings" on public.bookings;
create policy "authenticated can read bookings"
on public.bookings
for select
to authenticated
using (private.is_booking_admin());

drop policy if exists "authenticated can update bookings" on public.bookings;
create policy "authenticated can update bookings"
on public.bookings
for update
to authenticated
using (private.is_booking_admin())
with check (private.is_booking_admin());

drop policy if exists "authenticated can delete bookings" on public.bookings;
create policy "authenticated can delete bookings"
on public.bookings
for delete
to authenticated
using (private.is_booking_admin());

drop function if exists public.is_booking_admin();
