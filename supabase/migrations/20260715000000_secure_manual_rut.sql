create extension if not exists pgcrypto with schema extensions;

set local search_path = pg_catalog, public, extensions;

alter table public.bookings
  add column if not exists rut_form_token_hash text,
  add column if not exists rut_form_token_expires_at timestamp with time zone,
  add column if not exists rut_form_token_used_at timestamp with time zone,
  add column if not exists labor_cost_before_rut integer,
  add column if not exists material_cost integer,
  add column if not exists transport_cost integer,
  add column if not exists rut_deduction integer,
  add column if not exists price_before_rut integer,
  add column if not exists customer_price_before_discount integer,
  add column if not exists actual_work_hours numeric(6, 2),
  add column if not exists invoice_reference text,
  add column if not exists swish_reference text,
  add column if not exists swish_amount integer,
  add column if not exists swish_sent_at timestamp with time zone,
  add column if not exists payment_status text not null default 'unpaid',
  add column if not exists rut_application_status text not null default 'not_ready',
  add column if not exists rut_application_submitted_at timestamp with time zone,
  add column if not exists rut_application_processed_at timestamp with time zone,
  add column if not exists rut_requested_amount integer,
  add column if not exists rut_rejection_reason text;

comment on column public.bookings.rut_form_token is
  'Skrivkompatibelt inmatningsfält. En trigger hash-lagrar värdet och nollställer klartexten direkt.';
comment on column public.bookings.rut_form_token_hash is 'SHA-256-hash av den aktiva engångslänken för RUT-formuläret.';
comment on column public.bookings.rut_form_token_expires_at is 'När engångslänken för RUT-formuläret upphör att gälla.';
comment on column public.bookings.rut_form_token_used_at is 'När engångslänken för RUT-formuläret förbrukades.';
comment on column public.bookings.labor_cost_before_rut is 'Faktisk arbetskostnad inklusive moms efter eventuell arbetsrabatt men före preliminärt RUT-avdrag.';
comment on column public.bookings.material_cost is 'Materialkostnad inklusive moms som inte är RUT-grundande.';
comment on column public.bookings.transport_cost is 'Transportkostnad inklusive moms som inte är RUT-grundande.';
comment on column public.bookings.rut_deduction is 'Beräknat preliminärt RUT-avdrag efter eventuell arbetsrabatt, i hela kronor.';
comment on column public.bookings.price_before_rut is 'Faktiskt totalpris efter eventuell arbetsrabatt men före preliminärt RUT-avdrag.';
comment on column public.bookings.customer_price_before_discount is 'Ordinarie kundpris för valt RUT-läge före eventuell rabatt.';
comment on column public.bookings.actual_work_hours is 'Faktiskt utförda arbetstimmar för den manuella RUT-ansökan.';
comment on column public.bookings.invoice_reference is 'Nummer eller referens från den manuellt skapade fakturan.';
comment on column public.bookings.swish_reference is 'Kort unik referens som kunden anger i Swish.';
comment on column public.bookings.swish_amount is 'Belopp i hela kronor som kunden ska betala med Swish.';
comment on column public.bookings.swish_sent_at is 'När Swish-instruktionen skickades till kunden.';
comment on column public.bookings.rut_application_status is 'Status för den manuella RUT-ansökan: not_ready, ready, submitted, approved eller rejected.';
comment on column public.bookings.rut_application_submitted_at is 'När den manuella RUT-ansökan registrerades hos Skatteverket.';
comment on column public.bookings.rut_application_processed_at is 'När RUT-ärendet markerades som färdigbehandlat.';
comment on column public.bookings.rut_requested_amount is 'Belopp i hela kronor som begärts från Skatteverket.';
comment on column public.bookings.rut_rejection_reason is 'Intern notering om varför ett RUT-ärende avslogs.';

-- Preserve historical payment truth when introducing/normalising the status.
update public.bookings
set payment_status = 'paid'
where paid_at is not null
   or stripe_paid_at is not null;

