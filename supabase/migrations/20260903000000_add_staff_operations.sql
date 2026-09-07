-- Staff operations: staffing, checklists, time tracking, commission and job economics.
-- This migration is additive. Staff never receive direct access to public.bookings.

set local search_path = pg_catalog, public, extensions;

create extension if not exists pgcrypto with schema extensions;

create table if not exists public.staff_profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null check (char_length(btrim(display_name)) between 1 and 160),
  email text not null check (char_length(btrim(email)) between 3 and 254),
  phone text,
  role text not null default 'worker' check (role in ('worker', 'supervisor')),
  status text not null default 'active' check (status in ('invited', 'active', 'inactive')),
  skills text[] not null default '{}',
  hired_on date,
  ended_on date,
  invited_by uuid references auth.users(id) on delete set null,
  created_at timestamp with time zone not null default now(),
  updated_at timestamp with time zone not null default now(),
  constraint staff_profiles_employment_dates check (ended_on is null or hired_on is null or ended_on >= hired_on)
);
create unique index if not exists staff_profiles_email_idx on public.staff_profiles (lower(btrim(email)));
create index if not exists staff_profiles_active_idx on public.staff_profiles (status, display_name);

create table if not exists public.checklist_templates (
  id uuid primary key default extensions.gen_random_uuid(),
  name text not null check (char_length(btrim(name)) between 1 and 160),
  description text,
  match_rule text,
  active boolean not null default true,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamp with time zone not null default now(),
  updated_at timestamp with time zone not null default now()
);

create table if not exists public.checklist_template_items (
  id uuid primary key default extensions.gen_random_uuid(),
  template_id uuid not null references public.checklist_templates(id) on delete cascade,
  label text not null check (char_length(btrim(label)) between 1 and 500),
  help_text text,
  required boolean not null default true,
  sort_order integer not null default 0 check (sort_order between 0 and 10000),
  created_at timestamp with time zone not null default now()
);
create index if not exists checklist_template_items_order_idx
  on public.checklist_template_items (template_id, sort_order, created_at);

create table if not exists public.staff_jobs (
  id uuid primary key default extensions.gen_random_uuid(),
  booking_id text not null unique,
  checklist_template_id uuid references public.checklist_templates(id) on delete set null,
  scheduled_start timestamp with time zone not null,
  estimated_minutes integer not null default 180 check (estimated_minutes between 15 and 1440),
  required_staff smallint not null default 1 check (required_staff between 1 and 20),
  claim_release_deadline timestamp with time zone,
  status text not null default 'draft' check (status in ('draft', 'open', 'fully_staffed', 'in_progress', 'completed', 'cancelled')),
  service_label text not null default 'Fönsterputs',
  housing_type text,
  service_scope text,
  window_count text,
  area_label text,
  customer_name text,
  customer_phone text,
  customer_email text,
  address text,
  postal_code text,
  practical_note text,
  price_including_vat_ore bigint not null default 0 check (price_including_vat_ore >= 0),
  vat_basis_points integer not null default 2500 check (vat_basis_points between 0 and 10000),
  commission_base_ex_vat_ore bigint not null default 0 check (commission_base_ex_vat_ore >= 0),
  commission_rate_basis_points integer not null default 2000 check (commission_rate_basis_points between 0 and 10000),
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamp with time zone not null default now(),
  updated_at timestamp with time zone not null default now()
);
create index if not exists staff_jobs_schedule_idx on public.staff_jobs (scheduled_start, status);
create index if not exists staff_jobs_open_idx on public.staff_jobs (scheduled_start) where status = 'open';

create table if not exists public.staff_job_assignments (
  id uuid primary key default extensions.gen_random_uuid(),
  job_id uuid not null references public.staff_jobs(id) on delete cascade,
  staff_user_id uuid not null references public.staff_profiles(user_id) on delete restrict,
  status text not null default 'claimed' check (status in ('claimed', 'assigned', 'completed', 'released')),
  assignment_source text not null default 'staff' check (assignment_source in ('staff', 'admin')),
  assigned_by uuid references auth.users(id) on delete set null,
  assigned_at timestamp with time zone not null default now(),
  released_at timestamp with time zone,
  completed_at timestamp with time zone,
  release_reason text,
  created_at timestamp with time zone not null default now(),
  updated_at timestamp with time zone not null default now()
);
create unique index if not exists staff_job_assignments_one_active_idx
  on public.staff_job_assignments (job_id, staff_user_id)
  where status in ('claimed', 'assigned', 'completed');
create index if not exists staff_job_assignments_staff_idx
  on public.staff_job_assignments (staff_user_id, status, assigned_at desc);

create table if not exists public.staff_job_checklist_items (
  id uuid primary key default extensions.gen_random_uuid(),
  job_id uuid not null references public.staff_jobs(id) on delete cascade,
  source_template_item_id uuid references public.checklist_template_items(id) on delete set null,
  label text not null check (char_length(btrim(label)) between 1 and 500),
  help_text text,
  required boolean not null default true,
  sort_order integer not null default 0,
  completed boolean not null default false,
  completed_by uuid references public.staff_profiles(user_id) on delete set null,
  completed_at timestamp with time zone,
  note text check (note is null or char_length(note) <= 2000),
  created_at timestamp with time zone not null default now(),
  updated_at timestamp with time zone not null default now()
);
create unique index if not exists staff_job_checklist_source_idx
  on public.staff_job_checklist_items (job_id, source_template_item_id)
  where source_template_item_id is not null;
create index if not exists staff_job_checklist_order_idx
  on public.staff_job_checklist_items (job_id, sort_order, created_at);

create table if not exists public.staff_time_entries (
  id uuid primary key default extensions.gen_random_uuid(),
  job_id uuid not null references public.staff_jobs(id) on delete restrict,
  staff_user_id uuid not null references public.staff_profiles(user_id) on delete restrict,
  started_at timestamp with time zone not null default clock_timestamp(),
  ended_at timestamp with time zone,
  stop_reason text check (stop_reason is null or stop_reason in ('pause', 'completed', 'admin_correction')),
  corrected_by uuid references auth.users(id) on delete set null,
  correction_reason text check (correction_reason is null or char_length(btrim(correction_reason)) between 3 and 1000),
  created_at timestamp with time zone not null default now(),
  updated_at timestamp with time zone not null default now(),
  constraint staff_time_entries_order check (ended_at is null or ended_at >= started_at),
  constraint staff_time_entries_correction_reason check (corrected_by is null or correction_reason is not null)
);
create unique index if not exists staff_time_entries_one_running_idx
  on public.staff_time_entries (staff_user_id) where ended_at is null;
create index if not exists staff_time_entries_job_idx
  on public.staff_time_entries (job_id, staff_user_id, started_at);

