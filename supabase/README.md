# Bokningsmail med Supabase

Den här lösningen gör två saker i samma steg:

1. sparar bokningen i tabellen `bookings`
2. skickar ett mail till `bergabattvatt@gmail.com`

## Så fungerar det

Startsidan kan anropa Edge Function:

- `create-booking`

Funktionen:

- sparar bokningen med `SUPABASE_SERVICE_ROLE_KEY`
- skickar bokningsmail via Resend

## Nya kolumner för fönsterputs

Kör först SQL-filen:

- `supabase/migrations/20260426_add_fonsterputs_booking_fields.sql`

Den lägger till dessa kolumner i `bookings`:

- `address`
- `personal_number`
- `housing_type`
- `window_count`
- `service_scope`
- `addons`
- `payment_method`
- `map_link`
- `consent_accepted`

Kör sedan också:

- `supabase/migrations/20260504_add_boat_transport_fields.sql`

Den lägger till:

- `transport_type`
- `sea_miles`
- `coordinates`

För adminflödet, kör också:

- `supabase/migrations/20260504_add_admin_fields_and_policies.sql`

Den lägger till:

- `price`
- `completed_at`

och policies så att inloggade admin-användare kan läsa och uppdatera bokningar.

## Secrets du behöver i Supabase

Lägg in dessa i Supabase Edge Functions secrets:

- `RESEND_API_KEY`
- `BOOKING_NOTIFICATION_EMAIL=bergabattvatt@gmail.com`
- `BOOKING_FROM_EMAIL=Berga Fönsterputs <bokning@din-domän.se>`

## Viktigt

`BOOKING_FROM_EMAIL` måste vara en adress som Resend accepterar för ditt konto. I produktion är det normalt en verifierad domän hos Resend.

## Deploy

När du har Supabase CLI installerat kan du deploya med:

```bash
supabase functions deploy create-booking
```

Om du vill sätta secrets från terminalen:

```bash
supabase secrets set RESEND_API_KEY=re_xxx
supabase secrets set BOOKING_NOTIFICATION_EMAIL=bergabattvatt@gmail.com
supabase secrets set BOOKING_FROM_EMAIL="Berga Fönsterputs <bokning@din-domän.se>"
```

## Efter deploy

När funktionen är deployad kommer varje ny bokning från hemsidan att:

- sparas i Supabase
- skicka ett bokningsmail till er mail

## Adminsida

Det finns också en adminsida:

- `admin.html`

Där kan ni:

- logga in med Supabase Auth
- se bokningar
- markera `confirmed`
- markera `paid`
- markera jobbet som klart och skicka betalningsmail + recensionslänk

## Extra secrets för klartmail

Lägg gärna också till:

- `BOOKING_REVIEW_URL`
- `BOOKING_SWISH_NUMBER`

Exempel:

- `BOOKING_REVIEW_URL=https://g.page/r/.../review`
- `BOOKING_SWISH_NUMBER=073-388 12 16`

## Deploya klartfunktionen

```bash
supabase functions deploy complete-booking
```