-- Carry forward the parts of the legacy RUT workflow that have an
-- unambiguous meaning. "Verifierat" only means that the submitted details
-- were checked, so it becomes ready (not submitted) once work and payment are
-- complete. A Fortnox sync is the only legacy event treated as submitted.
update public.bookings
set
  rut_application_status = case
    when btrim(coalesce(rut_choice, '')) ~* '^ja([[:space:][:punct:]]|$)'
      and fortnox_rut_synced_at is not null
      then 'submitted'
    when btrim(coalesce(rut_choice, '')) ~* '^ja([[:space:][:punct:]]|$)'
      and completed_at is not null
      and payment_status = 'paid'
      and (
        rut_received_at is not null
        or lower(coalesce(rut_status, '')) in ('mottaget', 'verifierat')
      )
      then 'ready'
    else 'not_ready'
  end,
  rut_application_submitted_at = case
    when btrim(coalesce(rut_choice, '')) ~* '^ja([[:space:][:punct:]]|$)'
      and fortnox_rut_synced_at is not null
      then fortnox_rut_synced_at
    else null
  end;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'bookings_rut_form_token_hash_format') then
    alter table public.bookings
      add constraint bookings_rut_form_token_hash_format
      check (rut_form_token_hash is null or rut_form_token_hash ~ '^[0-9a-f]{64}$');
  end if;

  if not exists (select 1 from pg_constraint where conname = 'bookings_manual_rut_amounts_nonnegative') then
    alter table public.bookings
      add constraint bookings_manual_rut_amounts_nonnegative
      check (
        (labor_cost_before_rut is null or labor_cost_before_rut >= 0)
        and (material_cost is null or material_cost >= 0)
        and (transport_cost is null or transport_cost >= 0)
        and (rut_deduction is null or rut_deduction >= 0)
        and (price_before_rut is null or price_before_rut >= 0)
        and (customer_price_before_discount is null or customer_price_before_discount >= 0)
        and (swish_amount is null or swish_amount >= 0)
        and (rut_requested_amount is null or rut_requested_amount >= 0)
      );
  end if;

  if not exists (select 1 from pg_constraint where conname = 'bookings_actual_work_hours_nonnegative') then
    alter table public.bookings
      add constraint bookings_actual_work_hours_nonnegative
      check (actual_work_hours is null or actual_work_hours >= 0);
  end if;

  if not exists (select 1 from pg_constraint where conname = 'bookings_invoice_reference_length') then
    alter table public.bookings
      add constraint bookings_invoice_reference_length
      check (invoice_reference is null or char_length(invoice_reference) <= 100);
  end if;

  if not exists (select 1 from pg_constraint where conname = 'bookings_swish_reference_length') then
    alter table public.bookings
      add constraint bookings_swish_reference_length
      check (swish_reference is null or char_length(swish_reference) <= 50);
  end if;

  if not exists (select 1 from pg_constraint where conname = 'bookings_rut_application_status_valid') then
    alter table public.bookings
      add constraint bookings_rut_application_status_valid
      check (rut_application_status in ('not_ready', 'ready', 'submitted', 'approved', 'rejected'));
  end if;

  if not exists (select 1 from pg_constraint where conname = 'bookings_payment_status_valid') then
    alter table public.bookings
      add constraint bookings_payment_status_valid
      check (payment_status in ('unpaid', 'paid'));
  end if;
end;
$$;

-- Legacy links placed their bearer token in the query string. Revoke every
-- legacy token instead of extending a value that may exist in CDN/server logs.
-- New links are issued as URL fragments and are hash-stored by the trigger below.
update public.bookings
set
  rut_form_token_hash = null,
  rut_form_token_expires_at = null,
  rut_form_token_used_at = coalesce(rut_form_token_used_at, now()),
  rut_form_token = null
where rut_form_token is not null;

create or replace function private.protect_rut_form_token()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, extensions
as $$
begin
  if new.rut_form_token is not null then
    new.rut_form_token_hash := encode(digest(convert_to(new.rut_form_token, 'UTF8'), 'sha256'), 'hex');
    new.rut_form_token_expires_at := now() + interval '30 days';
    new.rut_form_token_used_at := null;
    new.rut_form_token := null;
  end if;

  return new;