create table if not exists public.staff_job_commissions (
  id uuid primary key default extensions.gen_random_uuid(),
  job_id uuid not null references public.staff_jobs(id) on delete cascade,
  staff_user_id uuid not null references public.staff_profiles(user_id) on delete restrict,
  commission_base_ex_vat_ore bigint not null check (commission_base_ex_vat_ore >= 0),
  commission_rate_basis_points integer not null check (commission_rate_basis_points between 0 and 10000),
  share_basis_points integer not null check (share_basis_points between 0 and 10000),
  amount_ore bigint not null check (amount_ore >= 0),
  worked_seconds bigint not null default 0 check (worked_seconds >= 0),
  status text not null default 'estimated' check (status in ('estimated', 'earned', 'approved', 'paid', 'reversed')),
  approved_by uuid references auth.users(id) on delete set null,
  approved_at timestamp with time zone,
  paid_at timestamp with time zone,
  adjustment_reason text,
  created_at timestamp with time zone not null default now(),
  updated_at timestamp with time zone not null default now(),
  unique (job_id, staff_user_id)
);
create index if not exists staff_job_commissions_staff_idx
  on public.staff_job_commissions (staff_user_id, status, created_at desc);

create table if not exists public.staff_job_costs (
  id uuid primary key default extensions.gen_random_uuid(),
  job_id uuid not null references public.staff_jobs(id) on delete cascade,
  category text not null check (category in ('material', 'transport', 'payroll_oncost', 'equipment', 'subcontractor', 'rework', 'overhead', 'other')),
  amount_ex_vat_ore bigint not null default 0 check (amount_ex_vat_ore >= 0),
  note text check (note is null or char_length(note) <= 1000),
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamp with time zone not null default now(),
  updated_at timestamp with time zone not null default now()
);
create unique index if not exists staff_job_costs_job_category_idx on public.staff_job_costs (job_id, category);

create table if not exists public.staff_job_events (
  id bigint generated by default as identity primary key,
  job_id uuid not null references public.staff_jobs(id) on delete cascade,
  actor_user_id uuid references auth.users(id) on delete set null,
  event_type text not null,
  summary text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamp with time zone not null default now()
);
create index if not exists staff_job_events_job_idx on public.staff_job_events (job_id, created_at desc);

create or replace function private.is_active_staff()
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select exists (
    select 1 from public.staff_profiles
    where user_id = auth.uid() and status = 'active'
  );
$$;
revoke all on function private.is_active_staff() from public, anon, authenticated;

create or replace function private.is_booking_admin_aal2()
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select private.is_booking_admin()
    and coalesce(auth.jwt() ->> 'aal', '') = 'aal2';
$$;
revoke all on function private.is_booking_admin_aal2() from public, anon, authenticated;

create or replace function private.set_staff_operations_updated_at()
returns trigger
language plpgsql
set search_path = pg_catalog
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;
revoke all on function private.set_staff_operations_updated_at() from public, anon, authenticated;

do $triggers$
declare
  table_name text;
  trigger_name text;
begin
  foreach table_name in array array[
    'staff_profiles', 'checklist_templates', 'staff_jobs', 'staff_job_assignments',
    'staff_job_checklist_items', 'staff_time_entries', 'staff_job_commissions', 'staff_job_costs'
  ]
  loop
    trigger_name := 'set_' || table_name || '_updated_at';
    execute format('drop trigger if exists %I on public.%I', trigger_name, table_name);
    execute format('create trigger %I before update on public.%I for each row execute function private.set_staff_operations_updated_at()', trigger_name, table_name);
  end loop;
end;
$triggers$;

create or replace function private.snapshot_staff_job_checklist(p_job_id uuid)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  template_id uuid;
begin
  select checklist_template_id into template_id
  from public.staff_jobs where id = p_job_id;

  if template_id is null then
    return;
  end if;

  insert into public.staff_job_checklist_items (
    job_id, source_template_item_id, label, help_text, required, sort_order
  )
  select p_job_id, item.id, item.label, item.help_text, item.required, item.sort_order
  from public.checklist_template_items item
  where item.template_id = template_id
  order by item.sort_order, item.created_at
  on conflict (job_id, source_template_item_id) where source_template_item_id is not null do nothing;
end;
$$;
revoke all on function private.snapshot_staff_job_checklist(uuid) from public, anon, authenticated;

create or replace function private.recalculate_staff_job_commissions(p_job_id uuid)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  job_row public.staff_jobs%rowtype;
  pool_ore bigint;
begin
  select * into job_row from public.staff_jobs where id = p_job_id;
  if not found then return; end if;

  pool_ore := round(
    job_row.commission_base_ex_vat_ore::numeric
    * job_row.commission_rate_basis_points::numeric / 10000
  )::bigint;

  update public.staff_job_commissions commission
  set status = 'reversed', amount_ore = 0, worked_seconds = 0, updated_at = now()
  where commission.job_id = p_job_id
    and commission.status not in ('approved', 'paid')
    and not exists (
      select 1 from public.staff_job_assignments assignment
      where assignment.job_id = p_job_id
        and assignment.staff_user_id = commission.staff_user_id
        and assignment.status in ('claimed', 'assigned', 'completed')
    );

  with participants as (
    select
      assignment.staff_user_id,
      coalesce(sum(greatest(0, extract(epoch from (coalesce(entry.ended_at, clock_timestamp()) - entry.started_at))))::bigint, 0) as worked_seconds
    from public.staff_job_assignments assignment
    left join public.staff_time_entries entry
      on entry.job_id = assignment.job_id and entry.staff_user_id = assignment.staff_user_id
    where assignment.job_id = p_job_id
      and assignment.status in ('claimed', 'assigned', 'completed')
    group by assignment.staff_user_id
  ), weights as (
    select
      participant.*,
      case when sum(worked_seconds) over () > 0 then worked_seconds else 1 end as weight,
      case when sum(worked_seconds) over () > 0 then sum(worked_seconds) over () else count(*) over () end as total_weight
    from participants participant
  ), provisional as (
    select
      weights.*,
      floor(pool_ore::numeric * weight / nullif(total_weight, 0))::bigint as base_amount,
      row_number() over (order by staff_user_id) as position
    from weights
  ), allocated as (
    select
      provisional.*,
      pool_ore - sum(base_amount) over () as remainder,
      round(10000::numeric * weight / nullif(total_weight, 0))::integer as share_bp
    from provisional
  )
  insert into public.staff_job_commissions (
    job_id, staff_user_id, commission_base_ex_vat_ore,
    commission_rate_basis_points, share_basis_points, amount_ore,
    worked_seconds, status
  )
  select
    p_job_id,
    allocated.staff_user_id,
    job_row.commission_base_ex_vat_ore,
    job_row.commission_rate_basis_points,
    least(10000, greatest(0, allocated.share_bp)),
    allocated.base_amount + case when allocated.position <= allocated.remainder then 1 else 0 end,
    allocated.worked_seconds,
    case when job_row.status = 'completed' then 'earned' else 'estimated' end
  from allocated
  on conflict (job_id, staff_user_id) do update set
    commission_base_ex_vat_ore = case when public.staff_job_commissions.status in ('approved', 'paid') then public.staff_job_commissions.commission_base_ex_vat_ore else excluded.commission_base_ex_vat_ore end,
    commission_rate_basis_points = case when public.staff_job_commissions.status in ('approved', 'paid') then public.staff_job_commissions.commission_rate_basis_points else excluded.commission_rate_basis_points end,
    share_basis_points = case when public.staff_job_commissions.status in ('approved', 'paid') then public.staff_job_commissions.share_basis_points else excluded.share_basis_points end,
    amount_ore = case when public.staff_job_commissions.status in ('approved', 'paid') then public.staff_job_commissions.amount_ore else excluded.amount_ore end,
    worked_seconds = case when public.staff_job_commissions.status in ('approved', 'paid') then public.staff_job_commissions.worked_seconds else excluded.worked_seconds end,
    status = case when public.staff_job_commissions.status in ('approved', 'paid') then public.staff_job_commissions.status else excluded.status end,
    updated_at = now();
