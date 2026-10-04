-- Applications are inserted only by the validation endpoint using the service role.
create table public.job_applications (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null unique,
  created_at timestamptz not null default now(),
  answers jsonb not null check (jsonb_typeof(answers) = 'object'),
  status text not null default 'Ny ansökan'
    check (status in ('Ny ansökan','Behöver kompletteras','Intervju','Praktiskt urval','Erbjudande','Anställd','Reserv','Nej')),
  next_step text not null default '' check (length(next_step) <= 2000),
  responsible text not null default '' check (length(responsible) <= 100),
  follow_up_date date
);
create index job_applications_created_idx on public.job_applications(created_at desc);
alter table public.job_applications enable row level security;
revoke all on table public.job_applications from public, anon, authenticated;
grant select on table public.job_applications to authenticated;
grant update (status, next_step, responsible, follow_up_date) on table public.job_applications to authenticated;
grant select, insert on table public.job_applications to service_role;
-- Existing helper requires the admin allowlist, AAL2 and a verified MFA factor.
create policy job_applications_admin_read on public.job_applications
  for select to authenticated using (private.is_booking_admin());
create policy job_applications_admin_update on public.job_applications
  for update to authenticated using (private.is_booking_admin())
  with check (private.is_booking_admin());
