-- Follow-up hardening for the manual RUT workflow. The preceding migration
-- has already been deployed, so every later adjustment belongs here.

alter table public.bookings
  add column if not exists rut_submission_available boolean not null default false;

comment on column public.bookings.rut_submission_available is
  'True only while an unexpired encrypted RUT submission exists. Never contains the personal number itself.';

update public.bookings as b
set rut_submission_available = exists (
  select 1
  from public.rut_submissions as s
  where s.booking_id = b.id::text
    and s.expires_at > now()
);

-- Keep the presence flag in sync for every insert, replacement, expiry purge
-- and manual purge, regardless of which server function performed the write.
create or replace function private.sync_rut_submission_availability()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  target_booking_id text;
begin
  target_booking_id := case
    when tg_op = 'DELETE' then old.booking_id
    else new.booking_id
  end;

  update public.bookings as b
  set rut_submission_available = exists (
    select 1
    from public.rut_submissions as s
    where s.booking_id = target_booking_id
      and s.expires_at > now()
  )
  where b.id::text = target_booking_id;

  if tg_op = 'DELETE' then
    return old;
  end if;

  return new;
end;
$$;

revoke all on function private.sync_rut_submission_availability()
  from public, anon, authenticated;

drop trigger if exists sync_rut_submission_availability_after_write
  on public.rut_submissions;
create trigger sync_rut_submission_availability_after_write
after insert or update or delete on public.rut_submissions
for each row execute function private.sync_rut_submission_availability();

-- Remove a possible legacy overload that let callers choose their own expiry.
drop function if exists public.store_encrypted_rut_submission(
  text,
  text,
  text,
  text,
  timestamp with time zone
);

-- Extend the fixed action vocabulary for the new completion event.
alter table public.rut_submission_access_log
  drop constraint if exists rut_submission_access_log_action_valid;
alter table public.rut_submission_access_log
  add constraint rut_submission_access_log_action_valid
  check (action in (
    'viewed',
    'link_issued',
    'work_completed',
    'payment_verified',
    'marked_processed',
    'approved',
    'rejected',
    'purged',
    'expired_and_purged',
    'booking_deleted_and_purged'
  ));

-- Preserve the actor UUID as an audit snapshot even if an auth account is
-- later removed. The log contains no personal number.
alter table public.rut_submission_access_log
  drop constraint if exists rut_submission_access_log_admin_user_id_fkey;

comment on column public.rut_submission_access_log.admin_user_id is
  'Snapshot of the acting administrator UUID; deliberately retained without a foreign key for audit continuity.';

create index if not exists rut_submission_access_log_created_at_idx
  on public.rut_submission_access_log (created_at);

