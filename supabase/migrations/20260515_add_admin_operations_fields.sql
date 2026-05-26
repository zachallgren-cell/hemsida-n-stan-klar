alter table public.bookings
  add column if not exists rut_choice text,
  add column if not exists rut_status text not null default 'Ej skickat',
  add column if not exists rut_form_token text,
  add column if not exists rut_sent_at timestamp with time zone,
  add column if not exists rut_received_at timestamp with time zone,
  add column if not exists internal_note text,
  add column if not exists confirmation_email_sent boolean not null default false,
  add column if not exists confirmation_email_sent_at timestamp with time zone,
  add column if not exists rut_email_sent boolean not null default false,
  add column if not exists rut_email_sent_at timestamp with time zone,
  add column if not exists payment_email_sent boolean not null default false,
  add column if not exists payment_email_sent_at timestamp with time zone,
  add column if not exists thank_you_email_sent boolean not null default false,
  add column if not exists thank_you_email_sent_at timestamp with time zone,
  add column if not exists review_email_sent boolean not null default false,
  add column if not exists review_email_sent_at timestamp with time zone,
  add column if not exists paid_at timestamp with time zone;

comment on column public.bookings.rut_choice is 'Kundens val om RUT-avdrag i bokningsflödet.';
comment on column public.bookings.rut_status is 'Adminstatus för RUT: Ej skickat, Skickat, Mottaget eller Verifierat.';
comment on column public.bookings.rut_form_token is 'Token för säker RUT-formulärslänk.';
comment on column public.bookings.rut_sent_at is 'När RUT-formulär skickades till kund.';
comment on column public.bookings.rut_received_at is 'När RUT-uppgifter mottogs från kund.';
comment on column public.bookings.internal_note is 'Intern anteckning för admin, till exempel portkod eller parkering.';
comment on column public.bookings.confirmation_email_sent is 'Om bekräftelsemail till kund har skickats.';
comment on column public.bookings.confirmation_email_sent_at is 'När bekräftelsemail till kund skickades.';
comment on column public.bookings.rut_email_sent is 'Om RUT-mail/formulär har skickats.';
comment on column public.bookings.rut_email_sent_at is 'När RUT-mail/formulär skickades.';
comment on column public.bookings.payment_email_sent is 'Om betalningsmail har skickats.';
comment on column public.bookings.payment_email_sent_at is 'När betalningsmail skickades.';
comment on column public.bookings.thank_you_email_sent is 'Om tackmail har skickats.';
comment on column public.bookings.thank_you_email_sent_at is 'När tackmail skickades.';
comment on column public.bookings.review_email_sent is 'Om recensionsmail har skickats.';
comment on column public.bookings.review_email_sent_at is 'När recensionsmail skickades.';
comment on column public.bookings.paid_at is 'När bokningen markerades som betald manuellt i admin.';

create unique index if not exists bookings_rut_form_token_idx
  on public.bookings (rut_form_token)
  where rut_form_token is not null;
