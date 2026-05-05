alter table public.bookings
  add column if not exists address text,
  add column if not exists personal_number text,
  add column if not exists housing_type text,
  add column if not exists window_count text,
  add column if not exists service_scope text,
  add column if not exists addons text,
  add column if not exists payment_method text,
  add column if not exists map_link text,
  add column if not exists consent_accepted boolean not null default false;

comment on column public.bookings.address is 'Adress där jobbet ska utföras.';
comment on column public.bookings.personal_number is 'Fullständigt personnummer för RUT-hantering.';
comment on column public.bookings.housing_type is 'Visningsvärde för bostadstyp, till exempel Enplansvilla.';
comment on column public.bookings.window_count is 'Ungefär antal fönster eller glaspartier.';
comment on column public.bookings.service_scope is 'Val mellan invändig + utvändig eller endast utvändig.';
comment on column public.bookings.addons is 'Tillägg som spröjs, inglasad altan eller svåråtkomliga fönster.';
comment on column public.bookings.payment_method is 'Vald betalningsmetod i bokningen.';
comment on column public.bookings.map_link is 'Google Maps-länk eller pin till platsen.';
comment on column public.bookings.consent_accepted is 'Om kunden godkänt personuppgiftshantering och RUT-hantering.';
