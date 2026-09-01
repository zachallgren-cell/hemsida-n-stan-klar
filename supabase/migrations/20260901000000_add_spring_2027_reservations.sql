-- Store free, non-binding priority-list requests for spring 2027.
-- The public form writes through an Edge Function using the service role;
-- browser clients never receive direct table access.

set local search_path = pg_catalog, public, extensions;

create extension if not exists pgcrypto with schema extensions;

create table if not exists public.spring_2027_reservations (
  id uuid primary key default extensions.gen_random_uuid(),
  request_id uuid not null unique,
  name text not null check (char_length(btrim(name)) between 2 and 100),
  email text not null check (char_length(btrim(email)) between 3 and 254),
  phone text not null check (char_length(btrim(phone)) between 7 and 30),
  location text not null check (char_length(btrim(location)) between 2 and 120),
  requested_period text not null default 'flexible'
    check (requested_period in ('march', 'april', 'may', 'flexible')),
  service_interest text not null default 'unsure'
    check (service_interest in ('exterior', 'interior_exterior', 'unsure')),
  message text check (message is null or char_length(message) <= 1500),
  status text not null default 'paxed'
    check (status in ('paxed', 'contacted', 'invited', 'booked', 'declined', 'archived')),
  utm_source text,
  utm_medium text,
  utm_campaign text,
  utm_content text,
  utm_term text,
  attribution_ref text,
  landing_page text,
  created_at timestamp with time zone not null default now(),
  updated_at timestamp with time zone not null default now()
);

create index if not exists spring_2027_reservations_created_idx
  on public.spring_2027_reservations (created_at desc);
create index if not exists spring_2027_reservations_status_idx
  on public.spring_2027_reservations (status, created_at desc);
create index if not exists spring_2027_reservations_email_idx
  on public.spring_2027_reservations (lower(btrim(email)));

alter table public.spring_2027_reservations enable row level security;
revoke all on table public.spring_2027_reservations from anon, authenticated;

comment on table public.spring_2027_reservations is
  'Kostnadsfria, icke-bindande paxningar till prioriteringslistan for varen 2027.';
