create extension if not exists pgcrypto with schema extensions;

set local search_path = pg_catalog, public, extensions;

-- Customer self-service, verified reservations, reminders, recurrence and
-- campaign attribution. The browser never reads these columns directly.
alter table public.bookings
  add column if not exists management_token text,
  add column if not exists management_token_hash text,
  add column if not exists management_token_expires_at timestamp with time zone,
  add column if not exists email_confirmation_expires_at timestamp with time zone,
  add column if not exists email_confirmed_at timestamp with time zone,
  add column if not exists customer_confirmation_email_sent_at timestamp with time zone,
  add column if not exists cancelled_at timestamp with time zone,
  add column if not exists rescheduled_at timestamp with time zone,
  add column if not exists reminder_claimed_at timestamp with time zone,
  add column if not exists reminder_sent_at timestamp with time zone,
  add column if not exists recurrence_weeks smallint,
  add column if not exists recurrence_opt_in_at timestamp with time zone,
  add column if not exists recurrence_paused_at timestamp with time zone,
  add column if not exists recurrence_invitation_claimed_at timestamp with time zone,
  add column if not exists recurrence_invitation_sent_at timestamp with time zone,
  add column if not exists recurrence_series_id uuid,
  add column if not exists rebooked_from_booking_id text,
  add column if not exists postal_code text,
  add column if not exists utm_source text,
  add column if not exists utm_medium text,
  add column if not exists utm_campaign text,
  add column if not exists utm_content text,
  add column if not exists utm_term text,
  add column if not exists landing_page text;

comment on column public.bookings.management_token is
  'Write-only compatibility input. A trigger stores only its SHA-256 hash.';
comment on column public.bookings.management_token_hash is
  'SHA-256 hash for the customer self-service bearer token.';
comment on column public.bookings.email_confirmation_expires_at is
  'Unverified reservations do not block the public calendar and must be confirmed before this time.';
comment on column public.bookings.recurrence_weeks is
  'Explicit invitation preference: null, 8 or 12 weeks. No appointment is auto-created.';

do $constraints$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'bookings_management_token_hash_format'
  ) then
    alter table public.bookings
      add constraint bookings_management_token_hash_format
      check (management_token_hash is null or management_token_hash ~ '^[0-9a-f]{64}$');
  end if;

  if not exists (
    select 1 from pg_constraint where conname = 'bookings_recurrence_weeks_valid'
  ) then
    alter table public.bookings
      add constraint bookings_recurrence_weeks_valid
      check (recurrence_weeks is null or recurrence_weeks in (8, 12));
  end if;

  if not exists (
    select 1 from pg_constraint where conname = 'bookings_postal_code_format'
  ) then
    alter table public.bookings
      add constraint bookings_postal_code_format
      check (postal_code is null or postal_code ~ '^[0-9]{5}$');
  end if;
end;
$constraints$;

create or replace function private.protect_management_token()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, extensions
as $$
begin
  if new.management_token is not null then
    if char_length(new.management_token) < 48 then
      raise exception 'Management token is too short';
    end if;

    new.management_token_hash := encode(
      digest(convert_to(new.management_token, 'UTF8'), 'sha256'),
      'hex'
    );
    new.management_token_expires_at := greatest(
      now() + interval '30 days',
      coalesce(new.booking_date::date, current_date)::timestamp with time zone + interval '30 days'
    );
    new.email_confirmation_expires_at := coalesce(
      new.email_confirmation_expires_at,
      now() + interval '24 hours'
    );
    new.management_token := null;
  end if;

  return new;
end;
$$;

revoke all on function private.protect_management_token() from public, anon, authenticated;

drop trigger if exists protect_management_token_before_write on public.bookings;
create trigger protect_management_token_before_write
before insert or update of management_token on public.bookings
for each row execute function private.protect_management_token();

create unique index if not exists bookings_management_token_hash_idx
  on public.bookings (management_token_hash)
  where management_token_hash is not null;

create index if not exists bookings_management_token_expiry_idx
  on public.bookings (management_token_expires_at)
  where management_token_hash is not null;

-- The product promises one active visit per day. Historical test/legacy rows
-- contain duplicate dates, so retain them for auditability and enforce the
-- promise for every date the new confirmation flow can create.
create unique index if not exists bookings_one_active_date_idx
  on public.bookings (booking_date)
  where status in ('pending', 'confirmed')
    and booking_date >= '2026-07-15';

create index if not exists bookings_unverified_expiry_idx
  on public.bookings (email_confirmation_expires_at)
  where status = 'awaiting_confirmation';