end;
$$;

revoke all on function private.protect_rut_form_token() from public, anon, authenticated;

drop trigger if exists protect_rut_form_token_before_write on public.bookings;
create trigger protect_rut_form_token_before_write
before insert or update of rut_form_token on public.bookings
for each row execute function private.protect_rut_form_token();

drop index if exists public.bookings_rut_form_token_idx;
create unique index if not exists bookings_rut_form_token_hash_idx
  on public.bookings (rut_form_token_hash)
  where rut_form_token_hash is not null;

create index if not exists bookings_rut_form_token_expiry_idx
  on public.bookings (rut_form_token_expires_at)
  where rut_form_token_hash is not null and rut_form_token_used_at is null;

create table if not exists public.rut_submissions (
  id bigint generated by default as identity primary key,
  booking_id text not null unique,
  personal_number_ciphertext text not null,
  personal_number_iv text not null,
  encryption_version smallint not null default 1,
  submitted_at timestamp with time zone not null default now(),
  updated_at timestamp with time zone not null default now(),
  expires_at timestamp with time zone not null,
  processed_at timestamp with time zone,
  processed_by uuid references auth.users(id) on delete set null,
  privacy_notice_version text not null default 'rut-2026-07-14',
  privacy_notice_acknowledged_at timestamp with time zone not null default now(),
  constraint rut_submissions_ciphertext_not_blank check (char_length(personal_number_ciphertext) >= 24),
  constraint rut_submissions_iv_not_blank check (char_length(personal_number_iv) >= 16),
  constraint rut_submissions_encryption_version_valid check (encryption_version = 1),
  constraint rut_submissions_expiry_after_submission check (expires_at > submitted_at)
);

comment on table public.rut_submissions is
  'Låst, krypterad arbetskopia av personnummer för manuell RUT-hantering. Endast Edge Functions med service role har åtkomst.';
comment on column public.rut_submissions.booking_id is 'Boknings-ID lagrat som text för kompatibilitet med befintlig bokningstyp.';
comment on column public.rut_submissions.personal_number_ciphertext is 'AES-256-GCM-krypterat personnummer inklusive autentiseringstagg, Base64-kodat.';
comment on column public.rut_submissions.personal_number_iv is 'Unik 96-bitars AES-GCM-IV, Base64-kodad.';
comment on column public.rut_submissions.expires_at is 'Tidpunkt då webbplatsens krypterade arbetskopia ska gallras.';
comment on column public.rut_submissions.processed_at is 'När uppgiften markerades som överförd till den manuella RUT-processen.';
comment on column public.rut_submissions.privacy_notice_version is 'Versionen av RUT-integritetsinformationen som kunden bekräftade att den tagit del av.';
comment on column public.rut_submissions.privacy_notice_acknowledged_at is 'När kunden bekräftade att den tagit del av RUT-integritetsinformationen.';

alter table public.rut_submissions enable row level security;
alter table public.rut_submissions force row level security;

revoke all on table public.rut_submissions from public, anon, authenticated;
grant select, insert, update, delete on table public.rut_submissions to service_role;
grant usage, select on sequence public.rut_submissions_id_seq to service_role;

create index if not exists rut_submissions_expires_at_idx on public.rut_submissions (expires_at);

create table if not exists public.rut_submission_access_log (
  id bigint generated by default as identity primary key,
  booking_id text not null,
  admin_user_id uuid references auth.users(id) on delete set null,
  action text not null,
  created_at timestamp with time zone not null default now(),
  constraint rut_submission_access_log_action_valid
    check (action in (
      'viewed',
      'link_issued',
      'payment_verified',
      'marked_processed',
      'approved',
      'rejected',
      'purged',
      'expired_and_purged',
      'booking_deleted_and_purged'
    ))
);

comment on table public.rut_submission_access_log is
  'Revisionslogg över administrativ åtkomst till krypterade RUT-uppgifter. Innehåller aldrig personnummer.';

alter table public.rut_submission_access_log enable row level security;
alter table public.rut_submission_access_log force row level security;

