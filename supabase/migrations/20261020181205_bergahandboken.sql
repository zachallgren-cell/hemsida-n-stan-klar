-- Editable originals and history are never granted directly to API roles.
create table public.handbook_articles (
 id uuid primary key default gen_random_uuid(),
 draft jsonb not null,
 published jsonb,
 revision integer not null default 1,
 published_revision integer,
 archived boolean not null default false,
 edited_by uuid not null references auth.users(id),
 updated_at timestamptz not null default now(),
 published_at timestamptz
);
create table public.handbook_versions (
 article_id uuid not null references public.handbook_articles(id),
 revision integer not null,
 snapshot jsonb not null,
 action text not null,
 edited_by uuid not null references auth.users(id),
 created_at timestamptz not null default now(),
 primary key(article_id, revision)
);
alter table public.handbook_articles enable row level security;
alter table public.handbook_versions enable row level security;
revoke all on public.handbook_articles, public.handbook_versions from public, anon, authenticated;

create function public.handbook_read(p_edit boolean default false) returns jsonb
language plpgsql security definer set search_path = pg_catalog, public as $$
begin
 if p_edit then
  if not private.is_booking_admin_aal2() then raise exception 'Admin AAL2 required'; end if;
  return coalesce((select jsonb_agg(to_jsonb(a) order by (draft->>'category'), (draft->>'order')::integer, draft->>'title') from public.handbook_articles a), '[]');
 end if;
 if not (private.is_booking_admin_aal2() or private.is_active_staff()) then raise exception 'Active staff account required'; end if;
 return coalesce((select jsonb_agg(jsonb_build_object('id',id,'document',published,'revision',published_revision,'updated_at',published_at) order by (published->>'category'), (published->>'order')::integer, published->>'title') from public.handbook_articles where published is not null and not archived), '[]');
end $$;

create function public.handbook_save(p_id uuid, p_expected integer, p_document jsonb, p_action text default 'save', p_restore integer default null) returns jsonb
language plpgsql security definer set search_path = pg_catalog, public as $$
declare a public.handbook_articles; doc jsonb; b jsonb;
begin
 if not private.is_booking_admin_aal2() then raise exception 'Admin AAL2 required'; end if;
 if p_id is null or p_expected is null then raise exception 'Article ID and expected revision required'; end if;
 if p_action is null or p_action not in ('save','publish','archive','restore','unarchive') then raise exception 'Invalid action'; end if;
 select * into a from public.handbook_articles where id=p_id for update;
 if found then
  if a.revision <> p_expected then raise exception 'Artikeln har ändrats av någon annan. Öppna den igen innan du sparar.'; end if;
 else
  if p_expected <> 0 or p_action not in ('save','publish') then raise exception 'Article not found'; end if;
 end if;
 doc := p_document;
 if p_action = 'restore' then
  select snapshot into doc from public.handbook_versions where article_id=p_id and revision=p_restore;
  if doc is null then raise exception 'Version not found'; end if;
 elsif p_action in ('archive','unarchive') then doc := a.draft;
 end if;
 if jsonb_typeof(doc) is distinct from 'object' or coalesce(length(btrim(doc->>'title')),0) not between 1 and 200
  or coalesce(length(btrim(doc->>'category')),0) not between 1 and 100
  or coalesce(length(btrim(doc->>'owner')),0) not between 1 and 160
  or coalesce(doc->>'order','') !~ '^[0-9]{1,6}$'
  or jsonb_typeof(doc->'blocks') is distinct from 'array' or pg_column_size(doc)>1000000
 then raise exception 'Kontrollera rubrik, kategori, ansvarig och innehåll.'; end if;
 if jsonb_array_length(doc->'blocks')>300 then raise exception 'Too many blocks'; end if;
 for b in select value from jsonb_array_elements(doc->'blocks') loop
  if coalesce(b->>'type','') not in ('text','heading','steps','list','info','image','video','file','link','article') then raise exception 'Invalid block'; end if;
  if b ? 'path' and (b->>'path' not like p_id::text || '/%' or b->>'path' like '%..%') then raise exception 'Invalid attachment path'; end if;
 end loop;
 if a.id is null then
  insert into public.handbook_articles(id,draft,edited_by) values(p_id,doc,auth.uid()) returning * into a;
 else
  update public.handbook_articles set draft=doc, revision=revision+1, edited_by=auth.uid(), updated_at=now(),
   archived=case when p_action='archive' then true when p_action in ('unarchive','publish') then false else archived end
  where id=p_id returning * into a;
 end if;
 if p_action='publish' then
  if jsonb_array_length(doc->'blocks')=0 or doc->>'owner'='Behöver utses' then raise exception 'Ange ansvarig och innehåll före publicering.'; end if;
  update public.handbook_articles set published=doc,published_revision=revision,published_at=now(),archived=false where id=p_id returning * into a;
 end if;
 insert into public.handbook_versions(article_id,revision,snapshot,action,edited_by) values(p_id,a.revision,doc,p_action,auth.uid());
 return to_jsonb(a);
end $$;

create function public.handbook_history(p_id uuid) returns jsonb
language plpgsql security definer set search_path = pg_catalog, public as $$
begin
 if not private.is_booking_admin_aal2() then raise exception 'Admin AAL2 required'; end if;
 return coalesce((select jsonb_agg(to_jsonb(v) order by revision desc) from public.handbook_versions v where article_id=p_id),'[]');
end $$;

-- Called only from Storage policies. A draft upload is invisible to staff until
-- its path is part of a published, non-archived article.
create function private.handbook_asset_access(p_name text, p_write boolean default false) returns boolean
language sql stable security definer set search_path = pg_catalog, public as $$
 select private.is_booking_admin_aal2() or (not p_write and private.is_active_staff() and exists (
  select 1 from public.handbook_articles a, jsonb_array_elements(a.published->'blocks') b
  where not a.archived and b->>'path'=p_name
 ));
$$;
revoke all on function private.handbook_asset_access(text,boolean) from public,anon;
grant execute on function private.handbook_asset_access(text,boolean) to authenticated;
insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values ('handbook','handbook',false,52428800,array['image/jpeg','image/png','image/webp','video/mp4','video/webm','application/pdf','text/plain','application/zip','application/vnd.openxmlformats-officedocument.wordprocessingml.document','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet']);
create policy handbook_assets_read on storage.objects for select to authenticated using(bucket_id='handbook' and private.handbook_asset_access(name,false));
create policy handbook_assets_insert on storage.objects for insert to authenticated with check(bucket_id='handbook' and private.handbook_asset_access(name,true));
create policy handbook_assets_delete on storage.objects for delete to authenticated using(bucket_id='handbook' and private.handbook_asset_access(name,true));
revoke all on function public.handbook_read(boolean), public.handbook_save(uuid,integer,jsonb,text,integer), public.handbook_history(uuid) from public,anon;
grant execute on function public.handbook_read(boolean), public.handbook_save(uuid,integer,jsonb,text,integer), public.handbook_history(uuid) to authenticated;

grant all on public.handbook_articles, public.handbook_versions to service_role;
