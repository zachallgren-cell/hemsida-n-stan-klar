# Bokningsmail med Supabase

Den här lösningen gör bokning och betalning i två steg:

1. sparar bokningen i tabellen `bookings`
2. skickar ett bokningsmail till `bokning@bergafonsterputs.se`
3. visar en tack-sida där kunden ser att betalning sker efter utfört jobb
4. skickar en Stripe-länk i klartmailet när jobbet markeras som slutfört, och skapar en ny om den tidigare har gått ut

## Så fungerar det

Bokningssidan kan anropa Edge Function:

- `create-booking`
- `booked-slots`
- `complete-booking`
- `stripe-webhook`
- `rut-booking-details`
- `submit-rut`

Funktionen:

- sparar bokningen med `SUPABASE_SERVICE_ROLE_KEY`
- visar bokade datum/tider publikt via `booked-slots` utan kunduppgifter
- skickar bokningsmail via Resend
- skickar kundens första bekräftelsemail utan Stripe-länk
- återanvänder eller skapar ny Stripe Checkout-session i `complete-booking` när jobbet markeras som klart
- skickar Stripe Checkout-länken i klartmailet när jobbet är utfört
- markerar bokningen som `paid` när Stripe skickar `checkout.session.completed` till webhooken

## Säkert RUT-formulär utan egen RUT-databas

RUT-uppgifter hanteras via:

- `rut.html`
- `supabase/functions/submit-rut/index.ts`

Flödet är:

1. kunden väljer RUT i bokningen
2. bekräftelsemejlet länkar till `rut.html`
3. `rut.html` hämtar namn, e-post, telefon och RUT-belopp från `rut-booking-details` med boknings-ID
4. kunden fyller bara i RUT-specifika uppgifter som personnummer och eventuell fastighetsbeteckning
5. `rut.html` skickar personnummer och RUT-belopp till Edge Function `submit-rut`
6. funktionen validerar uppgifterna server-side
7. funktionen sparar inte RUT-data i Supabase-tabeller
8. om Fortnox-token och Fortnox-dokument finns skickas underlaget till Fortnox `/3/taxreductions`
9. ett internt mail skickas utan personnummer som kvittens/status
10. om Fortnox-kopplingen saknas returnerar formuläret fel, så RUT-uppgifter inte tas emot och tappas bort

För att skapa en Tax Reduction i Fortnox behöver formuläret få ett Fortnox-dokument:

- `referenceDocumentType=INVOICE`, `ORDER` eller `OFFER`
- `referenceNumber=<Fortnox dokumentnummer>`

Utan dessa kan funktionen notifiera internt att koppling saknas, men den tar inte emot kundens RUT-underlag som lyckat. Det är medvetet: personnummer ska inte tappas bort, sparas i fel system eller skickas i mail.

## Nya kolumner för fönsterputs

Kör först SQL-filen:

- `supabase/migrations/20260426_add_fonsterputs_booking_fields.sql`

Den lägger till dessa kolumner i `bookings`:

- `address`
- `housing_type`
- `window_count`
- `service_scope`
- `addons`
- `payment_method`
- `consent_accepted`

Senare städas gamla dubbla kolumner bort med:

- `supabase/migrations/20260509_drop_duplicate_booking_columns.sql`
- `supabase/migrations/20260512_drop_unused_sensitive_booking_columns.sql`

De behåller `housing_type` istället för `house_size`, `address` istället för `location`, tar bort gamla `wash_type` och `service`, och tar bort oanvända känsliga fält som `personal_number` och `map_link`.

Kör sedan också:

- `supabase/migrations/20260505_add_boat_transport_fields.sql`

Den lägger till:

- `transport_type`
- `sea_miles`
- `coordinates`

För adminflödet, kör också:

- `supabase/migrations/20260504_add_admin_fields_and_policies.sql`
- `supabase/migrations/20260508_lock_down_booking_policies.sql`
- `supabase/migrations/20260510_restrict_booking_admins.sql`
- `supabase/migrations/20260511_move_admin_check_to_private_schema.sql`

Den lägger till:

- `price`
- `completed_at`

och policies så att bara användare i `admin_users` kan läsa, uppdatera och radera bokningar. Säkerhetsmigrationerna tar bort gamla publika policies och gör att en vanlig inloggad användare inte automatiskt blir admin.

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
- `BOOKING_NOTIFICATION_EMAIL=bokning@bergafonsterputs.se`
- `BOOKING_CONTACT_EMAIL=info@bergafonsterputs.se`
- `BOOKING_FROM_EMAIL=Berga Fönsterputs <bokning@din-domän.se>`
- `BOOKING_RUT_FORM_URL=https://...` om ni vill lägga RUT-formuläret direkt i kundens bekräftelsemejl
- `PUBLIC_SITE_URL=https://bergafonsterputs.se`
- `STRIPE_SECRET_KEY=sk_live_...`
- `STRIPE_WEBHOOK_SECRET=whsec_...`
- `FORTNOX_ACCESS_TOKEN=...` för första Fortnox-kopplingen till `submit-rut`
- `RUT_ALLOW_NO_FORTNOX=true` endast i testläge om formuläret ska acceptera utan Fortnox-postning

För produktion bör Fortnox OAuth-token hanteras med en liten privat token-store, eftersom Fortnox access tokens går ut och refresh tokens roteras. Den token-storen ska bara lagra integrationstokens, inte kundens RUT-uppgifter.

## Viktigt

`BOOKING_NOTIFICATION_EMAIL` är adressen som får nya bokningar. `BOOKING_CONTACT_EMAIL` är adressen som visas för kunden och används som svara-till-adress i kundmailen.

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
supabase functions deploy booked-slots
supabase functions deploy complete-booking
supabase functions deploy stripe-webhook
supabase functions deploy rut-booking-details
supabase functions deploy submit-rut
```

Om du vill sätta secrets från terminalen:

```bash
supabase secrets set RESEND_API_KEY=re_xxx
supabase secrets set BOOKING_NOTIFICATION_EMAIL=bokning@bergafonsterputs.se
supabase secrets set BOOKING_CONTACT_EMAIL=info@bergafonsterputs.se
supabase secrets set BOOKING_FROM_EMAIL="Berga Fönsterputs <bokning@din-domän.se>"
supabase secrets set BOOKING_RUT_FORM_URL="https://..."
supabase secrets set PUBLIC_SITE_URL=https://bergafonsterputs.se
supabase secrets set STRIPE_SECRET_KEY="$STRIPE_SECRET_KEY"
supabase secrets set STRIPE_WEBHOOK_SECRET="$STRIPE_WEBHOOK_SECRET"
supabase secrets set FORTNOX_ACCESS_TOKEN="$FORTNOX_ACCESS_TOKEN"
```

## Efter deploy

När funktionen är deployad kommer varje ny bokning från hemsidan att:

- sparas i Supabase
- skicka ett bokningsmail till er mail
- spara bokningen utan Stripe-länk i första bekräftelsemejlet
- visa tack-sidan utan direktbetalning
- skicka Stripe-länken i klartmailet när jobbet markeras som klart

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
