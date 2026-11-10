-- MKT-03. No historical attribution is inferred or backfilled.
alter table public.bookings
  add column customer_source_answer text,
  add column referrer_host text,
  add column tracking_consent boolean,
  add column source_spring_reservation_id uuid references public.spring_2027_reservations(id) on delete set null;
alter table public.spring_2027_reservations
  add column customer_source_answer text,
  add column referrer_host text,
  add column tracking_consent boolean;

create table public.marketing_entries (
  id uuid primary key default gen_random_uuid(),
  booking_id bigint unique references public.bookings(id) on delete restrict,
  label text not null default '' check(char_length(label)<=120),
  source text check(source is null or (char_length(source) between 1 and 120 and source ~ '^[[:alnum:] _.,~+\-]+$')),
  campaign text check(campaign is null or (char_length(campaign) between 1 and 120 and campaign ~ '^[[:alnum:] _.,~+\-]+$')),
  route text not null check(route in ('unknown','website','phone','email','message','other')),
  revision integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check(campaign is null or source is not null)
);
create table public.marketing_audit (
  id bigint generated always as identity primary key,
  entry_id uuid not null references public.marketing_entries(id) on delete restrict,
  actor uuid not null references auth.users(id),
  occurred_at timestamptz not null default now(),
  reason text not null check(char_length(reason) between 3 and 300),
  old_value jsonb,
  new_value jsonb not null
);
alter table public.marketing_entries enable row level security;
alter table public.marketing_audit enable row level security;
revoke all on public.marketing_entries, public.marketing_audit from public, anon, authenticated;
revoke all on sequence public.marketing_audit_id_seq from public, anon, authenticated;
-- All browser access uses guarded RPCs; originals in bookings cannot be edited here.

create function public.marketing_save(
 p_id uuid, p_revision integer, p_booking_id bigint, p_label text,
 p_source text, p_campaign text, p_route text, p_reason text
) returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare old_entry public.marketing_entries%rowtype; saved public.marketing_entries%rowtype;
begin
 if private.is_booking_admin() is not true then raise exception 'Admin med tvåstegsverifiering krävs' using errcode='42501'; end if;
 if char_length(btrim(coalesce(p_reason,''))) not between 3 and 300 then raise exception 'Ange ändringsorsak (3–300 tecken)'; end if;
 if p_id is not null then
   select * into old_entry from public.marketing_entries where id=p_id for update;
   if not found or old_entry.revision is distinct from p_revision then raise exception 'Uppgifterna har ändrats. Ladda om.' using errcode='40001'; end if;
   if old_entry.booking_id is not null and old_entry.booking_id is distinct from p_booking_id then raise exception 'En kopplad bokning får inte bytas ut'; end if;
   update public.marketing_entries set booking_id=p_booking_id,label=btrim(coalesce(p_label,'')),
    source=nullif(lower(btrim(p_source)),''),campaign=nullif(btrim(p_campaign),''),route=p_route,
    revision=revision+1,updated_at=now() where id=p_id returning * into saved;
 else
   insert into public.marketing_entries(booking_id,label,source,campaign,route)
   values(p_booking_id,btrim(coalesce(p_label,'')),nullif(lower(btrim(p_source)),''),nullif(btrim(p_campaign),''),p_route) returning * into saved;
 end if;
 insert into public.marketing_audit(entry_id,actor,reason,old_value,new_value)
 values(saved.id,auth.uid(),btrim(p_reason),case when old_entry.id is null then null else to_jsonb(old_entry) end,to_jsonb(saved));
 return to_jsonb(saved);
end; $$;

create function public.marketing_list(p_booking_id bigint default null)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
begin
 if private.is_booking_admin() is not true then raise exception 'Admin med tvåstegsverifiering krävs' using errcode='42501'; end if;
 return jsonb_build_object('entries',coalesce((select jsonb_agg(to_jsonb(e) order by e.created_at desc) from public.marketing_entries e where p_booking_id is null or e.booking_id=p_booking_id),'[]'::jsonb),
 'audit',coalesce((select jsonb_agg(to_jsonb(a) order by a.occurred_at desc,a.id desc) from public.marketing_audit a join public.marketing_entries e on e.id=a.entry_id where p_booking_id is null or e.booking_id=p_booking_id),'[]'::jsonb));