end;
$$;
revoke all on function private.recalculate_staff_job_commissions(uuid) from public, anon, authenticated;

create or replace function private.refresh_staff_job_after_change()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  target_job_id uuid;
  active_count integer;
  completed_count integer;
  required_count integer;
  current_status text;
begin
  if tg_op = 'DELETE' then target_job_id := old.job_id; else target_job_id := new.job_id; end if;
  select required_staff, status into required_count, current_status
  from public.staff_jobs where id = target_job_id for update;

  select
    count(*) filter (where status in ('claimed', 'assigned', 'completed')),
    count(*) filter (where status = 'completed')
  into active_count, completed_count
  from public.staff_job_assignments where job_id = target_job_id;

  if current_status not in ('draft', 'in_progress', 'completed', 'cancelled') then
    update public.staff_jobs
    set status = case when active_count >= required_count then 'fully_staffed' else 'open' end
    where id = target_job_id;
  elsif current_status = 'in_progress' and active_count >= required_count and completed_count = active_count then
    update public.staff_jobs set status = 'completed' where id = target_job_id;
  end if;

  perform private.recalculate_staff_job_commissions(target_job_id);
  if tg_op = 'DELETE' then return old; else return new; end if;
end;
$$;
revoke all on function private.refresh_staff_job_after_change() from public, anon, authenticated;

drop trigger if exists refresh_staff_job_after_assignment on public.staff_job_assignments;
create trigger refresh_staff_job_after_assignment
after insert or update or delete on public.staff_job_assignments
for each row execute function private.refresh_staff_job_after_change();

drop trigger if exists refresh_staff_job_after_time on public.staff_time_entries;
create trigger refresh_staff_job_after_time
after insert or update or delete on public.staff_time_entries
for each row execute function private.refresh_staff_job_after_change();

