-- Give selected spring-2027 priority-list customers a personal booking window
-- without reserving capacity on every date in that window.

set local search_path = pg_catalog, public;

alter table public.booking_invitations
  alter column booking_date drop not null,
  add column invitation_type text not null default 'reserved_date',
  add column window_start date,
  add column window_end date,
  add column spring_reservation_id uuid references public.spring_2027_reservations(id) on delete set null;

alter table public.booking_invitations
  add constraint booking_invitations_type_check
    check (invitation_type in ('reserved_date', 'spring_priority')),
  add constraint booking_invitations_scope_check
    check (
      (invitation_type = 'reserved_date'
        and booking_date is not null
        and window_start is null
        and window_end is null)
      or
      (invitation_type = 'spring_priority'
        and booking_date is null
        and window_start is not null
        and window_end is not null
        and window_start <= window_end)
    );

create unique index booking_invitations_active_spring_reservation_idx
  on public.booking_invitations (spring_reservation_id)
  where invitation_type = 'spring_priority'
    and status = 'active'
    and spring_reservation_id is not null;

create index booking_invitations_spring_window_idx
  on public.booking_invitations (window_start, window_end, expires_at)
  where invitation_type = 'spring_priority' and status = 'active';

comment on table public.booking_invitations is
  'Personliga bokningsinbjudningar: antingen ett reserverat datum eller tillgang till ett begransat bokningsfonster.';

create or replace function private.enforce_booking_invitation_capacity()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  allowed_capacity integer;
  used_capacity integer;
begin
  new.email := lower(trim(new.email));
  new.updated_at := now();

  -- A spring-priority link only grants access to the calendar. It does not
  -- reserve capacity until the customer completes a booking.
  if new.invitation_type <> 'reserved_date'
    or new.status <> 'active'
    or new.expires_at <= now()
  then
    return new;
  end if;

  allowed_capacity := coalesce((
    select 1 + extra_bookings
    from public.booking_capacity_overrides
    where booking_date = new.booking_date
  ), 1);

  used_capacity := (
    select count(*)
    from public.bookings
    where booking_date = new.booking_date
      and status in ('pending', 'confirmed')
  ) + (
    select count(*)
    from public.booking_invitations
    where invitation_type = 'reserved_date'
      and booking_date = new.booking_date
      and status = 'active'
      and expires_at > now()
      and id is distinct from new.id
  );

  if used_capacity >= allowed_capacity then
    raise exception 'booking_date_unavailable' using errcode = 'unique_violation';
  end if;

  return new;
end;
$$;

drop trigger if exists enforce_booking_invitation_capacity on public.booking_invitations;
create trigger enforce_booking_invitation_capacity
before insert or update of booking_date, invitation_type, window_start, window_end, status, expires_at, email
on public.booking_invitations
for each row execute function private.enforce_booking_invitation_capacity();

create or replace function private.enforce_booking_day_capacity()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  allowed_capacity integer;
  used_capacity integer;
begin
  if new.status not in ('pending', 'confirmed') or new.booking_date < date '2026-07-15' then
    return new;
  end if;

  allowed_capacity := coalesce((
    select 1 + extra_bookings
    from public.booking_capacity_overrides
    where booking_date = new.booking_date
  ), 1);

  used_capacity := (
    select count(*)
    from public.bookings
    where booking_date = new.booking_date
      and status in ('pending', 'confirmed')
      and id is distinct from new.id
  ) + (
    select count(*)
    from public.booking_invitations
    where invitation_type = 'reserved_date'
      and booking_date = new.booking_date
      and status = 'active'
      and expires_at > now()
  );

  if used_capacity >= allowed_capacity then
    raise exception 'booking_date_unavailable' using errcode = 'unique_violation';
  end if;

  return new;
end;
$$;

create or replace function public.finalize_booking_invitation(
  p_token_hash text,
  p_booking_id text
)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  target_invitation public.booking_invitations%rowtype;
  target_booking public.bookings%rowtype;
  date_matches boolean;
begin
  if p_token_hash is null
    or p_token_hash !~ '^[0-9a-f]{64}$'
    or p_booking_id is null
    or char_length(p_booking_id) not between 1 and 80
  then
    return false;
  end if;

  select * into target_invitation
  from public.booking_invitations
  where token_hash = p_token_hash
  for update;

  select * into target_booking
  from public.bookings
  where id::text = p_booking_id
  for update;

  date_matches := case
    when target_invitation.invitation_type = 'reserved_date' then
      target_booking.booking_date = target_invitation.booking_date
    when target_invitation.invitation_type = 'spring_priority' then
      target_booking.booking_date between target_invitation.window_start and target_invitation.window_end
      and extract(isodow from target_booking.booking_date) in (6, 7)
    else false
  end;

  if target_invitation.id is null
    or target_invitation.status <> 'active'
    or target_invitation.expires_at <= now()
    or target_booking.id is null
    or target_booking.status <> 'awaiting_confirmation'
    or not coalesce(date_matches, false)
    or lower(target_booking.email) <> lower(target_invitation.email)
  then
    return false;
  end if;

  update public.booking_invitations
  set status = 'completed',
      completed_at = now(),
      booking_id = target_booking.id::text,
      updated_at = now()
  where id = target_invitation.id;

  update public.bookings
  set status = 'pending',
      email_confirmed_at = coalesce(email_confirmed_at, now()),
      email_confirmation_expires_at = null
  where id::text = target_booking.id::text;

  if target_invitation.spring_reservation_id is not null then
    update public.spring_2027_reservations
    set status = 'booked',
        updated_at = now()
    where id = target_invitation.spring_reservation_id;
  end if;

  return true;
end;
$$;

revoke all on function public.finalize_booking_invitation(text, text) from public, anon, authenticated;
grant execute on function public.finalize_booking_invitation(text, text) to service_role;
