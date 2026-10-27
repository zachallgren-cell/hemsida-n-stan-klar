create table public.interview_invitations (
  id uuid primary key,
  application_id uuid not null references public.job_applications(id) on delete cascade,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  starts_at timestamptz not null,
  duration_minutes integer not null check (duration_minutes in (15,30,45,60,90)),
  location text not null check (length(location) between 1 and 500),
  message text not null default '' check (length(message) <= 2000),
  style text not null check (style in ('warm','professional','concise')),
  name text not null,
  email text not null,
  token_hash text not null unique,
  delivery_status text not null default 'pending' check (delivery_status in ('pending','sent','expired')),
  provider_id text,
  sent_at timestamptz,
  response text check (response in ('yes','no')),
  responded_at timestamptz
);
-- Reserve before sending: concurrent clicks cannot send two invitations.
create unique index interview_one_unanswered on public.interview_invitations(application_id) where response is null and delivery_status <> 'expired';
create index interview_application_date on public.interview_invitations(application_id,created_at desc);
alter table public.interview_invitations enable row level security;
revoke all on public.interview_invitations from public,anon,authenticated;
grant select(id,application_id,created_at,starts_at,duration_minutes,location,message,style,name,email,delivery_status,sent_at,response,responded_at) on public.interview_invitations to authenticated;
grant all on public.interview_invitations to service_role;
create policy interview_admin_read on public.interview_invitations for select to authenticated using (private.is_booking_admin());
-- Only the server can resolve a hashed bearer token; never expose the whole application.
create function public.respond_interview(p_token_hash text,p_response text default null)
returns jsonb language plpgsql security invoker set search_path = pg_catalog,public as $$
declare invitation public.interview_invitations;
begin
  if p_response is not null and p_response not in ('yes','no') then raise exception 'Ogiltigt svar.'; end if;
  select * into invitation from public.interview_invitations where token_hash=p_token_hash and delivery_status='sent' for update;
  if not found then raise exception 'Inbjudan kunde inte hittas.'; end if;
  if invitation.starts_at <= now() then raise exception 'Svarstiden har gått ut. Kontakta Berga Fönsterputs.'; end if;
  if p_response is not null and invitation.response is null then
    update public.interview_invitations set response=p_response,responded_at=clock_timestamp() where id=invitation.id returning * into invitation;
  elsif p_response is not null and invitation.response<>p_response then
    raise exception 'Du har redan svarat. Kontakta oss om du vill ändra svaret.';
  end if;
  return jsonb_build_object('starts_at',invitation.starts_at,'duration_minutes',invitation.duration_minutes,'location',invitation.location,'response',invitation.response);
end $$;
revoke all on function public.respond_interview(text,text) from public,anon,authenticated;
grant execute on function public.respond_interview(text,text) to service_role;