create or replace function public.admin_upsert_staff_job_from_booking(
  p_booking_id text,
  p_scheduled_start timestamp with time zone default null,
  p_estimated_minutes integer default 180,
  p_required_staff integer default 1,
  p_checklist_template_id uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog, public, extensions
as $$
declare
  booking_record record;
  target_job_id uuid;
  gross_ore bigint;
  target_start timestamp with time zone;
begin
  if not private.is_booking_admin_aal2() then raise exception 'Admin AAL2 required'; end if;
  if p_booking_id is null or btrim(p_booking_id) = '' then raise exception 'Booking id required'; end if;
  if p_estimated_minutes not between 15 and 1440 then raise exception 'Invalid estimated minutes'; end if;
  if p_required_staff not between 1 and 20 then raise exception 'Invalid required staff'; end if;

  select * into booking_record from public.bookings where id::text = p_booking_id limit 1;
  if not found then raise exception 'Booking not found'; end if;
  if lower(coalesce(booking_record.status::text, '')) in ('cancelled', 'expired', 'awaiting_confirmation') then
    raise exception 'Booking is not ready for staffing';
  end if;

  target_start := coalesce(
    p_scheduled_start,
    (booking_record.booking_date::date + coalesce(booking_record.booking_time::time, time '09:00')) at time zone 'Europe/Stockholm'
  );
  gross_ore := greatest(0, round(coalesce(
    booking_record.price_before_rut::numeric,
    case when booking_record.labor_cost_before_rut is not null
      then booking_record.labor_cost_before_rut::numeric
        + coalesce(booking_record.material_cost, 0)::numeric
        + coalesce(booking_record.transport_cost, 0)::numeric
      else null end,
    nullif(booking_record.price::text, '')::numeric,
    0
  ) * 100)::bigint);

  insert into public.staff_jobs (
    booking_id, checklist_template_id, scheduled_start, estimated_minutes, required_staff,
    claim_release_deadline, status, service_label, housing_type, service_scope,
    window_count, area_label, customer_name, customer_phone, customer_email,
    address, postal_code, practical_note, price_including_vat_ore,
    commission_base_ex_vat_ore, commission_rate_basis_points, created_by
  ) values (
    p_booking_id, p_checklist_template_id, target_start, p_estimated_minutes, p_required_staff,
    target_start - interval '24 hours', 'open',
    coalesce(nullif(concat_ws(' · ', booking_record.service_scope, booking_record.housing_type), ''), 'Fönsterputs'),
    booking_record.housing_type, booking_record.service_scope, booking_record.window_count,
    coalesce(booking_record.postal_code, 'Område ej angivet'), booking_record.customer_name,
    booking_record.phone, booking_record.email, booking_record.address, booking_record.postal_code,
    booking_record.internal_note, gross_ore,
    round(gross_ore::numeric * 10000 / 12500)::bigint, 2000, auth.uid()
  )
  on conflict (booking_id) do update set
    checklist_template_id = coalesce(excluded.checklist_template_id, public.staff_jobs.checklist_template_id),
    scheduled_start = excluded.scheduled_start,
    estimated_minutes = excluded.estimated_minutes,
    required_staff = excluded.required_staff,
    claim_release_deadline = excluded.claim_release_deadline,
    service_label = excluded.service_label,
    housing_type = excluded.housing_type,
    service_scope = excluded.service_scope,
    window_count = excluded.window_count,
    area_label = excluded.area_label,
    customer_name = excluded.customer_name,
    customer_phone = excluded.customer_phone,
    customer_email = excluded.customer_email,
    address = excluded.address,
    postal_code = excluded.postal_code,
    practical_note = excluded.practical_note,
    price_including_vat_ore = excluded.price_including_vat_ore,
    commission_base_ex_vat_ore = excluded.commission_base_ex_vat_ore,
    updated_at = now()
  returning id into target_job_id;

  perform private.snapshot_staff_job_checklist(target_job_id);
  perform private.recalculate_staff_job_commissions(target_job_id);
  insert into public.staff_job_events (job_id, actor_user_id, event_type, summary)
  values (target_job_id, auth.uid(), 'job_synced', 'Passet skapades eller uppdaterades från bokningen.');
  return target_job_id;
end;
$$;

create or replace function private.sync_staff_job_from_booking_change()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  target_booking_id text;
  target_job_id uuid;
  gross_ore bigint;
  cancelled boolean;
begin
  if tg_op = 'DELETE' then
    target_booking_id := old.id::text;
    cancelled := true;
  else
    target_booking_id := new.id::text;
    cancelled := lower(coalesce(new.status::text, '')) in ('cancelled', 'expired');
  end if;
  select id into target_job_id from public.staff_jobs where booking_id = target_booking_id;
  if target_job_id is null then
    if tg_op = 'DELETE' then return old; else return new; end if;
  end if;
  if cancelled then
    update public.staff_time_entries set
      ended_at = clock_timestamp(), stop_reason = 'admin_correction',
      correction_reason = 'Kundbokningen avbröts'
    where job_id = target_job_id and ended_at is null;
    update public.staff_job_assignments set
      status = 'released', released_at = now(), release_reason = 'Kundbokningen avbröts'
    where job_id = target_job_id and status in ('claimed', 'assigned');
    update public.staff_jobs set status = 'cancelled' where id = target_job_id;
    insert into public.staff_job_events (job_id, event_type, summary)
    values (target_job_id, 'booking_cancelled', 'Personalpasset avbröts eftersom kundbokningen avbröts.');
  else
    gross_ore := greatest(0, round(coalesce(
      new.price_before_rut::numeric,
      case when new.labor_cost_before_rut is not null
        then new.labor_cost_before_rut::numeric
          + coalesce(new.material_cost, 0)::numeric
          + coalesce(new.transport_cost, 0)::numeric
        else null end,
      nullif(new.price::text, '')::numeric,
      0
    ) * 100)::bigint);
    update public.staff_jobs set
      scheduled_start = (new.booking_date::date + coalesce(new.booking_time::time, time '09:00')) at time zone 'Europe/Stockholm',
      claim_release_deadline = ((new.booking_date::date + coalesce(new.booking_time::time, time '09:00')) at time zone 'Europe/Stockholm') - interval '24 hours',
      service_label = coalesce(nullif(concat_ws(' · ', new.service_scope, new.housing_type), ''), 'Fönsterputs'),
      housing_type = new.housing_type,
      service_scope = new.service_scope,
      window_count = new.window_count,
      area_label = coalesce(new.postal_code, 'Område ej angivet'),
      customer_name = new.customer_name,
      customer_phone = new.phone,
      customer_email = new.email,
      address = new.address,
      postal_code = new.postal_code,
      practical_note = new.internal_note,
      price_including_vat_ore = gross_ore,
      commission_base_ex_vat_ore = round(gross_ore::numeric * 10000 / 12500)::bigint
    where id = target_job_id;
  end if;
  perform private.recalculate_staff_job_commissions(target_job_id);
  if tg_op = 'DELETE' then return old; else return new; end if;
end;
$$;
revoke all on function private.sync_staff_job_from_booking_change() from public, anon, authenticated;

drop trigger if exists sync_staff_job_after_booking_update on public.bookings;
create trigger sync_staff_job_after_booking_update
after update of booking_date, booking_time, status, price, price_before_rut,
  labor_cost_before_rut, material_cost, transport_cost, customer_name, phone,
  email, address, postal_code, service_scope, housing_type, window_count, internal_note
on public.bookings
for each row execute function private.sync_staff_job_from_booking_change();

drop trigger if exists cancel_staff_job_after_booking_delete on public.bookings;
create trigger cancel_staff_job_after_booking_delete
after delete on public.bookings
for each row execute function private.sync_staff_job_from_booking_change();

create or replace function public.admin_assign_staff_job(p_job_id uuid, p_staff_user_id uuid)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  job_record public.staff_jobs%rowtype;
  assigned_count integer;
begin
  if not private.is_booking_admin_aal2() then raise exception 'Admin AAL2 required'; end if;
  select * into job_record from public.staff_jobs where id = p_job_id for update;
  if not found or job_record.status in ('completed', 'cancelled') then raise exception 'Job cannot be assigned'; end if;
  if not exists (select 1 from public.staff_profiles where user_id = p_staff_user_id and status = 'active') then
    raise exception 'Staff member is not active';
  end if;
  select count(*) into assigned_count from public.staff_job_assignments
  where job_id = p_job_id and status in ('claimed', 'assigned', 'completed');
  if assigned_count >= job_record.required_staff then raise exception 'Job is fully staffed'; end if;

  insert into public.staff_job_assignments (job_id, staff_user_id, status, assignment_source, assigned_by)
  values (p_job_id, p_staff_user_id, 'assigned', 'admin', auth.uid());
  insert into public.staff_job_events (job_id, actor_user_id, event_type, summary, metadata)
  values (p_job_id, auth.uid(), 'staff_assigned', 'Admin tilldelade personal.', jsonb_build_object('staffUserId', p_staff_user_id));
end;
$$;

create or replace function public.admin_release_staff_job(p_job_id uuid, p_staff_user_id uuid, p_reason text default 'Ändrad bemanning')
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  if not private.is_booking_admin_aal2() then raise exception 'Admin AAL2 required'; end if;
  if exists (
    select 1 from public.staff_time_entries
    where job_id = p_job_id and staff_user_id = p_staff_user_id and ended_at is null
  ) then raise exception 'Pausa den aktiva timern innan bemanningen ändras'; end if;
  update public.staff_job_assignments
  set status = 'released', released_at = now(), release_reason = left(coalesce(nullif(btrim(p_reason), ''), 'Ändrad bemanning'), 1000)
  where job_id = p_job_id and staff_user_id = p_staff_user_id and status in ('claimed', 'assigned');
  if not found then raise exception 'Active assignment not found'; end if;
  insert into public.staff_job_events (job_id, actor_user_id, event_type, summary, metadata)
  values (p_job_id, auth.uid(), 'staff_released', 'Admin tog bort personal från passet.', jsonb_build_object('staffUserId', p_staff_user_id));
end;
$$;

create or replace function public.admin_set_staff_job_status(p_job_id uuid, p_status text)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  if not private.is_booking_admin_aal2() then raise exception 'Admin AAL2 required'; end if;
  if p_status not in ('draft', 'open', 'fully_staffed', 'in_progress', 'completed', 'cancelled') then raise exception 'Invalid status'; end if;
  if p_status = 'completed' and exists (
    select 1 from public.staff_time_entries where job_id = p_job_id and ended_at is null
  ) then raise exception 'Stoppa aktiva timers innan passet slutförs'; end if;
  if p_status = 'cancelled' then
    update public.staff_time_entries set
      ended_at = clock_timestamp(),
      stop_reason = 'admin_correction',
      corrected_by = auth.uid(),
      correction_reason = 'Passet avbröts av admin'
    where job_id = p_job_id and ended_at is null;
    update public.staff_job_assignments set
      status = 'released', released_at = now(), release_reason = 'Passet avbröts av admin'
    where job_id = p_job_id and status in ('claimed', 'assigned');
  end if;
  update public.staff_jobs set status = p_status where id = p_job_id;
  if not found then raise exception 'Job not found'; end if;
  perform private.recalculate_staff_job_commissions(p_job_id);
  insert into public.staff_job_events (job_id, actor_user_id, event_type, summary, metadata)
  values (p_job_id, auth.uid(), 'job_status_changed', 'Admin ändrade passets status.', jsonb_build_object('status', p_status));
end;
$$;

create or replace function public.admin_set_staff_commission_status(p_commission_id uuid, p_status text)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  if not private.is_booking_admin_aal2() then raise exception 'Admin AAL2 required'; end if;
  if p_status not in ('approved', 'paid') then raise exception 'Invalid commission status'; end if;
  update public.staff_job_commissions set
    status = p_status,
    approved_by = case when p_status = 'approved' then auth.uid() else approved_by end,
    approved_at = case when p_status = 'approved' then now() else approved_at end,
    paid_at = case when p_status = 'paid' then now() else paid_at end
  where id = p_commission_id and status in ('earned', 'approved');
  if not found then raise exception 'Commission cannot change to that status'; end if;
end;
$$;

create or replace function public.admin_create_staff_checklist_template(
  p_name text,
  p_description text,
  p_match_rule text,
  p_items jsonb
)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog, public, extensions
as $$
declare
  template_id uuid;
  item jsonb;
  item_position integer := 0;
begin
  if not private.is_booking_admin_aal2() then raise exception 'Admin AAL2 required'; end if;
  if char_length(btrim(coalesce(p_name, ''))) not between 1 and 160 then raise exception 'Ange ett namn på checklistan'; end if;
  if jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) < 1 or jsonb_array_length(p_items) > 100 then
    raise exception 'Checklistan måste innehålla 1–100 punkter';
  end if;

  insert into public.checklist_templates (name, description, match_rule, created_by)
  values (btrim(p_name), nullif(btrim(coalesce(p_description, '')), ''), nullif(btrim(coalesce(p_match_rule, '')), ''), auth.uid())
  returning id into template_id;

  for item in select value from jsonb_array_elements(p_items)
  loop
    item_position := item_position + 1;
    if char_length(btrim(coalesce(item ->> 'label', ''))) not between 1 and 500 then
      raise exception 'En checklistpunkt har ogiltig längd';
    end if;
    insert into public.checklist_template_items (template_id, label, help_text, required, sort_order)
    values (
      template_id,
      btrim(item ->> 'label'),
      nullif(btrim(coalesce(item ->> 'helpText', '')), ''),
      coalesce((item ->> 'required')::boolean, true),
      item_position * 10
    );
  end loop;
  return template_id;