end; $$;

-- Shared report rule, independent of visitor analytics. Keep unknown traffic unknown.
create function private.marketing_attribution(b jsonb, m jsonb default '{}')
returns jsonb language plpgsql immutable set search_path=pg_catalog,public as $$
declare source_value text; medium_value text; campaign_value text; basis text; host text;
begin
 if nullif(m->>'source','') is not null then
  source_value=m->>'source'; campaign_value=m->>'campaign'; basis='Manuellt registrerat';
 elsif nullif(b->>'utm_source','') is not null then
  source_value=lower(b->>'utm_source'); medium_value=b->>'utm_medium'; campaign_value=b->>'utm_campaign'; basis='Automatiskt: UTM';
 elsif nullif(b->>'referrer_host','') is not null then
  host=lower(b->>'referrer_host');
  source_value=case when host ~ '(^|\.)google\.(com|se|nu|no|dk|fi|de|fr|co\.uk)$' then 'google'
   when host ~ '(^|\.)facebook\.com$' then 'facebook'
   when host ~ '(^|\.)instagram\.com$' then 'instagram'
   when host ~ '(^|\.)tiktok\.com$' then 'tiktok' else host end;
  medium_value=coalesce(nullif(b->>'utm_medium',''),'referral'); basis='Automatiskt: extern hänvisare (betald/organisk okänd)';
 elsif b->>'attribution_ref'='referral' then source_value='recommendation'; basis='Automatiskt: rekommendationslänk';
 elsif nullif(b->>'customer_source_answer','') is not null then
  source_value=b->>'customer_source_answer'; basis='Självrapporterat';
 else source_value='unknown'; basis='Underlag saknas'; end if;
 if basis <> 'Manuellt registrerat' and nullif(b->>'utm_campaign','') is not null then
  campaign_value=b->>'utm_campaign';
  if basis <> 'Automatiskt: UTM' then basis=basis || ' · kampanj från UTM'; end if;
 end if;
 if b->>'source_spring_reservation_id' is not null and basis <> 'Manuellt registrerat' then
  basis=basis || ' · överfört från vårpaxning';
 end if;
 if source_value in ('dont_remember','unknown') then source_value='unknown'; end if;
 return jsonb_build_object('source',source_value,'medium',medium_value,'campaign',nullif(campaign_value,''),'basis',basis,
  'traffic',case when lower(medium_value) in ('cpc','ppc','paid','paid_social','paid_search','display','cpm') then 'Betald'
   when lower(medium_value) in ('organic','organic_social','organic_search') then 'Organisk' else 'Betald/organisk okänd' end,
  'route',coalesce(m->>'route',case when b->>'tracking_consent' is not null then 'website' else 'unknown' end));
end; $$;
revoke all on function private.marketing_attribution(jsonb,jsonb) from public,anon,authenticated;

create function public.marketing_booking(p_booking_id bigint)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare b jsonb; m jsonb;
begin
 if private.is_booking_admin() is not true then raise exception 'Admin med tvåstegsverifiering krävs' using errcode='42501'; end if;
 select to_jsonb(bookings) into b from public.bookings where id=p_booking_id;
 if b is null then raise exception 'Bokningen saknas'; end if;
 select to_jsonb(e) into m from public.marketing_entries e where booking_id=p_booking_id;
 return private.marketing_attribution(b,coalesce(m,'{}'));
end; $$;

