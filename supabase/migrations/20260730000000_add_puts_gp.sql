-- BERGA PUTS-GP. Additive, isolated competition schema in the public schema.
-- Private participant data is never exposed through the public views/RPCs below.

create extension if not exists pgcrypto;

create type public.puts_gp_event_status as enum ('draft', 'ready', 'running', 'paused', 'finished');
create type public.puts_gp_attempt_status as enum ('queued', 'countdown', 'running', 'reviewing', 'published', 'invalid', 'disqualified', 'deleted');

create table public.puts_gp_events (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 1 and 120),
  event_date date not null,
  status public.puts_gp_event_status not null default 'draft',
  starts_at timestamptz,
  ends_at timestamptz,
  active_attempt_id uuid,
  settings jsonb not null default jsonb_build_object(
    'rotationSeconds', 10,
    'soundEnabled', true,
    'droneVideoUrl', '',
    'penalties', jsonb_build_object('streak', 2, 'missedArea', 3, 'water', 1, 'dirt', 3),
    'offer', ''
  ),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create table public.puts_gp_participants (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.puts_gp_events(id),
  full_name text not null check (char_length(trim(full_name)) between 2 and 160),
  public_display_name text not null check (char_length(trim(public_display_name)) between 1 and 80),
  phone_number text not null check (char_length(trim(phone_number)) between 5 and 32),
  birth_year smallint not null check (birth_year between 1900 and 2026),
  photo_path text,
  photo_public_url text,
  public_name_consent boolean not null default false,
  public_photo_consent boolean not null default false,
  terms_consent_at timestamptz not null,
  marketing_consent boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  erased_at timestamptz,
  check (photo_public_url is null or public_photo_consent)
);

create table public.puts_gp_attempts (
  id uuid primary key default gen_random_uuid(),
  participant_id uuid not null references public.puts_gp_participants(id),
  event_id uuid not null references public.puts_gp_events(id),
  raw_time_ms integer check (raw_time_ms is null or raw_time_ms >= 0),
  penalty_ms integer not null default 0 check (penalty_ms >= 0),
  final_time_ms integer generated always as (case when raw_time_ms is null then null else raw_time_ms + penalty_ms end) stored,
  status public.puts_gp_attempt_status not null default 'queued',
  started_at timestamptz,
  stopped_at timestamptz,
  published_at timestamptz,
  disqualification_reason text,
  admin_note text,
  deleted_at timestamptz,
  deleted_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((status <> 'disqualified') or disqualification_reason is not null),
  check ((status not in ('published', 'reviewing')) or raw_time_ms is not null)
);
alter table public.puts_gp_events add constraint puts_gp_active_attempt_fk foreign key (active_attempt_id) references public.puts_gp_attempts(id) deferrable initially deferred;

create table public.puts_gp_penalties (
  id uuid primary key default gen_random_uuid(),
  attempt_id uuid not null references public.puts_gp_attempts(id) on delete cascade,
  penalty_type text not null check (penalty_type in ('streak', 'missed_area', 'water', 'dirt', 'equipment', 'other')),
  count integer not null default 1 check (count >= 0 and count <= 100),
  seconds_per_item numeric(8,2) not null check (seconds_per_item >= 0 and seconds_per_item <= 3600),
  total_seconds numeric(10,2) generated always as (count * seconds_per_item) stored,
  note text,
  created_at timestamptz not null default now()
);