end;
$$;

create or replace function public.admin_upsert_staff_job_costs(p_job_id uuid, p_costs jsonb)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public, extensions
as $$
declare
  cost jsonb;
  cost_category text;
  cost_amount bigint;
begin
  if not private.is_booking_admin_aal2() then raise exception 'Admin AAL2 required'; end if;
  if not exists (select 1 from public.staff_jobs where id = p_job_id) then raise exception 'Job not found'; end if;
  if jsonb_typeof(p_costs) <> 'array' or jsonb_array_length(p_costs) > 20 then raise exception 'Invalid costs'; end if;
  for cost in select value from jsonb_array_elements(p_costs)
  loop
    cost_category := cost ->> 'category';
    cost_amount := coalesce((cost ->> 'amountExVatOre')::bigint, 0);
    if cost_category not in ('material', 'transport', 'payroll_oncost', 'equipment', 'subcontractor', 'rework', 'overhead', 'other') then
      raise exception 'Invalid cost category';
    end if;
    if cost_amount < 0 then raise exception 'Cost cannot be negative'; end if;
    insert into public.staff_job_costs (job_id, category, amount_ex_vat_ore, note, created_by)
    values (p_job_id, cost_category, cost_amount, nullif(btrim(coalesce(cost ->> 'note', '')), ''), auth.uid())
    on conflict (job_id, category) do update set
      amount_ex_vat_ore = excluded.amount_ex_vat_ore,
      note = excluded.note,
      updated_at = now();
  end loop;
  insert into public.staff_job_events (job_id, actor_user_id, event_type, summary)
  values (p_job_id, auth.uid(), 'job_costs_updated', 'Admin uppdaterade jobbets direkta kostnader.');
end;
$$;

create or replace function public.admin_correct_staff_time_entry(
  p_entry_id uuid,
  p_started_at timestamp with time zone,
  p_ended_at timestamp with time zone,
  p_reason text
)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  target_job_id uuid;
begin
  if not private.is_booking_admin_aal2() then raise exception 'Admin AAL2 required'; end if;
  if p_ended_at is null or p_started_at is null or p_ended_at < p_started_at then raise exception 'Ogiltigt tidsintervall'; end if;
  if char_length(btrim(coalesce(p_reason, ''))) not between 3 and 1000 then raise exception 'Ange en orsak till rättelsen'; end if;
  update public.staff_time_entries set
    started_at = p_started_at,
    ended_at = p_ended_at,
    stop_reason = 'admin_correction',
    corrected_by = auth.uid(),
    correction_reason = btrim(p_reason)
  where id = p_entry_id returning job_id into target_job_id;
  if target_job_id is null then raise exception 'Tidsraden hittades inte'; end if;
  insert into public.staff_job_events (job_id, actor_user_id, event_type, summary, metadata)
  values (target_job_id, auth.uid(), 'time_corrected', 'Admin rättade en tidsrad.', jsonb_build_object('entryId', p_entry_id, 'reason', btrim(p_reason)));
end;
$$;