create index if not exists bookings_reminder_due_idx
  on public.bookings (booking_date, booking_time)
  where status in ('pending', 'confirmed') and reminder_sent_at is null;

-- Append-only customer action log. It deliberately contains no token, address
-- or other free-form customer data.
create table if not exists public.booking_customer_events (
  id bigint generated by default as identity primary key,
  booking_id text not null,
  action text not null,
  previous_date date,
  new_date date,
  created_at timestamp with time zone not null default now(),
  constraint booking_customer_events_action_valid check (
    action in ('confirmed', 'cancelled', 'rescheduled', 'recurrence_started', 'recurrence_stopped', 'rebooked')
  )
);

alter table public.booking_customer_events enable row level security;
alter table public.booking_customer_events force row level security;
revoke all on table public.booking_customer_events from public, anon, authenticated, service_role;
grant select, insert on table public.booking_customer_events to service_role;
revoke all on sequence public.booking_customer_events_id_seq from public, anon, authenticated, service_role;
grant usage, select on sequence public.booking_customer_events_id_seq to service_role;

create index if not exists booking_customer_events_booking_idx
  on public.booking_customer_events (booking_id, created_at desc);

-- Hashed request throttling. Edge Functions derive keys with a server secret;
-- no raw IP, email address or phone number is stored here.
create table if not exists public.booking_rate_limits (
  key_hash text primary key,
  window_started_at timestamp with time zone not null default now(),
  attempts integer not null default 0,
  updated_at timestamp with time zone not null default now(),
  constraint booking_rate_limits_hash_format check (key_hash ~ '^[0-9a-f]{64}$'),
  constraint booking_rate_limits_attempts_nonnegative check (attempts >= 0)
);

alter table public.booking_rate_limits enable row level security;
alter table public.booking_rate_limits force row level security;
revoke all on table public.booking_rate_limits from public, anon, authenticated;
grant select, insert, update, delete on table public.booking_rate_limits to service_role;

create or replace function public.consume_booking_rate_limit(
  p_key_hash text,
  p_max_attempts integer,
  p_window_seconds integer
)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  current_row public.booking_rate_limits%rowtype;
begin
  if p_key_hash is null
    or p_key_hash !~ '^[0-9a-f]{64}$'
    or p_max_attempts < 1
    or p_max_attempts > 100
    or p_window_seconds < 10
    or p_window_seconds > 86400
  then
    return false;
  end if;

  insert into public.booking_rate_limits (
    key_hash,
    window_started_at,
    attempts,
    updated_at
  )
  values (p_key_hash, now(), 1, now())
  on conflict (key_hash) do update
  set
    window_started_at = case
      when public.booking_rate_limits.window_started_at
        <= now() - make_interval(secs => p_window_seconds)
        then now()
      else public.booking_rate_limits.window_started_at
    end,
    attempts = case
      when public.booking_rate_limits.window_started_at
        <= now() - make_interval(secs => p_window_seconds)
        then 1
      else public.booking_rate_limits.attempts + 1
    end,
    updated_at = now()
  returning * into current_row;

  return current_row.attempts <= p_max_attempts;
end;
$$;

revoke all on function public.consume_booking_rate_limit(text, integer, integer)
  from public, anon, authenticated;
grant execute on function public.consume_booking_rate_limit(text, integer, integer)
  to service_role;

