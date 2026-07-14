-- Final privilege hardening kept in its own migration because the preceding
-- follow-up has already been applied remotely.

-- Every browser-side admin policy uses this function. Require both an AAL2
-- JWT and a currently verified factor, in addition to the explicit allowlist.
create or replace function private.is_booking_admin()
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public, auth
as $$
  select
    (auth.jwt() ->> 'aal') = 'aal2'
    and exists (
      select 1
      from public.admin_users
      where user_id = auth.uid()
    )
    and exists (
      select 1
      from auth.mfa_factors
      where user_id = auth.uid()
        and status = 'verified'
    );
$$;

revoke all on function private.is_booking_admin()
  from public, anon;
grant execute on function private.is_booking_admin()
  to authenticated;

-- Do not leave an RLS policy in place that could become active again after a
-- future broad UPDATE grant. All booking mutations now use controlled server
-- functions with the service role.
drop policy if exists "authenticated can update bookings" on public.bookings;
revoke update on table public.bookings from authenticated;

-- Supabase projects may have broad default sequence grants. The browser roles
-- never need direct access to either sensitive sequence.
revoke all on sequence public.rut_submissions_id_seq
  from public, anon, authenticated, service_role;
grant usage, select on sequence public.rut_submissions_id_seq
  to service_role;

revoke all on sequence public.rut_submission_access_log_id_seq
  from public, anon, authenticated, service_role;
grant usage, select on sequence public.rut_submission_access_log_id_seq
  to service_role;

-- Make the audit log append-only for the application service role. Its
-- owner-definer retention function can still delete expired entries.
revoke all on table public.rut_submission_access_log from service_role;
grant select, insert on table public.rut_submission_access_log to service_role;

do $verify$
begin
  if has_table_privilege('authenticated', 'public.bookings', 'UPDATE') then
    raise exception 'authenticated still has UPDATE on public.bookings';
  end if;

  if exists (
    select 1
    from pg_policies
    where schemaname = 'public'
      and tablename = 'bookings'
      and policyname = 'authenticated can update bookings'
  ) then
    raise exception 'The legacy authenticated booking UPDATE policy still exists';
  end if;

  if has_sequence_privilege('anon', 'public.rut_submissions_id_seq', 'USAGE')
    or has_sequence_privilege('authenticated', 'public.rut_submissions_id_seq', 'USAGE')
    or has_sequence_privilege('anon', 'public.rut_submission_access_log_id_seq', 'USAGE')
    or has_sequence_privilege('authenticated', 'public.rut_submission_access_log_id_seq', 'USAGE')
  then
    raise exception 'A browser role still has RUT sequence access';
  end if;

  if has_table_privilege('service_role', 'public.rut_submission_access_log', 'UPDATE')
    or has_table_privilege('service_role', 'public.rut_submission_access_log', 'DELETE')
  then
    raise exception 'The application service role can still rewrite the RUT audit log';
  end if;
end;
$verify$;
