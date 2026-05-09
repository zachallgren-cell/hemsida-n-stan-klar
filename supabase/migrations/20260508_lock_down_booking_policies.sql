alter table public.bookings enable row level security;

drop policy if exists "Allow delete bookings" on public.bookings;
drop policy if exists "Allow insert bookings" on public.bookings;
drop policy if exists "Allow read bookings" on public.bookings;
drop policy if exists "Allow update bookings" on public.bookings;
drop policy if exists "public can insert bookings" on public.bookings;
drop policy if exists "public can read bookings" on public.bookings;

drop policy if exists "authenticated can read bookings" on public.bookings;
create policy "authenticated can read bookings"
on public.bookings
for select
to authenticated
using (true);

drop policy if exists "authenticated can update bookings" on public.bookings;
create policy "authenticated can update bookings"
on public.bookings
for update
to authenticated
using (true)
with check (true);

drop policy if exists "authenticated can delete bookings" on public.bookings;
create policy "authenticated can delete bookings"
on public.bookings
for delete
to authenticated
using (true);
