alter table public.bookings
  add column if not exists price text,
  add column if not exists completed_at timestamp with time zone;

comment on column public.bookings.price is 'Pris som visades för kunden vid bokningstillfället.';
comment on column public.bookings.completed_at is 'När jobbet markerades som completed.';

alter table public.bookings enable row level security;

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