create or replace function public.staff_get_me()
returns jsonb
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select case when profile.user_id is null then null else jsonb_build_object(
    'userId', profile.user_id,
    'displayName', profile.display_name,
    'email', profile.email,
    'phone', profile.phone,
    'role', profile.role,
    'status', profile.status,
    'skills', profile.skills
  ) end
  from (select auth.uid() as user_id) current_user_id
  left join public.staff_profiles profile on profile.user_id = current_user_id.user_id;
$$;

create or replace function public.staff_activate_me()
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  token_email text := lower(coalesce(auth.jwt() ->> 'email', ''));
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  update public.staff_profiles
  set status = 'active', hired_on = coalesce(hired_on, current_date), ended_on = null
  where user_id = auth.uid()
    and status = 'invited'
    and lower(btrim(email)) = token_email;
end;
$$;

create or replace function public.staff_list_jobs()
returns table (
  id uuid,
  scheduled_start timestamp with time zone,
  estimated_minutes integer,
  required_staff smallint,
  claimed_staff bigint,
  status text,
  service_label text,
  area_label text,
  estimated_commission_ore bigint,
  my_assignment_status text,
  my_commission_ore bigint,
  my_worked_seconds bigint
)
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
begin
  if not private.is_active_staff() then raise exception 'Active staff account required'; end if;
  return query
  select
    job.id, job.scheduled_start, job.estimated_minutes, job.required_staff,
    (select count(*) from public.staff_job_assignments all_assignments where all_assignments.job_id = job.id and all_assignments.status in ('claimed', 'assigned', 'completed')),
    job.status, job.service_label, job.area_label,
    coalesce(commission.amount_ore, round(job.commission_base_ex_vat_ore::numeric * job.commission_rate_basis_points / 10000 / greatest(job.required_staff, 1))::bigint),
    assignment.status,
    commission.amount_ore,
    coalesce(commission.worked_seconds, 0)
  from public.staff_jobs job
  left join public.staff_job_assignments assignment
    on assignment.job_id = job.id and assignment.staff_user_id = auth.uid() and assignment.status in ('claimed', 'assigned', 'completed')
  left join public.staff_job_commissions commission
    on commission.job_id = job.id and commission.staff_user_id = auth.uid()
  where (job.status in ('open', 'in_progress')
      and job.scheduled_start >= now() - interval '8 hours'
      and (select count(*) from public.staff_job_assignments open_assignments where open_assignments.job_id = job.id and open_assignments.status in ('claimed', 'assigned', 'completed')) < job.required_staff)
     or assignment.id is not null
  order by job.scheduled_start;
end;
$$;

create or replace function public.staff_get_job(p_job_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
declare
  job_record public.staff_jobs%rowtype;
  assignment_record public.staff_job_assignments%rowtype;
  has_assignment boolean := false;
begin
  if not private.is_active_staff() then raise exception 'Active staff account required'; end if;
  select * into job_record from public.staff_jobs where id = p_job_id;
  if not found then raise exception 'Job not found'; end if;
  select * into assignment_record from public.staff_job_assignments
  where job_id = p_job_id and staff_user_id = auth.uid() and status in ('claimed', 'assigned', 'completed') limit 1;
  has_assignment := found;
  if not has_assignment and job_record.status not in ('open', 'in_progress') then raise exception 'Job is not available'; end if;
  if not has_assignment and (
    select count(*) from public.staff_job_assignments
    where job_id = p_job_id and status in ('claimed', 'assigned', 'completed')
  ) >= job_record.required_staff then raise exception 'Passet är redan fullbemannat'; end if;

  return jsonb_build_object(
    'id', job_record.id,
    'scheduledStart', job_record.scheduled_start,
    'estimatedMinutes', job_record.estimated_minutes,
    'requiredStaff', job_record.required_staff,
    'status', job_record.status,
    'serviceLabel', job_record.service_label,
    'housingType', job_record.housing_type,
    'serviceScope', job_record.service_scope,
    'windowCount', job_record.window_count,
    'areaLabel', job_record.area_label,
    'claimReleaseDeadline', job_record.claim_release_deadline,
    'assigned', has_assignment,
    'assignmentStatus', case when has_assignment then assignment_record.status else null end,
    'customerName', case when has_assignment then job_record.customer_name else null end,
    'customerPhone', case when has_assignment then job_record.customer_phone else null end,
    'address', case when has_assignment then job_record.address else null end,
    'postalCode', case when has_assignment then job_record.postal_code else null end,
    'practicalNote', case when has_assignment then job_record.practical_note else null end,
    'estimatedCommissionOre', coalesce(
      (select amount_ore from public.staff_job_commissions where job_id = p_job_id and staff_user_id = auth.uid()),
      round(job_record.commission_base_ex_vat_ore::numeric * job_record.commission_rate_basis_points / 10000 / greatest(job_record.required_staff, 1))::bigint
    ),
    'commission', case when has_assignment then (
      select to_jsonb(commission) - 'commission_base_ex_vat_ore'
      from public.staff_job_commissions commission
      where commission.job_id = p_job_id and commission.staff_user_id = auth.uid()
    ) else null end,
    'checklist', case when has_assignment then coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', item.id, 'label', item.label, 'helpText', item.help_text,
        'required', item.required, 'sortOrder', item.sort_order,
        'completed', item.completed, 'completedAt', item.completed_at, 'note', item.note
      ) order by item.sort_order, item.created_at)
      from public.staff_job_checklist_items item where item.job_id = p_job_id
    ), '[]'::jsonb) else '[]'::jsonb end,
    'activeTimer', case when has_assignment then (
      select jsonb_build_object('id', entry.id, 'jobId', entry.job_id, 'startedAt', entry.started_at)
      from public.staff_time_entries entry
      where entry.staff_user_id = auth.uid() and entry.ended_at is null limit 1
    ) else null end,
    'workedSeconds', case when has_assignment then coalesce((
      select sum(greatest(0, extract(epoch from (entry.ended_at - entry.started_at))))::bigint
      from public.staff_time_entries entry
      where entry.job_id = p_job_id and entry.staff_user_id = auth.uid() and entry.ended_at is not null
    ), 0) else 0 end
  );
end;
$$;

create or replace function public.staff_claim_job(p_job_id uuid)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  job_record public.staff_jobs%rowtype;
  assigned_count integer;