revoke all on table public.rut_submission_access_log from public, anon, authenticated;
grant select, insert on table public.rut_submission_access_log to service_role;
grant usage, select on sequence public.rut_submission_access_log_id_seq to service_role;

create index if not exists rut_submission_access_log_booking_idx
  on public.rut_submission_access_log (booking_id, created_at desc);

create or replace function private.set_rut_submission_updated_at()
returns trigger
language plpgsql
set search_path = pg_catalog
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

revoke all on function private.set_rut_submission_updated_at() from public, anon, authenticated;

drop trigger if exists set_rut_submission_updated_at on public.rut_submissions;
create trigger set_rut_submission_updated_at
before update on public.rut_submissions
for each row execute function private.set_rut_submission_updated_at();

-- This transaction consumes the bearer token and stores only encrypted data.
-- It is callable exclusively with the server-side service role.
create or replace function public.store_encrypted_rut_submission(
  p_booking_id text,
  p_token_hash text,
  p_ciphertext text,
  p_iv text
)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  matched_booking_id text;
  matched_booking_date date;
  bounded_expiry timestamp with time zone;
begin
  if p_booking_id is null
    or p_token_hash is null
    or p_token_hash !~ '^[0-9a-f]{64}$'
    or p_ciphertext is null
    or char_length(p_ciphertext) < 24
    or p_iv is null
    or char_length(p_iv) < 16
  then
    return false;
  end if;

  select id::text, booking_date::date
  into matched_booking_id, matched_booking_date
  from public.bookings
  where id::text = p_booking_id
    and btrim(coalesce(rut_choice, '')) ~* '^ja([[:space:][:punct:]]|$)'
    and rut_form_token_hash = p_token_hash
    and rut_form_token_used_at is null
    and rut_form_token_expires_at > now()
  for update;

  if not found then
    return false;
  end if;

  -- The cleanup job runs in batches. Store the technical expiry one day
  -- before the communicated outer limit so an hourly purge still deletes the
  -- working copy before that limit even if one run is delayed.
  bounded_expiry := least(
    greatest(
      now() + interval '180 days',
      coalesce(matched_booking_date::timestamp with time zone + interval '180 days', now() + interval '180 days')
    ),
    now() + interval '2 years'
  ) - interval '1 day';

  insert into public.rut_submissions (
    booking_id,
    personal_number_ciphertext,
    personal_number_iv,
    encryption_version,
    submitted_at,
    updated_at,
    expires_at,
    processed_at,
    processed_by,
    privacy_notice_version,
    privacy_notice_acknowledged_at
  ) values (
    matched_booking_id,
    p_ciphertext,
    p_iv,
    1,
    now(),
    now(),
    bounded_expiry,
    null,
    null,
    'rut-2026-07-14',
    now()
  )
  on conflict (booking_id) do update set
    personal_number_ciphertext = excluded.personal_number_ciphertext,
    personal_number_iv = excluded.personal_number_iv,
    encryption_version = excluded.encryption_version,
    submitted_at = excluded.submitted_at,
    expires_at = excluded.expires_at,
    processed_at = null,
    processed_by = null,
    privacy_notice_version = excluded.privacy_notice_version,
    privacy_notice_acknowledged_at = excluded.privacy_notice_acknowledged_at;

  update public.bookings
  set
    rut_form_token = null,
    rut_form_token_hash = null,
    rut_form_token_used_at = now(),
    rut_status = 'Mottaget',
    rut_received_at = now(),
    rut_application_status = case
      when completed_at is not null and payment_status = 'paid' then 'ready'
      else 'not_ready'
    end
  where id::text = matched_booking_id;

  return true;
end;
$$;

revoke all on function public.store_encrypted_rut_submission(text, text, text, text)
  from public, anon, authenticated;
grant execute on function public.store_encrypted_rut_submission(text, text, text, text)
  to service_role;

