# Bokning, Swish och manuell RUT

Webbplatsens aktiva betalningsflöde använder Swish Företag. Fortnox används inte för RUT och Stripe används inte för nya betalningar.

## Kundflöde

1. Kunden bokar och väljer om RUT ska användas.
2. `create-booking` räknar om priset på servern, sparar bokningen och skickar bokningsmejlet.
3. Vid RUT innehåller bokningsmejlet en tidsbegränsad engångslänk till `rut.html`.
4. `submit-rut` validerar och AES-256-GCM-krypterar personnumret. Klartext sparas aldrig i `bookings`, mejl eller loggar.
5. När arbetet är utfört klickar admin **Markera arbete utfört**. För ett RUT-jobb kan personnumret därefter visas kortvarigt så att den manuella fakturan kan skapas.
6. Admin fyller i fakturareferens, faktisk arbetstid och slutliga kostnader och klickar **Klart + skicka Swish**.
7. `complete-booking` skickar ett klartmejl med Swish Företag `123 677 43 84`, mottagare `Zac Hallgren`, exakt belopp, fakturareferens, mobilknapp och tydliga manuella betalningsuppgifter.
8. Betalningen kontrolleras manuellt i Swish Företag och markeras därefter som betald i admin. Först då kan RUT markeras som ansökt.
9. Den krypterade arbetskopian gallras manuellt när RUT-ärendet inte längre behöver den och automatiskt senast 180 dagar efter det senare av mottagandet och arbetsdagen, dock högst två år efter mottagandet.

Fakturan skapas och skickas utanför webbplatsen. `invoice_reference` kopplar Swishbetalningen och RUT-underlaget till den manuella fakturan.

## Aktiva Edge Functions

- `create-booking` – validerar tillgänglighet, räknar pris och skickar bokningsmejl.
- `booked-slots` – visar upptagna och spärrade datum.
- `validate-discount` – förhandskontrollerar rabattkod.
- `rut-booking-details` – verifierar RUT-länken utan att lämna ut kunduppgifter.
- `submit-rut` – validerar, krypterar och lagrar personnummer med en förbrukad engångstoken.
- `admin-rut-details` – adminskyddad visning, ny engångslänk, betalningskontroll, RUT-status och gallring.
- `complete-booking` – skickar klartmejlet med Swishuppgifterna.

`stripe-webhook` finns kvar i källhistoriken för äldre Stripe-betalningar men ingår inte i det nya flödet och ska inte deployas på nytt.

## Databas

Kör alla migrationer, inklusive:

```bash
supabase db push
```

Migrationerna `20260715000000_secure_manual_rut.sql`, `20260715010000_restrict_rut_link_reissue.sql` och `20260715020000_finalize_rut_security.sql`:

- hash-lagrar RUT-token och sätter 30 dagars giltighetstid
- skapar den låsta tabellen `rut_submissions`
- skapar åtkomstloggen `rut_submission_access_log`
- schemalägger automatisk gallring varje timme med `pg_cron`
- gallrar RUT-relaterade åtkomstloggar automatiskt efter två år
- lägger till separata belopp för arbete, material, transport, RUT och Swish
- lägger till statusfält för manuell RUT-ansökan
- återkallar äldre RUT-länkar som hade token i frågesträngen; admin kan skicka en ny fragmentbaserad länk
- spärrar direkta adminuppdateringar av betalnings-, RUT- och tokenfält; statusändringar går via kontrollerade serverfunktioner

`rut_submissions` saknar åtkomst för `anon` och `authenticated`. Endast serverfunktioner med service role får läsa eller ändra tabellen.

## Secrets

Följande behöver finnas i Supabase:

- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `RESEND_API_KEY`
- `BOOKING_FROM_EMAIL`
- `BOOKING_NOTIFICATION_EMAIL`
- `BOOKING_CONTACT_EMAIL`
- `PUBLIC_SITE_URL=https://bergafonsterputs.se`
- `BOOKING_RUT_FORM_URL=https://bergafonsterputs.se/rut.html` (valfri eftersom samma adress används som standard)
- `BOOKING_REVIEW_URL` (valfri)
- `RUT_ENCRYPTION_KEY` – unik 32-byte-nyckel, helst 64 hextecken

Skapa en ny krypteringsnyckel utan att skriva in den i Git:

```bash
supabase secrets set RUT_ENCRYPTION_KEY="$(openssl rand -hex 32)"
```

Nyckeln får inte bytas eller tas bort medan krypterade RUT-poster behöver kunna öppnas. Säkerhetskopiera den i en godkänd lösenordshanterare.

För den här driftsättningen finns en lokal reservkopia i macOS-nyckelringen med tjänsten `Berga Fönsterputs RUT encryption` och kontot `supabase-xeyippgcoqfskcmqzazx`. Själva nyckeln ska aldrig skrivas i dokumentation eller Git.

## Deploy

Admin använder den självhostade och versionslåsta webbläsarklienten `vendor/supabase-js-2.110.1.umd.min.js`. SHA-256 för den incheckade filen är `24f37921268bfba4d06c39de7ef5b205727310f908c4ca1c675610db0ec524cf`; uppdatera fil, SRI och CSP tillsammans vid versionsbyte.

```bash
supabase functions deploy create-booking
supabase functions deploy booked-slots
supabase functions deploy validate-discount
supabase functions deploy rut-booking-details
supabase functions deploy submit-rut
supabase functions deploy admin-rut-details
supabase functions deploy complete-booking
```

Kontrollera efter migreringen att cron-jobbet skapades:

```sql
select jobname, schedule, active
from cron.job
where jobname in (
  'purge-expired-rut-submissions',
  'purge-old-rut-access-logs'
);
```

## Prisregler

Följande hålls separerat i både bokning och admin:

- `labor_cost_before_rut` – faktisk arbetskostnad inklusive moms
- `material_cost` – ej RUT-grundande
- `transport_cost` – ej RUT-grundande
- `rut_deduction` – högst 50 procent av arbetskostnaden
- `price_before_rut` – arbete + material + transport
- `swish_amount` – kundens slutliga betalning

Rabattkoder gäller kundens arbetsandel. Vid RUT minskas både kundens arbetsandel och det preliminära RUT-beloppet symmetriskt; material och transport rabatteras inte.

## Admin och personnummer

Adminåtkomst styrs av `public.admin_users`, obligatorisk TOTP-baserad tvåstegsverifiering och `private.is_booking_admin()`. Vid första inloggningen registreras en authenticator-app med QR-koden i admin. Lägg helst samma hemlighet i en andra betrodd app eller enhet som reserv innan den första verifieringen slutförs.

Personnumret hämtas först när ett slutfört jobb öppnas aktivt av en tvåstegsverifierad admin, visas i högst en minut och skickas med `Cache-Control: no-store`. Visning är fail-closed om revisionsloggen inte kan skrivas. Statusändringar, betalningskontroll och gallring sker atomiskt med sin loggpost och loggarna innehåller aldrig personnummer.

Innan **Markera RUT ansökt** fungerar måste:

- bokningen vara markerad som slutförd
- Swishbetalningen vara kontrollerad och markerad som betald
- ett krypterat RUT-underlag finnas

Historiska Stripe- och Fortnoxkolumner lämnas kvar tills eventuell gammal bokföringshistorik har kontrollerats.