begin
  if not private.is_active_staff() then raise exception 'Active staff account required'; end if;
  select * into job_record from public.staff_jobs where id = p_job_id for update;
  if not found or job_record.status not in ('open', 'in_progress') then raise exception 'Passet är inte längre ledigt'; end if;
  select count(*) into assigned_count from public.staff_job_assignments
  where job_id = p_job_id and status in ('claimed', 'assigned', 'completed');
  if assigned_count >= job_record.required_staff then raise exception 'Passet är redan fullbemannat'; end if;
  if exists (select 1 from public.staff_job_assignments where job_id = p_job_id and staff_user_id = auth.uid() and status in ('claimed', 'assigned', 'completed')) then
    raise exception 'Du har redan paxat passet';
  end if;

  insert into public.staff_job_assignments (job_id, staff_user_id, status, assignment_source)
  values (p_job_id, auth.uid(), 'claimed', 'staff');
  insert into public.staff_job_events (job_id, actor_user_id, event_type, summary)
  values (p_job_id, auth.uid(), 'job_claimed', 'En medarbetare paxade passet.');
end;
$$;

create or replace function public.staff_release_job(p_job_id uuid)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  deadline timestamp with time zone;
begin
  if not private.is_active_staff() then raise exception 'Active staff account required'; end if;
  select claim_release_deadline into deadline from public.staff_jobs where id = p_job_id for update;
  if not found then raise exception 'Job not found'; end if;
  if deadline is not null and now() >= deadline then raise exception 'Avpaxning är stängd. Kontakta admin.'; end if;
  if exists (select 1 from public.staff_time_entries where job_id = p_job_id and staff_user_id = auth.uid()) then
    raise exception 'Ett påbörjat jobb kan inte avpaxas';
  end if;
  update public.staff_job_assignments
  set status = 'released', released_at = now(), release_reason = 'Avpaxad av medarbetaren'
  where job_id = p_job_id and staff_user_id = auth.uid() and status in ('claimed', 'assigned');
  if not found then raise exception 'Aktiv paxning saknas'; end if;
  insert into public.staff_job_events (job_id, actor_user_id, event_type, summary)
  values (p_job_id, auth.uid(), 'job_released', 'Medarbetaren avpaxade passet.');
end;
$$;

create or replace function public.staff_start_job_time(p_job_id uuid)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog, public, extensions
as $$
declare
  entry_id uuid;
begin
  if not private.is_active_staff() then raise exception 'Active staff account required'; end if;
  if not exists (
    select 1 from public.staff_job_assignments assignment
    join public.staff_jobs job on job.id = assignment.job_id
    where assignment.job_id = p_job_id and assignment.staff_user_id = auth.uid()
      and assignment.status in ('claimed', 'assigned') and job.status not in ('completed', 'cancelled')
  ) then raise exception 'Du är inte tilldelad det här jobbet'; end if;
  if exists (select 1 from public.staff_time_entries where staff_user_id = auth.uid() and ended_at is null) then
    raise exception 'Du har redan en aktiv timer';
  end if;
  insert into public.staff_time_entries (job_id, staff_user_id) values (p_job_id, auth.uid()) returning id into entry_id;
  update public.staff_jobs set status = 'in_progress' where id = p_job_id and status not in ('completed', 'cancelled');
  insert into public.staff_job_events (job_id, actor_user_id, event_type, summary)
  values (p_job_id, auth.uid(), 'timer_started', 'Arbetstiden startades.');
  return entry_id;
end;
$$;

create or replace function public.staff_stop_job_time(p_job_id uuid, p_action text default 'pause')
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  missing_required integer;
  stopped_count integer;
begin
  if not private.is_active_staff() then raise exception 'Active staff account required'; end if;
  if p_action not in ('pause', 'completed') then raise exception 'Invalid action'; end if;
  if not exists (
    select 1 from public.staff_job_assignments
    where job_id = p_job_id and staff_user_id = auth.uid() and status in ('claimed', 'assigned')
  ) then raise exception 'Du är inte tilldelad det här jobbet'; end if;
  if p_action = 'completed' then
    select count(*) into missing_required from public.staff_job_checklist_items
    where job_id = p_job_id and required and not completed;
    if missing_required > 0 then raise exception 'Slutför alla obligatoriska checklistpunkter först'; end if;
  end if;

  update public.staff_time_entries
  set ended_at = clock_timestamp(), stop_reason = p_action
  where job_id = p_job_id and staff_user_id = auth.uid() and ended_at is null;
  get diagnostics stopped_count = row_count;
  if p_action = 'pause' and stopped_count = 0 then raise exception 'Ingen aktiv timer hittades för jobbet'; end if;
  if p_action = 'completed' and stopped_count = 0 and not exists (
    select 1 from public.staff_time_entries where job_id = p_job_id and staff_user_id = auth.uid()
  ) then raise exception 'Starta arbetstiden innan jobbet slutförs'; end if;

  if p_action = 'completed' then
    update public.staff_job_assignments set status = 'completed', completed_at = now()
    where job_id = p_job_id and staff_user_id = auth.uid() and status in ('claimed', 'assigned');
  end if;
  perform private.recalculate_staff_job_commissions(p_job_id);
  insert into public.staff_job_events (job_id, actor_user_id, event_type, summary)
  values (p_job_id, auth.uid(), case when p_action = 'completed' then 'job_completed_by_staff' else 'timer_paused' end,
    case when p_action = 'completed' then 'Medarbetaren slutförde sin del av jobbet.' else 'Arbetstiden pausades.' end);
end;
$$;

create or replace function public.staff_set_checklist_item(p_item_id uuid, p_completed boolean, p_note text default null)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  target_job_id uuid;
begin
  if not private.is_active_staff() then raise exception 'Active staff account required'; end if;
  select item.job_id into target_job_id
  from public.staff_job_checklist_items item
  join public.staff_job_assignments assignment on assignment.job_id = item.job_id
  join public.staff_jobs job on job.id = item.job_id
  where item.id = p_item_id and assignment.staff_user_id = auth.uid()
    and assignment.status in ('claimed', 'assigned') and job.status not in ('completed', 'cancelled')
  limit 1;
  if target_job_id is null then raise exception 'Checklist item is not available'; end if;
  if p_note is not null and char_length(p_note) > 2000 then raise exception 'Note is too long'; end if;
  update public.staff_job_checklist_items set
    completed = p_completed,
    completed_by = case when p_completed then auth.uid() else null end,
    completed_at = case when p_completed then now() else null end,
    note = nullif(btrim(coalesce(p_note, note)), '')
  where id = p_item_id;
end;
$$;

create or replace function public.staff_report_job_issue(p_job_id uuid, p_summary text)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  if not private.is_active_staff() then raise exception 'Active staff account required'; end if;
  if char_length(btrim(coalesce(p_summary, ''))) not between 3 and 2000 then raise exception 'Beskriv avvikelsen med 3–2000 tecken'; end if;
  if not exists (select 1 from public.staff_job_assignments where job_id = p_job_id and staff_user_id = auth.uid() and status in ('claimed', 'assigned', 'completed')) then
    raise exception 'Du är inte tilldelad det här jobbet';
  end if;
  insert into public.staff_job_events (job_id, actor_user_id, event_type, summary)
  values (p_job_id, auth.uid(), 'issue_reported', btrim(p_summary));
