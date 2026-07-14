alter table public.bookings
  add column if not exists fortnox_customer_number text,
  add column if not exists fortnox_invoice_number text,
  add column if not exists fortnox_reference_document_type text,
  add column if not exists fortnox_reference_number text,
  add column if not exists fortnox_rut_synced_at timestamp with time zone;

comment on column public.bookings.fortnox_customer_number is 'Kundnummer som skapats eller återanvänts i Fortnox.';
comment on column public.bookings.fortnox_invoice_number is 'Faktura- eller kontantfakturanummer som skapats i Fortnox.';
comment on column public.bookings.fortnox_reference_document_type is 'Fortnox dokumenttyp som RUT-underlaget refererar till, till exempel INVOICE.';
comment on column public.bookings.fortnox_reference_number is 'Fortnox dokumentnummer som RUT-underlaget refererar till.';
comment on column public.bookings.fortnox_rut_synced_at is 'När RUT-underlaget senast synkades till Fortnox.';

create table if not exists public.fortnox_oauth_tokens (
  provider text primary key default 'fortnox',
  access_token text,
  refresh_token text not null,
  expires_at timestamp with time zone,
  scope text,
  token_type text,
  created_at timestamp with time zone not null default now(),
  updated_at timestamp with time zone not null default now()
);

alter table public.fortnox_oauth_tokens enable row level security;

comment on table public.fortnox_oauth_tokens is 'Privat token-store för Fortnox OAuth. Läses och uppdateras endast av Edge Functions med service role.';
comment on column public.fortnox_oauth_tokens.provider is 'OAuth-provider, normalt fortnox.';
comment on column public.fortnox_oauth_tokens.access_token is 'Kortlivad Fortnox access token.';
comment on column public.fortnox_oauth_tokens.refresh_token is 'Roterande Fortnox refresh token.';
comment on column public.fortnox_oauth_tokens.expires_at is 'När access token löper ut.';