create table public.puts_gp_awards (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.puts_gp_events(id),
  participant_id uuid references public.puts_gp_participants(id),
  attempt_id uuid references public.puts_gp_attempts(id),
  award_type text not null check (award_type in ('best_time', 'youngest', 'oldest', 'custom')),
  label text not null,
  awarded_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create table public.puts_gp_public_result_tokens (
  attempt_id uuid primary key references public.puts_gp_attempts(id) on delete cascade,
  token uuid not null unique default gen_random_uuid(),
  created_at timestamptz not null default now(),
  revoked_at timestamptz
);

create table public.puts_gp_audit_log (
  id bigint generated always as identity primary key,
  event_id uuid references public.puts_gp_events(id),
  admin_user_id uuid references auth.users(id),
  action text not null,
  entity_type text not null,
  entity_id uuid,
  previous_value jsonb,
  new_value jsonb,
  created_at timestamptz not null default now()
);

-- This is the only realtime table available to anonymous screens. It contains a
-- deliberately small, derived snapshot and is updated by database triggers.
create table public.puts_gp_public_feed (
  event_id uuid primary key references public.puts_gp_events(id) on delete cascade,
  revision bigint not null default 0,
  payload jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

create index puts_gp_attempts_rank_idx on public.puts_gp_attempts (event_id, final_time_ms asc, penalty_ms asc, published_at asc) where status = 'published' and deleted_at is null;
create index puts_gp_participants_event_idx on public.puts_gp_participants (event_id) where deleted_at is null;
create index puts_gp_penalties_attempt_idx on public.puts_gp_penalties (attempt_id);
create unique index puts_gp_one_live_attempt_idx on public.puts_gp_attempts(event_id) where status in ('countdown', 'running', 'reviewing');

create or replace function public.puts_gp_touch_updated_at() returns trigger language plpgsql as $$ begin new.updated_at = now(); return new; end; $$;
create trigger puts_gp_events_touch before update on public.puts_gp_events for each row execute function public.puts_gp_touch_updated_at();
create trigger puts_gp_participants_touch before update on public.puts_gp_participants for each row execute function public.puts_gp_touch_updated_at();
create trigger puts_gp_attempts_touch before update on public.puts_gp_attempts for each row execute function public.puts_gp_touch_updated_at();

alter table public.puts_gp_events enable row level security;
alter table public.puts_gp_participants enable row level security;
alter table public.puts_gp_attempts enable row level security;
alter table public.puts_gp_penalties enable row level security;
alter table public.puts_gp_awards enable row level security;
alter table public.puts_gp_public_result_tokens enable row level security;
alter table public.puts_gp_audit_log enable row level security;
alter table public.puts_gp_public_feed enable row level security;

-- Direct browser writes are deliberately prohibited. Authenticated admin reads are
-- allowed only for the competition tables; writes go through puts-gp-admin.
create policy "puts gp admins read events" on public.puts_gp_events for select to authenticated using (private.is_booking_admin());
create policy "puts gp admins read participants" on public.puts_gp_participants for select to authenticated using (private.is_booking_admin());
create policy "puts gp admins read attempts" on public.puts_gp_attempts for select to authenticated using (private.is_booking_admin());
create policy "puts gp admins read penalties" on public.puts_gp_penalties for select to authenticated using (private.is_booking_admin());
create policy "puts gp admins read awards" on public.puts_gp_awards for select to authenticated using (private.is_booking_admin());
create policy "puts gp admins read tokens" on public.puts_gp_public_result_tokens for select to authenticated using (private.is_booking_admin());
create policy "puts gp admins read audit" on public.puts_gp_audit_log for select to authenticated using (private.is_booking_admin());
create policy "public reads puts gp live feed" on public.puts_gp_public_feed for select to anon, authenticated using (true);

create or replace function public.puts_gp_refresh_public_feed(p_event_id uuid)
returns void language plpgsql security definer set search_path = pg_catalog, public as $$
declare e record; live record;
begin
  select * into e from public.puts_gp_events where id = p_event_id and deleted_at is null;
  if not found then return; end if;
  select a.id, a.status, a.raw_time_ms, a.penalty_ms, p.public_display_name
    into live from public.puts_gp_attempts a join public.puts_gp_participants p on p.id = a.participant_id
    where a.event_id = p_event_id and a.status in ('countdown','running','reviewing') and a.deleted_at is null
    order by a.updated_at desc limit 1;
  insert into public.puts_gp_public_feed(event_id, revision, payload, updated_at)
  values (p_event_id, 1, jsonb_build_object(
    'eventName', e.name, 'eventDate', e.event_date, 'eventStatus', e.status,
    'offer', coalesce(e.settings->>'offer',''), 'rotationSeconds', coalesce((e.settings->>'rotationSeconds')::integer,10),
    'activeAttempt', case when live.id is null then null else jsonb_build_object('id',live.id,'status',live.status,'publicDisplayName',case when exists(select 1 from public.puts_gp_participants p where p.id=(select participant_id from public.puts_gp_attempts where id=live.id) and p.public_name_consent) then live.public_display_name else 'Deltagare' end,'rawTimeMs',live.raw_time_ms,'penaltyMs',live.penalty_ms) end
  ), now())
  on conflict (event_id) do update set revision = public.puts_gp_public_feed.revision + 1, payload = excluded.payload, updated_at = excluded.updated_at;
end $$;
create or replace function public.puts_gp_feed_from_event() returns trigger language plpgsql security definer set search_path = pg_catalog, public as $$ begin perform public.puts_gp_refresh_public_feed(new.id); return new; end $$;
create or replace function public.puts_gp_feed_from_attempt() returns trigger language plpgsql security definer set search_path = pg_catalog, public as $$ begin perform public.puts_gp_refresh_public_feed(new.event_id); return new; end $$;
create trigger puts_gp_feed_event after insert or update on public.puts_gp_events for each row execute function public.puts_gp_feed_from_event();
create trigger puts_gp_feed_attempt after insert or update on public.puts_gp_attempts for each row execute function public.puts_gp_feed_from_attempt();

-- A safe anonymous projection. Phone, full name, birth year, consent records and
-- all admin notes remain in the underlying protected tables.
create or replace view public.puts_gp_public_leaderboard
with (security_invoker = false) as
select
  a.id as attempt_id, a.event_id, p.public_display_name, p.photo_public_url,
  a.raw_time_ms, a.penalty_ms, a.final_time_ms, a.published_at,
  rank() over (partition by a.event_id order by a.final_time_ms, a.penalty_ms, a.published_at) as placement,
  count(*) over (partition by a.event_id) as participant_count,
  avg(a.final_time_ms) over (partition by a.event_id) as average_time_ms
from public.puts_gp_attempts a
join public.puts_gp_participants p on p.id = a.participant_id
where a.status = 'published' and a.deleted_at is null and p.deleted_at is null and p.public_name_consent;
grant select on public.puts_gp_public_leaderboard to anon, authenticated;
grant select on public.puts_gp_public_feed to anon, authenticated;

create or replace function public.puts_gp_public_result(p_token uuid)
returns table (event_name text, event_date date, public_display_name text, photo_public_url text, raw_time_ms integer, penalty_ms integer, final_time_ms integer, placement bigint, participant_count bigint, percentile_faster numeric, badges text[])
language sql stable security definer set search_path = pg_catalog, public as $$
  with result as (
    select l.*, e.name, e.event_date
    from public.puts_gp_public_result_tokens t
    join public.puts_gp_public_leaderboard l on l.attempt_id = t.attempt_id
    join public.puts_gp_events e on e.id = l.event_id
    where t.token = p_token and t.revoked_at is null
  )
  select r.name, r.event_date, r.public_display_name, r.photo_public_url, r.raw_time_ms, r.penalty_ms, r.final_time_ms,
    r.placement, r.participant_count,
    case when r.participant_count <= 1 then 100 else round(100 * (r.participant_count - r.placement)::numeric / (r.participant_count - 1), 1) end,
    array_remove(array[
      case when r.placement = 1 then 'Banrekord' end,
      case when r.placement <= 3 then 'Topp 3' end,
      case when r.placement <= 10 then 'Topp 10' end,
      case when r.penalty_ms = 0 then 'Noll straff' end,
      case when r.final_time_ms < r.average_time_ms then 'Under genomsnittet' end
    ], null)
  from result r;
$$;
revoke all on function public.puts_gp_public_result(uuid) from public;
grant execute on function public.puts_gp_public_result(uuid) to anon, authenticated;

-- Storage bucket is public only for images for which a participant explicitly
-- consented. Original/private paths must not be placed in this bucket.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('puts-gp-public-photos', 'puts-gp-public-photos', true, 3145728, array['image/jpeg', 'image/webp'])
on conflict (id) do update set public = true, file_size_limit = 3145728, allowed_mime_types = array['image/jpeg', 'image/webp'];
create policy "puts gp admins manage public photos" on storage.objects for all to authenticated using (bucket_id = 'puts-gp-public-photos' and private.is_booking_admin()) with check (bucket_id = 'puts-gp-public-photos' and private.is_booking_admin());

-- Service role needs the tables for the audited Edge Function; browser roles do not.
grant select, insert, update, delete on public.puts_gp_events, public.puts_gp_participants, public.puts_gp_attempts, public.puts_gp_penalties, public.puts_gp_awards, public.puts_gp_public_result_tokens, public.puts_gp_audit_log to service_role;
grant select, insert, update, delete on public.puts_gp_public_feed to service_role;

alter publication supabase_realtime add table public.puts_gp_public_feed;
