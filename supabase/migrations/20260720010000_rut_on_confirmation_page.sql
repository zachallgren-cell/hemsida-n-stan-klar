begin;

-- RUT access created from the customer page has its own atomic RPC. The
-- separate admin replacement-link RPC remains available as an explicit admin
-- fallback and is hardened below with the same booking-state rules.
create or replace function public.issue_customer_rut_form_token_hash(
  p_booking_id text,
  p_management_token_hash text,
  p_rut_token_hash text
)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  if p_booking_id is null
    or p_management_token_hash is null
    or p_management_token_hash !~ '^[0-9a-f]{64}$'
    or p_rut_token_hash is null
    or p_rut_token_hash !~ '^[0-9a-f]{64}$'
  then
    return false;
  end if;

  update public.bookings as b
  set
    rut_form_token = null,
    rut_form_token_hash = p_rut_token_hash,
    rut_form_token_expires_at = now() + interval '30 days',
    rut_form_token_used_at = null,
    rut_status = 'Skickat',
    rut_sent_at = now(),
    rut_email_sent = false,
    rut_email_sent_at = null,
    rut_submission_available = false
  where b.id::text = p_booking_id
    and b.management_token_hash = p_management_token_hash
    and b.management_token_expires_at > now()
    and b.email_confirmed_at is not null
    and b.status in ('pending', 'confirmed', 'completed')
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

revoke all on function public.issue_customer_rut_form_token_hash(text, text, text)
  from public, anon, authenticated;
grant execute on function public.issue_customer_rut_form_token_hash(text, text, text)
  to service_role;

comment on function public.issue_customer_rut_form_token_hash(text, text, text) is
  'Issues a hashed one-time RUT form token from a valid management link for an active, email-confirmed RUT booking.';

-- Keep the authenticated admin replacement-link path, but apply the same
-- booking-state invariant atomically so a concurrent cancellation cannot
-- produce a dead link that is reported as sent.
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
    and b.email_confirmed_at is not null
    and b.status in ('pending', 'confirmed', 'completed')
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

-- Recheck the booking state in the same transaction that stores the encrypted
-- personal number. This closes the gap between the Edge Function's validation
-- and a simultaneous cancellation.
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
    and email_confirmed_at is not null
    and status in ('pending', 'confirmed', 'completed')
    and btrim(coalesce(rut_choice, '')) ~* '^ja([[:space:][:punct:]]|$)'
    and rut_form_token_hash = p_token_hash
    and rut_form_token_used_at is null
    and rut_form_token_expires_at > now()
  for update;

  if not found then
    return false;
  end if;

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

commit;