end;
$$;

do $rls$
declare
  table_name text;
begin
  foreach table_name in array array[
    'staff_profiles', 'checklist_templates', 'checklist_template_items', 'staff_jobs',
    'staff_job_assignments', 'staff_job_checklist_items', 'staff_time_entries',
    'staff_job_commissions', 'staff_job_costs', 'staff_job_events'
  ]
  loop
    execute format('alter table public.%I enable row level security', table_name);
    execute format('revoke all on table public.%I from public, anon, authenticated', table_name);
  end loop;
end;
$rls$;

do $admin_policies$
declare
  table_name text;
  policy_namelaceholder text;
begin
  foreach table_name in array array[
    'staff_profiles', 'checklist_templates', 'checklist_template_items', 'staff_jobs',
    'staff_job_assignments', 'staff_job_checklist_items', 'staff_time_entries',
    'staff_job_commissions', 'staff_job_costs'
  ]
  loop
    policy_namelaceholder := table_name || '_admin_aal2_manage';
    execute format('grant select, insert, update, delete on table public.%I to authenticated', table_name);
    execute format('drop policy if exists %I on public.%I', policy_namelaceholder, table_name);
    execute format('create policy %I on public.%I for all to authenticated using (private.is_booking_admin_aal2()) with check (private.is_booking_admin_aal2())', policy_namelaceholder, table_name);
  end loop;
end;
$admin_policies$;

grant select on table public.staff_job_events to authenticated;
drop policy if exists staff_job_events_admin_aal2_read on public.staff_job_events;
create policy staff_job_events_admin_aal2_read on public.staff_job_events
for select to authenticated using (private.is_booking_admin_aal2());

grant select on table public.staff_profiles to authenticated;
drop policy if exists staff_profiles_self_read on public.staff_profiles;
create policy staff_profiles_self_read on public.staff_profiles
for select to authenticated using (user_id = auth.uid());

grant usage, select on sequence public.staff_job_events_id_seq to authenticated;

revoke all on function public.admin_upsert_staff_job_from_booking(text, timestamp with time zone, integer, integer, uuid) from public, anon;
revoke all on function public.admin_assign_staff_job(uuid, uuid) from public, anon;
revoke all on function public.admin_release_staff_job(uuid, uuid, text) from public, anon;
revoke all on function public.admin_set_staff_job_status(uuid, text) from public, anon;
revoke all on function public.admin_set_staff_commission_status(uuid, text) from public, anon;
revoke all on function public.admin_create_staff_checklist_template(text, text, text, jsonb) from public, anon;
revoke all on function public.admin_upsert_staff_job_costs(uuid, jsonb) from public, anon;
revoke all on function public.admin_correct_staff_time_entry(uuid, timestamp with time zone, timestamp with time zone, text) from public, anon;
revoke all on function public.staff_get_me() from public, anon;
revoke all on function public.staff_activate_me() from public, anon;
revoke all on function public.staff_list_jobs() from public, anon;
revoke all on function public.staff_get_job(uuid) from public, anon;
revoke all on function public.staff_claim_job(uuid) from public, anon;
revoke all on function public.staff_release_job(uuid) from public, anon;
revoke all on function public.staff_start_job_time(uuid) from public, anon;
revoke all on function public.staff_stop_job_time(uuid, text) from public, anon;
revoke all on function public.staff_set_checklist_item(uuid, boolean, text) from public, anon;
revoke all on function public.staff_report_job_issue(uuid, text) from public, anon;

grant execute on function public.admin_upsert_staff_job_from_booking(text, timestamp with time zone, integer, integer, uuid) to authenticated;
grant execute on function public.admin_assign_staff_job(uuid, uuid) to authenticated;
grant execute on function public.admin_release_staff_job(uuid, uuid, text) to authenticated;
grant execute on function public.admin_set_staff_job_status(uuid, text) to authenticated;
grant execute on function public.admin_set_staff_commission_status(uuid, text) to authenticated;
grant execute on function public.admin_create_staff_checklist_template(text, text, text, jsonb) to authenticated;
grant execute on function public.admin_upsert_staff_job_costs(uuid, jsonb) to authenticated;
grant execute on function public.admin_correct_staff_time_entry(uuid, timestamp with time zone, timestamp with time zone, text) to authenticated;
grant execute on function public.staff_get_me() to authenticated;
grant execute on function public.staff_activate_me() to authenticated;
grant execute on function public.staff_list_jobs() to authenticated;
grant execute on function public.staff_get_job(uuid) to authenticated;
grant execute on function public.staff_claim_job(uuid) to authenticated;
grant execute on function public.staff_release_job(uuid) to authenticated;
grant execute on function public.staff_start_job_time(uuid) to authenticated;
grant execute on function public.staff_stop_job_time(uuid, text) to authenticated;
grant execute on function public.staff_set_checklist_item(uuid, boolean, text) to authenticated;
grant execute on function public.staff_report_job_issue(uuid, text) to authenticated;

insert into public.checklist_templates (name, description, match_rule, active)
select 'Standard fönsterputs', 'Grundchecklista för vanliga fönsterputsjobb.', 'standard', true
where not exists (select 1 from public.checklist_templates where lower(name) = 'standard fönsterputs');

insert into public.checklist_template_items (template_id, label, required, sort_order)
select template.id, item.label, item.required, item.sort_order
from public.checklist_templates template
cross join (values
  ('Kontrollera arbetsområdet och dokumentera befintliga skador', true, 10),
  ('Skydda golv, möbler och känsliga ytor', true, 20),
  ('Utför putsningen enligt bokningens omfattning', true, 30),
  ('Torka karmar och lämna arbetsområdet rent', true, 40),
  ('Gör slutkontroll och rapportera eventuella avvikelser', true, 50)
) as item(label, required, sort_order)
where lower(template.name) = 'standard fönsterputs'
  and not exists (
    select 1 from public.checklist_template_items existing
    where existing.template_id = template.id and existing.label = item.label
  );

comment on table public.staff_jobs is 'Operativ och minimerad jobbkopia. Personal får aldrig direktåtkomst till bookings.';
comment on column public.staff_jobs.commission_base_ex_vat_ore is 'Faktiskt pris efter rabatt och före RUT, exklusive 25 procent moms, fryst i ören.';
comment on column public.staff_jobs.commission_rate_basis_points is 'Jobbets totala provisionspott. 2000 baspunkter motsvarar 20 procent.';
comment on table public.staff_job_commissions is 'Fryst och spårbar provisionsfördelning. Godkända eller utbetalda belopp räknas inte om automatiskt.';