create function public.marketing_report(p_start date,p_end date)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare result jsonb;
begin
 if private.is_booking_admin() is not true then raise exception 'Admin med tvåstegsverifiering krävs' using errcode='42501'; end if;
 if p_start is null or p_end is null or p_start>p_end then raise exception 'Välj ett giltigt datumintervall'; end if;
 with eligible as (
  select b.*,nullif(lower(btrim(b.email)),'') customer_key
  from public.bookings b
  where b.status in ('confirmed','completed') or (b.status='pending' and b.email_confirmed_at is not null)
 ), chosen as (
  select b.*,private.marketing_attribution(to_jsonb(b),coalesce(to_jsonb(m),'{}')) attribution,
   case when customer_key is null then 'unknown'
    when exists(select 1 from eligible earlier where earlier.customer_key=b.customer_key
     and (earlier.created_at,earlier.id)<(b.created_at,b.id)) then 'returning' else 'new' end customer_type,
   -- All price fields are SEK incl. VAT; never add RUT again to price_before_rut.
   case when b.price_before_rut is not null then b.price_before_rut/1.25
    when b.labor_cost_before_rut is not null and b.material_cost is not null and b.transport_cost is not null
     then (b.labor_cost_before_rut+b.material_cost+b.transport_cost)/1.25
    else null end revenue
  from eligible b left join public.marketing_entries m on m.booking_id=b.id
  where b.created_at >= (p_start::timestamp at time zone 'Europe/Stockholm')
    and b.created_at < ((p_end+1)::timestamp at time zone 'Europe/Stockholm')
 ), grouped as (
  select attribution->>'source' source,attribution->>'campaign' campaign,attribution->>'basis' basis,
   count(*) bookings,round(sum(revenue),2) revenue_ex_vat,count(*) filter(where revenue is null) missing_value,
   count(*) filter(where customer_type='new') new_customers,
   count(*) filter(where customer_type='returning') returning_customers,
   count(*) filter(where customer_type='unknown') unknown_customer_type,
   count(distinct customer_key) unique_customers
  from chosen group by 1,2,3
 ) select jsonb_build_object('rows',coalesce((select jsonb_agg(to_jsonb(g) order by bookings desc,source,campaign) from grouped g),'[]'::jsonb),
  'bookings',(select count(*) from chosen),'unique_customers',(select count(distinct customer_key) from chosen),
  'customers_without_identity',(select count(*) from chosen where customer_key is null),
  'revenue_ex_vat',(select round(sum(revenue),2) from chosen),'missing_value',(select count(*) from chosen where revenue is null)) into result;
 return result;
end; $$;

-- Paxning -> one real booking. The invitation finalizer already makes this link atomically.
create function private.marketing_transfer_spring() returns trigger
language plpgsql security definer set search_path=pg_catalog,public as $$
declare pax public.spring_2027_reservations%rowtype;
begin
 if new.booking_id is not null and old.booking_id is distinct from new.booking_id and new.spring_reservation_id is not null then
  select * into pax from public.spring_2027_reservations where id=new.spring_reservation_id;
  update public.bookings b set
   source_spring_reservation_id=case when b.utm_source is null and b.referrer_host is null and b.attribution_ref is null then pax.id else b.source_spring_reservation_id end,
   customer_source_answer=coalesce(b.customer_source_answer,pax.customer_source_answer),
   utm_source=case when b.utm_source is null and b.referrer_host is null and b.attribution_ref is null then pax.utm_source else b.utm_source end,
   utm_medium=case when b.utm_source is null and b.referrer_host is null and b.attribution_ref is null then pax.utm_medium else b.utm_medium end,
   utm_campaign=case when b.utm_source is null and b.referrer_host is null and b.attribution_ref is null then pax.utm_campaign else b.utm_campaign end,
   utm_content=case when b.utm_source is null and b.referrer_host is null and b.attribution_ref is null then pax.utm_content else b.utm_content end,
   utm_term=case when b.utm_source is null and b.referrer_host is null and b.attribution_ref is null then pax.utm_term else b.utm_term end,
   referrer_host=case when b.utm_source is null and b.referrer_host is null and b.attribution_ref is null then pax.referrer_host else b.referrer_host end,
   attribution_ref=case when b.utm_source is null and b.referrer_host is null and b.attribution_ref is null then pax.attribution_ref else b.attribution_ref end
  where b.id::text=new.booking_id;
 end if;
 return new;
end; $$;
revoke all on function private.marketing_transfer_spring() from public,anon,authenticated;
create trigger marketing_transfer_spring after update of booking_id on public.booking_invitations
 for each row execute function private.marketing_transfer_spring();

revoke all on function public.marketing_save(uuid,integer,bigint,text,text,text,text,text),public.marketing_list(bigint),public.marketing_booking(bigint),public.marketing_report(date,date) from public,anon;
grant execute on function public.marketing_save(uuid,integer,bigint,text,text,text,text,text),public.marketing_list(bigint),public.marketing_booking(bigint),public.marketing_report(date,date) to authenticated;