-- Atomic customer actions. The Edge Function hashes the raw fragment token;
-- this RPC performs the final row lock, expiry and availability checks.
create or replace function public.manage_customer_booking(
  p_booking_id text,
  p_token_hash text,
  p_action text,
  p_new_date text default null,
  p_new_time text default null,
  p_recurrence_weeks integer default null
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  target public.bookings%rowtype;
  parsed_new_date date;
  previous_date date;
begin
  if p_booking_id is null
    or p_token_hash is null
    or p_token_hash !~ '^[0-9a-f]{64}$'
    or p_action not in ('confirm', 'cancel', 'reschedule', 'set_recurrence')
  then
    return jsonb_build_object('ok', false, 'code', 'invalid_request');
  end if;

  select * into target
  from public.bookings
  where id::text = p_booking_id
    and management_token_hash = p_token_hash
  for update;

  if not found
    or target.management_token_expires_at is null
    or target.management_token_expires_at <= now()
  then
    return jsonb_build_object('ok', false, 'code', 'invalid_or_expired');
  end if;

  if p_action = 'confirm' then
    if target.status in ('pending', 'confirmed') and target.email_confirmed_at is not null then
      return jsonb_build_object('ok', true, 'already_done', true, 'status', target.status);
    end if;

    if target.status <> 'awaiting_confirmation'
      or target.email_confirmation_expires_at is null
      or target.email_confirmation_expires_at <= now()
    then
      return jsonb_build_object('ok', false, 'code', 'confirmation_expired');
    end if;

    if exists (
      select 1 from public.booking_blocked_dates
      where blocked_date = target.booking_date::date
    ) then
      return jsonb_build_object('ok', false, 'code', 'date_unavailable');
    end if;

    begin
      update public.bookings
      set status = 'pending', email_confirmed_at = now()
      where id::text = p_booking_id;
    exception when unique_violation then
      return jsonb_build_object('ok', false, 'code', 'date_unavailable');
    end;

    insert into public.booking_customer_events (booking_id, action, new_date)
    values (p_booking_id, 'confirmed', target.booking_date::date);

    return jsonb_build_object('ok', true, 'status', 'pending');
  end if;

  if p_action = 'cancel' then
    if target.status = 'cancelled' then
      return jsonb_build_object('ok', true, 'already_done', true, 'status', 'cancelled');
    end if;

    if target.status not in ('awaiting_confirmation', 'pending', 'confirmed') then
      return jsonb_build_object('ok', false, 'code', 'not_changeable');
    end if;

    update public.bookings
    set status = 'cancelled', cancelled_at = now(), reminder_claimed_at = null
    where id::text = p_booking_id;

    if target.status = 'awaiting_confirmation' and target.discount_code_id is not null then
      update public.discount_codes
      set times_used = greatest(times_used - 1, 0)
      where id = target.discount_code_id;
    end if;

    insert into public.booking_customer_events (booking_id, action, previous_date)
    values (p_booking_id, 'cancelled', target.booking_date::date);

    return jsonb_build_object('ok', true, 'status', 'cancelled');
  end if;

  if p_action = 'reschedule' then
    if target.status not in ('pending', 'confirmed') then
      return jsonb_build_object('ok', false, 'code', 'not_changeable');
    end if;

    begin
      parsed_new_date := p_new_date::date;
    exception when others then
      return jsonb_build_object('ok', false, 'code', 'invalid_date');
    end;

    if parsed_new_date::text <> p_new_date
      or parsed_new_date < (now() at time zone 'Europe/Stockholm')::date + 2
      or parsed_new_date > (now() at time zone 'Europe/Stockholm')::date + 365
      or p_new_time not in ('10:00', '11:00', '12:00', '13:00', '14:00', '15:00', '16:00', '17:00')
    then
      return jsonb_build_object('ok', false, 'code', 'invalid_date');
    end if;

    if exists (
      select 1 from public.booking_blocked_dates
      where blocked_date = parsed_new_date
    ) then
      return jsonb_build_object('ok', false, 'code', 'date_unavailable');
    end if;

    previous_date := target.booking_date::date;

    begin
      update public.bookings
      set
        booking_date = parsed_new_date,
        booking_time = p_new_time,
        rescheduled_at = now(),
        reminder_claimed_at = null,
        reminder_sent_at = null,
        management_token_expires_at = greatest(
          management_token_expires_at,
          parsed_new_date::timestamp with time zone + interval '30 days'
        )
      where id::text = p_booking_id;
    exception when unique_violation then
      return jsonb_build_object('ok', false, 'code', 'date_unavailable');
    end;

    insert into public.booking_customer_events (booking_id, action, previous_date, new_date)
    values (p_booking_id, 'rescheduled', previous_date, parsed_new_date);

    return jsonb_build_object(
      'ok', true,
      'status', target.status,
      'booking_date', parsed_new_date,
      'booking_time', p_new_time
    );
  end if;

  if p_action = 'set_recurrence' then
    if target.status not in ('pending', 'confirmed', 'completed') then
      return jsonb_build_object('ok', false, 'code', 'not_changeable');
    end if;

    if p_recurrence_weeks is null then
      update public.bookings
      set
        recurrence_weeks = null,
        recurrence_paused_at = now(),
        recurrence_invitation_claimed_at = null
      where id::text = p_booking_id;

      insert into public.booking_customer_events (booking_id, action)
      values (p_booking_id, 'recurrence_stopped');

      return jsonb_build_object('ok', true, 'recurrence_weeks', null);
    end if;

    if p_recurrence_weeks not in (8, 12) then
      return jsonb_build_object('ok', false, 'code', 'invalid_recurrence');
    end if;

    update public.bookings
    set
      recurrence_weeks = p_recurrence_weeks,
      recurrence_opt_in_at = coalesce(recurrence_opt_in_at, now()),
      recurrence_paused_at = null,
      recurrence_series_id = coalesce(recurrence_series_id, gen_random_uuid()),
      recurrence_invitation_claimed_at = null,
      recurrence_invitation_sent_at = null
    where id::text = p_booking_id;

    insert into public.booking_customer_events (booking_id, action)
    values (p_booking_id, 'recurrence_started');

    return jsonb_build_object('ok', true, 'recurrence_weeks', p_recurrence_weeks);
  end if;

  return jsonb_build_object('ok', false, 'code', 'invalid_request');
end;
$$;

revoke all on function public.manage_customer_booking(text, text, text, text, text, integer)
  from public, anon, authenticated;
grant execute on function public.manage_customer_booking(text, text, text, text, text, integer)
  to service_role;

-- Admin may approve a reservation only after the customer has confirmed the
-- email link. This prevents the internal workflow from bypassing the public
-- confirmation promise or making an unverified request block the calendar.
create or replace function public.admin_confirm_booking(
  p_booking_id text,
  p_admin_user_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  booking_status text;
  customer_confirmed_at timestamp with time zone;
begin
  if p_booking_id is null
    or p_admin_user_id is null
    or not exists (
      select 1 from public.admin_users where user_id = p_admin_user_id
    )
  then
    return jsonb_build_object('ok', false, 'code', 'not_allowed');
  end if;

  select status, email_confirmed_at
  into booking_status, customer_confirmed_at
  from public.bookings
  where id::text = p_booking_id
  for update;

  if not found then
    return jsonb_build_object('ok', false, 'code', 'booking_not_found');
  end if;

  if booking_status = 'confirmed' and customer_confirmed_at is not null then
    return jsonb_build_object('ok', true, 'already_done', true);
  end if;

  if booking_status <> 'pending' or customer_confirmed_at is null then
    return jsonb_build_object('ok', false, 'code', 'customer_confirmation_required');
  end if;

  update public.bookings
  set status = 'confirmed'
  where id::text = p_booking_id;

  return jsonb_build_object('ok', true, 'confirmedAt', now());
end;
$$;

revoke all on function public.admin_confirm_booking(text, uuid)
  from public, anon, authenticated;
grant execute on function public.admin_confirm_booking(text, uuid)
  to service_role;

-- Compensating operations for the create-booking worker. They are callable
-- only with the service role and keep discount usage aligned when persistence
-- or the mandatory confirmation email fails.
create or replace function public.release_discount_code_usage(p_discount_code_id bigint)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  if p_discount_code_id is null then
    return false;
  end if;

  update public.discount_codes
  set times_used = greatest(times_used - 1, 0)
  where id = p_discount_code_id;

  return found;
end;
$$;

revoke all on function public.release_discount_code_usage(bigint)
  from public, anon, authenticated;
grant execute on function public.release_discount_code_usage(bigint)
  to service_role;

create or replace function public.discard_unconfirmed_booking(p_booking_id text)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  discount_id bigint;
begin
  if p_booking_id is null then
    return false;
  end if;

  select discount_code_id into discount_id
  from public.bookings
  where id::text = p_booking_id
    and status = 'awaiting_confirmation'
    and email_confirmed_at is null
  for update;

  if not found then
    return false;
  end if;

  delete from public.bookings
  where id::text = p_booking_id
    and status = 'awaiting_confirmation'
    and email_confirmed_at is null;

  if discount_id is not null then
    update public.discount_codes
    set times_used = greatest(times_used - 1, 0)
    where id = discount_id;
  end if;

  return true;
end;
$$;

revoke all on function public.discard_unconfirmed_booking(text)
  from public, anon, authenticated;
grant execute on function public.discard_unconfirmed_booking(text)
  to service_role;

-- Claim reminders transactionally so concurrent cron/manual invocations cannot
-- send the same reminder more than once.
create or replace function public.claim_due_booking_reminders(p_limit integer default 25)
returns setof public.bookings
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  if p_limit < 1 or p_limit > 100 then
    p_limit := 25;
  end if;

  return query
  with due as (
    select id
    from public.bookings
    where status in ('pending', 'confirmed')
      and email_confirmed_at is not null
      and reminder_sent_at is null
      and (reminder_claimed_at is null or reminder_claimed_at < now() - interval '20 minutes')
      and ((booking_date::date + booking_time::time) at time zone 'Europe/Stockholm')
        between now() + interval '20 hours' and now() + interval '25 hours'
    order by booking_date, booking_time
    for update skip locked
    limit p_limit
  )
  update public.bookings b
  set reminder_claimed_at = now()
  from due
  where b.id = due.id
  returning b.*;
end;
$$;

revoke all on function public.claim_due_booking_reminders(integer)
  from public, anon, authenticated;
grant execute on function public.claim_due_booking_reminders(integer)
  to service_role;

create or replace function public.claim_due_recurrence_invitations(p_limit integer default 25)
returns setof public.bookings
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  if p_limit < 1 or p_limit > 100 then
    p_limit := 25;
  end if;

  return query
  with due as (
    select id
    from public.bookings
    where recurrence_weeks in (8, 12)
      and recurrence_opt_in_at is not null
      and recurrence_paused_at is null
      and recurrence_invitation_sent_at is null
      and completed_at is not null
      and completed_at + make_interval(weeks => recurrence_weeks) <= now()
      and (
        recurrence_invitation_claimed_at is null
        or recurrence_invitation_claimed_at < now() - interval '20 minutes'
      )
    order by completed_at
    for update skip locked
    limit p_limit
  )
  update public.bookings b
  set recurrence_invitation_claimed_at = now()
  from due
  where b.id = due.id
  returning b.*;
end;
$$;

revoke all on function public.claim_due_recurrence_invitations(integer)
  from public, anon, authenticated;
grant execute on function public.claim_due_recurrence_invitations(integer)
  to service_role;

create or replace function private.purge_booking_workflow_ephemera()
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  with expired as (
    update public.bookings
    set status = 'expired'
    where status = 'awaiting_confirmation'
      and email_confirmation_expires_at < now()
    returning discount_code_id
  ), released as (
    select discount_code_id, count(*)::integer as release_count
    from expired
    where discount_code_id is not null
    group by discount_code_id
  )
  update public.discount_codes as codes
  set times_used = greatest(codes.times_used - released.release_count, 0)
  from released
  where codes.id = released.discount_code_id;

  delete from public.booking_rate_limits
  where updated_at < now() - interval '2 days';

  delete from public.booking_customer_events
  where created_at < now() - interval '2 years';
end;
$$;

revoke all on function private.purge_booking_workflow_ephemera()
  from public, anon, authenticated, service_role;

-- The Fortnox flow is retired. Keep historical columns/table for auditability,
-- but remove every browser privilege and force RLS on the OAuth-token table.
do $fortnox$
begin
  if to_regclass('public.fortnox_oauth_tokens') is not null then
    execute 'alter table public.fortnox_oauth_tokens enable row level security';
    execute 'alter table public.fortnox_oauth_tokens force row level security';
    execute 'revoke all on table public.fortnox_oauth_tokens from public, anon, authenticated';
  end if;
end;
$fortnox$;

-- Reuse pg_cron already enabled by the RUT retention migrations.
do $schedule$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    if not exists (select 1 from cron.job where jobname = 'purge-booking-workflow-ephemera') then
      perform cron.schedule(
        'purge-booking-workflow-ephemera',
        '41 2 * * *',
        'select private.purge_booking_workflow_ephemera();'
      );
    end if;

    if not exists (select 1 from pg_extension where extname = 'pg_net') then
      execute 'create extension if not exists pg_net';
    end if;

    if not exists (select 1 from cron.job where jobname = 'send-booking-reminders') then
      perform cron.schedule(
        'send-booking-reminders',
        '11 * * * *',
        $command$
          select net.http_post(
            url := 'https://xeyippgcoqfskcmqzazx.supabase.co/functions/v1/send-booking-reminders',
            headers := jsonb_build_object(
              'Content-Type', 'application/json',
              'apikey', 'sb_publishable_MUKxAwv0vNXDrcgumq81fQ_Uvx4eOuq'
            ),
            body := '{}'::jsonb,
            timeout_milliseconds := 120000
          );
        $command$
      );
    end if;
  end if;
end;
$schedule$;

do $verify$
begin
  if has_table_privilege('anon', 'public.booking_rate_limits', 'SELECT')
    or has_table_privilege('authenticated', 'public.booking_rate_limits', 'SELECT')
    or has_table_privilege('anon', 'public.booking_customer_events', 'SELECT')
    or has_table_privilege('authenticated', 'public.booking_customer_events', 'SELECT')
  then
    raise exception 'A browser role can access private booking workflow data';
  end if;
end;
$verify$;