-- Administrative RUT transitions are kept in one transaction together with
-- their audit event. The Edge Function has already verified the user, and the
-- allowlist is checked again here before any state can change.
create or replace function public.admin_manage_rut_submission(
  p_booking_id text,
  p_admin_user_id uuid,
  p_action text
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
    or p_action is null
    or p_action not in ('mark_paid', 'mark_processed', 'approve', 'reject', 'purge')
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

  if p_action = 'mark_paid' then
    if booking_completed_at is null then
      return jsonb_build_object('ok', false, 'code', 'work_pending');
    end if;

    update public.bookings
    set
      payment_status = 'paid',
      paid_at = coalesce(paid_at, changed_at),
      payment_provider = 'swish',
      payment_method = 'Swish Företag',
      rut_application_status = case
        when btrim(coalesce(booking_rut_choice, '')) ~* '^ja([[:space:][:punct:]]|$)'
          and booking_rut_application_status = 'not_ready'
          and exists (
            select 1
            from public.rut_submissions
            where booking_id = p_booking_id
              and expires_at > changed_at
          )
          then 'ready'
        else rut_application_status
      end
    where id::text = p_booking_id;

    if btrim(coalesce(booking_rut_choice, '')) ~* '^ja([[:space:][:punct:]]|$)'
      and exists (
        select 1
        from public.rut_submissions
        where booking_id = p_booking_id
          and expires_at > changed_at
      )
    then
      insert into public.rut_submission_access_log (
        booking_id,
        admin_user_id,
        action
      ) values (
        p_booking_id,
        p_admin_user_id,
        'payment_verified'
      );
    end if;

    return jsonb_build_object('ok', true, 'paidAt', changed_at);
  end if;

  if btrim(coalesce(booking_rut_choice, '')) !~* '^ja([[:space:][:punct:]]|$)' then
    return jsonb_build_object('ok', false, 'code', 'not_rut_booking');
  end if;

  if p_action = 'purge' then
    delete from public.rut_submissions
    where booking_id = p_booking_id;
    submission_found := found;

    if submission_found then
      update public.bookings
      set rut_status = 'Gallrat'
      where id::text = p_booking_id;

      insert into public.rut_submission_access_log (
        booking_id,
        admin_user_id,
        action
      ) values (
        p_booking_id,
        p_admin_user_id,
        'purged'
      );
    end if;

    return jsonb_build_object('ok', true, 'purged', submission_found);
  end if;

  if p_action = 'mark_processed' then
    if booking_completed_at is null or booking_payment_status <> 'paid' then
      return jsonb_build_object('ok', false, 'code', 'work_or_payment_pending');
    end if;

    if booking_rut_application_status = 'submitted' then
      return jsonb_build_object('ok', true, 'alreadySubmitted', true);
    end if;

    if booking_rut_application_status not in ('ready', 'rejected') then
      return jsonb_build_object('ok', false, 'code', 'not_ready');
    end if;

    update public.rut_submissions
    set
      processed_at = changed_at,
      processed_by = p_admin_user_id
    where booking_id = p_booking_id
      and expires_at > changed_at;
    submission_found := found;

    if not submission_found then
      return jsonb_build_object('ok', false, 'code', 'submission_not_found');
    end if;

    update public.bookings
    set
      rut_status = 'Ansökt',
      rut_application_status = 'submitted',
      rut_application_submitted_at = changed_at,
      rut_application_processed_at = null
    where id::text = p_booking_id;

    insert into public.rut_submission_access_log (
      booking_id,
      admin_user_id,
      action
    ) values (
      p_booking_id,
      p_admin_user_id,
      'marked_processed'
    );

    return jsonb_build_object('ok', true, 'processedAt', changed_at);
  end if;

  if booking_rut_application_status <> 'submitted' then
    return jsonb_build_object('ok', false, 'code', 'not_submitted');
  end if;

  update public.bookings
  set
    rut_status = case when p_action = 'approve' then 'Godkänt' else 'Avslag' end,
    rut_application_status = case when p_action = 'approve' then 'approved' else 'rejected' end,
    rut_application_processed_at = changed_at
  where id::text = p_booking_id;

  insert into public.rut_submission_access_log (
    booking_id,
    admin_user_id,
    action
  ) values (
    p_booking_id,
    p_admin_user_id,
    case when p_action = 'approve' then 'approved' else 'rejected' end
  );

  return jsonb_build_object('ok', true, 'processedAt', changed_at);
end;
$$;

revoke all on function public.admin_manage_rut_submission(text, uuid, text)
  from public, anon, authenticated;
grant execute on function public.admin_manage_rut_submission(text, uuid, text)
  to service_role;

-- Issue replacement links without ever storing their bearer token in clear
-- text. This is needed for bookings whose earlier query-string links are
-- revoked by this migration.
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
    rut_email_sent_at = null
  where b.id::text = p_booking_id
    and btrim(coalesce(b.rut_choice, '')) ~* '^ja([[:space:][:punct:]]|$)'
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

create or replace function public.finish_rut_form_token_email(
  p_booking_id text,
  p_token_hash text,
  p_delivered boolean
)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  if p_booking_id is null
    or p_token_hash is null
    or p_delivered is null
    or p_token_hash !~ '^[0-9a-f]{64}$'
  then
    return false;
  end if;

  if p_delivered then
    update public.bookings
    set
      rut_email_sent = true,
      rut_email_sent_at = now()
    where id::text = p_booking_id
      and rut_form_token_hash = p_token_hash;
  else
    update public.bookings
    set
      rut_form_token_hash = null,
      rut_form_token_expires_at = null,
      rut_form_token_used_at = now(),
      rut_status = 'Ej skickat'
    where id::text = p_booking_id
      and rut_form_token_hash = p_token_hash;
  end if;

  return found;
end;
$$;

revoke all on function public.finish_rut_form_token_email(text, text, boolean)
  from public, anon, authenticated;
grant execute on function public.finish_rut_form_token_email(text, text, boolean)
  to service_role;

-- Delete the encrypted working copy whenever its booking is deleted, even
-- though booking_id is text for compatibility with the existing schema.
create or replace function private.purge_rut_submission_on_booking_delete()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  if exists (
    select 1
    from public.rut_submissions
    where booking_id = old.id::text
  ) then
    insert into public.rut_submission_access_log (
      booking_id,
      admin_user_id,
      action
    ) values (
      old.id::text,
      auth.uid(),
      'booking_deleted_and_purged'
    );
  end if;

  delete from public.rut_submissions where booking_id = old.id::text;
  return old;
end;
$$;

revoke all on function private.purge_rut_submission_on_booking_delete()
  from public, anon, authenticated;

drop trigger if exists purge_rut_submission_after_booking_delete on public.bookings;
create trigger purge_rut_submission_after_booking_delete
after delete on public.bookings
for each row execute function private.purge_rut_submission_on_booking_delete();

-- A database-owned cleanup routine makes expires_at an actual retention
-- boundary instead of only hiding expired data in the admin API.
create or replace function private.purge_expired_rut_submissions()
returns integer
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  deleted_count integer := 0;
begin
  with deleted as (
    delete from public.rut_submissions
    where expires_at <= now()
    returning booking_id
  ), booking_updated as (
    update public.bookings as b
    set rut_status = 'Gallrat'
    from deleted as d
    where b.id::text = d.booking_id
    returning d.booking_id
  ), logged as (
    insert into public.rut_submission_access_log (
      booking_id,
      admin_user_id,
      action
    )
    select booking_id, null, 'expired_and_purged'
    from deleted
    returning 1
  )
  select count(*)::integer into deleted_count from logged;

  return deleted_count;
end;
$$;

revoke all on function private.purge_expired_rut_submissions()
  from public, anon, authenticated;

-- Supabase projects provide pg_cron. Keep the migration portable by only
-- scheduling when the extension exists on the database server.
do $schedule$
begin
  if exists (
    select 1
    from pg_available_extensions
    where name = 'pg_cron'
  ) then
    execute 'create extension if not exists pg_cron';

    if not exists (
      select 1
      from cron.job
      where jobname = 'purge-expired-rut-submissions'
    ) then
      perform cron.schedule(
        'purge-expired-rut-submissions',
        '23 * * * *',
        'select private.purge_expired_rut_submissions();'
      );
    end if;
  end if;
end;
$schedule$;
