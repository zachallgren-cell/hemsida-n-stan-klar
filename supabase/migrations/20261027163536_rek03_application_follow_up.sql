-- REK-03: only follow-up metadata changes; original answers remain immutable.
alter table public.job_applications
  add column internal_notes text not null default '' check (length(internal_notes) <= 5000),
  add column revision bigint not null default 1,
  add column updated_at timestamptz not null default now(),
  add column assigned_user_id uuid references auth.users(id) on delete set null;
update public.job_applications set status = 'Ny ansökan' where status is null;

create table public.job_application_assignees (
  label text primary key check (label in ('Zacke','Martin')),
  user_id uuid unique references auth.users(id) on delete set null
);
insert into public.job_application_assignees(label, user_id)
select label, (select (array_agg(a.user_id))[1] from public.admin_users a join auth.users u on u.id = a.user_id
  left join public.staff_profiles p on p.user_id = a.user_id
  where lower(coalesce(p.display_name, u.raw_user_meta_data->>'full_name', u.raw_user_meta_data->>'name', split_part(u.email,'@',1)))
    ~ case when label = 'Martin' then '^martin' else '^(zac|zack)' end
  having count(*) = 1)
from (values ('Zacke'),('Martin')) as people(label);

create table public.job_application_status_history (
  id uuid primary key default gen_random_uuid(),
  application_id uuid not null references public.job_applications(id) on delete cascade,
  changed_at timestamptz not null default now(),
  changed_by uuid references auth.users(id) on delete set null,
  changed_by_label text not null,
  previous_status text not null,
  status text not null,
  revision bigint not null,
  unique(application_id, revision)
);
create index job_application_history_date_idx on public.job_application_status_history(application_id, changed_at desc);
alter table public.job_application_assignees enable row level security;
alter table public.job_application_status_history enable row level security;
revoke all on public.job_application_assignees, public.job_application_status_history from public, anon, authenticated;
grant select on public.job_application_assignees, public.job_application_status_history to authenticated;
create policy job_assignees_admin_read on public.job_application_assignees
  for select to authenticated using (private.is_booking_admin());
create policy job_history_admin_read on public.job_application_status_history
  for select to authenticated using (private.is_booking_admin());
-- Revoke both table and older column grants: all writes must use the guarded RPC.
revoke update on public.job_applications from authenticated;
revoke update(status, next_step, responsible, follow_up_date) on public.job_applications from authenticated;
drop policy job_applications_admin_update on public.job_applications;

create function public.recruitment_save_application(
  p_id uuid, p_revision bigint, p_status text, p_responsible text,
  p_next_step text, p_follow_up_date text, p_internal_notes text
) returns public.job_applications
language plpgsql security definer
set search_path = pg_catalog, public, auth, private
as $$
declare
  original public.job_applications;
  saved public.job_applications;
  follow_date date;
  actor_label text;
  responsible_id uuid;
begin
  if not private.is_booking_admin() then
    raise exception 'Behörig administratör med tvåstegsverifiering krävs.' using errcode = '42501';
  end if;
  if p_status is null or p_status not in ('Ny ansökan','Behöver kompletteras','Intervju','Praktiskt urval','Erbjudande','Anställd','Reserv','Nej') then
    raise exception 'Välj en giltig status.';
  end if;
  if p_responsible is null or p_responsible not in ('','Zacke','Martin') then
    raise exception 'Välj Zacke, Martin eller Ej tilldelad.';
  end if;
  if p_next_step is null or length(p_next_step) > 2000 or p_internal_notes is null or length(p_internal_notes) > 5000
    or p_next_step ~ '[\x01-\x08\x0B\x0C\x0E-\x1F\x7F]' or p_internal_notes ~ '[\x01-\x08\x0B\x0C\x0E-\x1F\x7F]' then
    raise exception 'Nästa steg får ha högst 2 000 tecken och anteckningar högst 5 000 tecken.';
  end if;
  if coalesce(p_follow_up_date, '') <> '' then
    if p_follow_up_date !~ '^\d{4}-\d{2}-\d{2}$' then raise exception 'Ange ett giltigt uppföljningsdatum.'; end if;
    begin follow_date := p_follow_up_date::date;
    exception when others then raise exception 'Ange ett giltigt uppföljningsdatum.'; end;
    if follow_date < date '1900-01-01' or follow_date > date '2100-12-31' then raise exception 'Datumet måste ligga mellan 1900 och 2100.'; end if;
  end if;
  select * into original from public.job_applications where id = p_id for update;
  if not found then raise exception 'Ansökan finns inte längre.'; end if;
  if p_revision is null or original.revision <> p_revision then
    raise exception 'En annan administratör har ändrat ansökan. Dina ändringar har inte sparats. Läs den senaste versionen innan du försöker igen.' using errcode = '40001';
  end if;
  select user_id into responsible_id from public.job_application_assignees where label = p_responsible;
  if responsible_id is not null and not exists (select 1 from public.admin_users where user_id = responsible_id) then
    raise exception 'Den ansvariges kontokoppling behöver uppdateras.';
  end if;
  update public.job_applications set
    status = p_status, responsible = p_responsible, assigned_user_id = responsible_id,
    next_step = btrim(p_next_step), follow_up_date = follow_date, internal_notes = btrim(p_internal_notes),
    revision = revision + 1, updated_at = clock_timestamp()
    where id = p_id returning * into saved;
  if coalesce(original.status, 'Ny ansökan') <> saved.status then
    select coalesce((select label from public.job_application_assignees where user_id = auth.uid()),
      p.display_name, u.raw_user_meta_data->>'full_name', u.raw_user_meta_data->>'name', split_part(u.email,'@',1), 'Administratör')
      into actor_label from auth.users u left join public.staff_profiles p on p.user_id = u.id where u.id = auth.uid();
    insert into public.job_application_status_history(application_id, changed_by, changed_by_label, previous_status, status, revision)
      values (saved.id, auth.uid(), coalesce(actor_label,'Administratör'), coalesce(original.status,'Ny ansökan'), saved.status, saved.revision);
  end if;
  return saved;
end $$;
revoke all on function public.recruitment_save_application(uuid,bigint,text,text,text,text,text) from public, anon;
grant execute on function public.recruitment_save_application(uuid,bigint,text,text,text,text,text) to authenticated;