-- Marking work completed is separate from sending the final payment email.
-- This lets the administrator reveal the RUT details, create the invoice and
-- then send Swish instructions with the real invoice reference.
create or replace function public.admin_mark_booking_completed(
  p_booking_id text,
  p_admin_user_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  booking_completed_at timestamp with time zone;
  booking_payment_status text;
  booking_rut_choice text;
  booking_rut_application_status text;
  changed_at timestamp with time zone := now();
  submission_found boolean := false;
begin
  if p_booking_id is null
    or p_admin_user_id is null
    or not exists (
      select 1 from public.admin_users where user_id = p_admin_user_id
    )
  then
    return jsonb_build_object('ok', false, 'code', 'not_allowed');
  end if;

  select
    completed_at,
    payment_status,
    rut_choice,
    rut_application_status
  into
    booking_completed_at,
    booking_payment_status,
    booking_rut_choice,
    booking_rut_application_status
  from public.bookings
  where id::text = p_booking_id
  for update;

  if not found then
    return jsonb_build_object('ok', false, 'code', 'booking_not_found');
  end if;

  submission_found := exists (
    select 1
    from public.rut_submissions
    where booking_id = p_booking_id
      and expires_at > changed_at
  );

  update public.bookings
  set
    status = 'completed',
    completed_at = coalesce(completed_at, changed_at),
    rut_application_status = case
      when btrim(coalesce(booking_rut_choice, '')) ~* '^ja([[:space:][:punct:]]|$)'
        and booking_payment_status = 'paid'
        and booking_rut_application_status = 'not_ready'
        and submission_found
        then 'ready'
      else rut_application_status
    end
  where id::text = p_booking_id;

  if booking_completed_at is null
    and btrim(coalesce(booking_rut_choice, '')) ~* '^ja([[:space:][:punct:]]|$)'
    and submission_found
  then
    insert into public.rut_submission_access_log (
      booking_id,
      admin_user_id,
      action
    ) values (
      p_booking_id,
      p_admin_user_id,
      'work_completed'
    );
  end if;

  return jsonb_build_object(
    'ok', true,
    'completedAt', coalesce(booking_completed_at, changed_at)
  );
end;
$$;

revoke all on function public.admin_mark_booking_completed(text, uuid)
  from public, anon, authenticated;
grant execute on function public.admin_mark_booking_completed(text, uuid)
  to service_role;

-- Confirmation also goes through the authenticated Edge Function. Direct
-- table-wide UPDATE is revoked below so payment, RUT and token fields cannot
-- be altered with an administrator JWT outside the audited server workflow.
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
  changed_at timestamp with time zone := now();
begin
  if p_booking_id is null
    or p_admin_user_id is null
    or not exists (
      select 1 from public.admin_users where user_id = p_admin_user_id
    )
  then
    return jsonb_build_object('ok', false, 'code', 'not_allowed');
  end if;

  update public.bookings
  set status = 'confirmed'
  where id::text = p_booking_id;

  if not found then
    return jsonb_build_object('ok', false, 'code', 'booking_not_found');
  end if;

  return jsonb_build_object('ok', true, 'confirmedAt', changed_at);
end;
$$;

revoke all on function public.admin_confirm_booking(text, uuid)
  from public, anon, authenticated;
grant execute on function public.admin_confirm_booking(text, uuid)
  to service_role;

-- RLS still controls reading and deleting. Remove the table privilege that
-- previously let an authenticated administrator update every booking column.
revoke update on table public.bookings from authenticated;

-- Replacement links remain unavailable once details exist or the application
-- has already been submitted or approved.
create or replace function public.issue_rut_form_token_hash(
  p_booking_id text,
  p_token_hash text
)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  if p_booking_id is null
    or p_token_hash is null
    or p_token_hash !~ '^[0-9a-f]{64}$'
  then
    return false;
  end if;

  update public.bookings as b
  set
    rut_form_token = null,
    rut_form_token_hash = p_token_hash,
    rut_form_token_expires_at = now() + interval '30 days',
    rut_form_token_used_at = null,
    rut_status = 'Skickat',
    rut_sent_at = now(),
    rut_email_sent = false,
    rut_email_sent_at = null,
    rut_submission_available = false
  where b.id::text = p_booking_id
    and btrim(coalesce(b.rut_choice, '')) ~* '^ja([[:space:][:punct:]]|$)'
    and coalesce(b.rut_application_status, 'not_ready') not in ('submitted', 'approved')
    and not exists (
      select 1
      from public.rut_submissions as s
      where s.booking_id = p_booking_id
    );

  return found;
end;
$$;

revoke all on function public.issue_rut_form_token_hash(text, text)
  from public, anon, authenticated;
grant execute on function public.issue_rut_form_token_hash(text, text)
  to service_role;

-- Security/access logs have a separate, explicit two-year retention period.
create or replace function private.purge_old_rut_access_logs()
returns integer
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  deleted_count integer;
begin
  with deleted as (
    delete from public.rut_submission_access_log
    where created_at < now() - interval '2 years'
    returning 1
  )
  select count(*)::integer into deleted_count from deleted;

  return deleted_count;
end;
$$;

revoke all on function private.purge_old_rut_access_logs()
  from public, anon, authenticated;

do $schedule$
begin
  if not exists (
    select 1
    from cron.job
    where jobname = 'purge-old-rut-access-logs'
  ) then
    perform cron.schedule(
      'purge-old-rut-access-logs',
      '17 2 * * *',
      'select private.purge_old_rut_access_logs();'
    );
  end if;

  if not exists (
    select 1
    from cron.job
    where jobname = 'purge-expired-rut-submissions'
      and schedule = '23 * * * *'
      and active
  ) then
    raise exception 'The hourly RUT-submission purge job is missing or inactive';
  end if;

  if not exists (
    select 1
    from cron.job
    where jobname = 'purge-old-rut-access-logs'
      and schedule = '17 2 * * *'
      and active
  ) then
    raise exception 'The daily RUT access-log purge job is missing or inactive';
  end if;
end;
$schedule$;
