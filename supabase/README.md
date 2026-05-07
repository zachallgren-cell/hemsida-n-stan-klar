# Bokningsmail med Supabase

Den här lösningen gör bokning och betalning i två steg:

1. sparar bokningen i tabellen `bookings`
2. skickar ett mail till `info@bergafonsterputs.se`
3. skapar en Stripe Checkout-länk först i klartflödet när jobbet markeras som slutfört

## Så fungerar det

Bokningssidan kan anropa Edge Function:

- `create-booking`
- `complete-booking`
- `stripe-webhook`

Funktionen:

- sparar bokningen med `SUPABASE_SERVICE_ROLE_KEY`
- skickar bokningsmail via Resend
- skickar kundens första bekräftelsemail utan Stripe-länk
- skapar Stripe-produkt, Stripe-pris och Stripe Checkout-session i `complete-booking`
- skickar Stripe Checkout-länken i klartmailet när jobbet är utfört
- markerar bokningen som `paid` när Stripe skickar `checkout.session.completed` till webhooken

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

För Stripe-flödet, kör också:

- `supabase/migrations/20260506_add_stripe_checkout_fields.sql`

Den lägger till:

- `payment_provider`
- `stripe_product_id`
- `stripe_price_id`
- `stripe_checkout_session_id`
- `stripe_payment_intent_id`
- `stripe_payment_url`
- `stripe_checkout_expires_at`
- `stripe_paid_at`

## Secrets du behöver i Supabase

Lägg in dessa i Supabase Edge Functions secrets:

- `RESEND_API_KEY`
- `BOOKING_NOTIFICATION_EMAIL=info@bergafonsterputs.se`
- `BOOKING_FROM_EMAIL=Berga Fönsterputs <bokning@din-domän.se>`
- `BOOKING_RUT_FORM_URL=https://...` om ni vill lägga RUT-formuläret direkt i kundens bekräftelsemejl
- `PUBLIC_SITE_URL=https://bergafonsterputs.se`
- `STRIPE_SECRET_KEY=sk_live_...`
- `STRIPE_WEBHOOK_SECRET=whsec_...`

## Viktigt

`BOOKING_FROM_EMAIL` måste vara en adress som Resend accepterar för ditt konto. I produktion är det normalt en verifierad domän hos Resend.

Hämta `STRIPE_SECRET_KEY` i Stripe Dashboard. När `stripe-webhook` är deployad skapar du en webhook i Stripe Dashboard som pekar på:

```text
https://xeyippgcoqfskcmqzazx.supabase.co/functions/v1/stripe-webhook
```

Lyssna på eventet:

- `checkout.session.completed`

Kopiera sedan webhookens signing secret till `STRIPE_WEBHOOK_SECRET`.

## Deploy

När du har Supabase CLI installerat kan du deploya med:

```bash
supabase functions deploy create-booking
supabase functions deploy complete-booking
supabase functions deploy stripe-webhook
```

Om du vill sätta secrets från terminalen:

```bash
supabase secrets set RESEND_API_KEY=re_xxx
supabase secrets set BOOKING_NOTIFICATION_EMAIL=info@bergafonsterputs.se
supabase secrets set BOOKING_FROM_EMAIL="Berga Fönsterputs <bokning@din-domän.se>"
supabase secrets set BOOKING_RUT_FORM_URL="https://..."
supabase secrets set PUBLIC_SITE_URL=https://bergafonsterputs.se
supabase secrets set STRIPE_SECRET_KEY="$STRIPE_SECRET_KEY"
supabase secrets set STRIPE_WEBHOOK_SECRET="$STRIPE_WEBHOOK_SECRET"
```

## Efter deploy

När funktionen är deployad kommer varje ny bokning från hemsidan att:

- sparas i Supabase
- skicka ett bokningsmail till er mail
- spara bokningen utan Stripe-länk i första bekräftelsemejlet
- skapa Stripe-länken först när jobbet markeras som klart

## Adminsida

Det finns också en adminsida:

- `admin.html`

Där kan ni:

- logga in med Supabase Auth
- se bokningar
- markera `confirmed`
- markera `paid`
- markera jobbet som klart och skicka betalningsmail + recensionslänk

## Extra secret för klartmail

Lägg gärna också till:

- `BOOKING_REVIEW_URL`

Exempel:

- `BOOKING_REVIEW_URL=https://g.page/r/.../review`

## Deploya klartfunktionen

```bash
supabase functions deploy complete-booking
```
