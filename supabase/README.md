# Bokning, Swish och manuell RUT

## BERGA PUTS-GP

Tävlingsfunktionen ligger i `puts-gp/` och är avgränsad från bokningsflödet.

### Lokal start och verifiering

Den publika sidan öppnas via `puts-gp/index.html`, TV-vyn via `puts-gp/live/` och
den MFA-skyddade tävlingsadminen via `puts-gp/admin/`. Kör exempelvis en lokal
statisk server från projektroten och öppna dessa adresser. Kontrollera koden med:

```bash
npm run lint
npm test
supabase db push --dry-run --linked
```

### Databas och admin

Kör migrationerna med `supabase db push` efter granskning. Lägg den person som
ska administrera tävlingen i befintliga `public.admin_users` och kontrollera att
personen har en verifierad TOTP-faktor. Tävlingsadminen accepterar endast AAL2.
Skrivningar går genom Edge Function `puts-gp-admin`, som ska deployas efter
migreringen:

```bash
supabase functions deploy puts-gp-admin
```

Testdata finns i `supabase/seed_puts_gp.sql` och får endast köras mot lokal- eller
utvecklingsdatabas. Den skapar 15 fiktiva deltagare.

### Sekretess, bilder och resultatlänkar

Telefonnummer, fullständigt namn, födelseår, samtycken och adminanteckningar
finns bara i RLS-skyddade tabeller. Den publika leaderboard-vyn och resultat-RPC:n
returnerar aldrig dessa fält. Deltagarbilder ska vara JPEG eller WebP och högst
3 MB. De ska beskäras/komprimeras i adminflödet före uppladdning till den publika
bucketen `puts-gp-public-photos`, och får bara få en publik URL när bildsamtycke
är registrerat.

Resultatkort använder den svårgissade tokenlänken
`/puts-gp/resultat.html?t=<uuid>`. GitHub Pages saknar route-rewrites, därför
används frågeparameter i stället för en dynamisk katalog per token.

### Tävlingsdagen

1. Skapa dagens event i tävlingsadminen och välj **Starta tävling**.
2. Registrera deltagare och välj en person från kön.
3. Space startar nedräkning och stoppar bara ett redan aktivt försök.
4. Ange straff, förhandsgranska, publicera och dela resultatkortet.
5. Välj **Pausa** vid avbrott och **Avsluta dagen** när eventet är klart.
6. Exportera CSV från adminen. Återställning inför nytt event sker genom att skapa
   ett nytt event – historiska event ska inte raderas.

Vid internetavbrott sparar adminen det aktiva försöket lokalt. Skriv också ned rå
tid manuellt som reserv. Publicera aldrig ett osynkroniserat resultat förrän
anslutningen är tillbaka; TV- och mobilvyn återansluter/pollar automatiskt.

### Ljud och drönarfilm

Ljudplatser ska ligga under `puts-gp/assets/sounds/` med namnen
`countdown.wav`, `start.wav`, `stop.wav`, `published.wav`, `record.wav` och
`podium.wav`. Byt dem mot lokala, licensierade WAV-filer före eventet och testa
ljud i webbläsaren innan TV-vyn öppnas. Drönarfil eller videolänk anges i
eventets `settings.droneVideoUrl`; den ska vara ljudlös som standard.

Webbplatsens aktiva betalningsflöde använder Swish Företag. Fortnox används inte för RUT och Stripe används inte för nya betalningar.

## Vårpaxning 2027

Den öppna privatbokningen är stängd resten av säsongen. Vanliga besökare på
`bokning.html` ser därför det korta, icke-bindande paxningsformuläret. Personliga
bokningsinbjudningar fortsätter att öppna det befintliga fyrstegsflödet.

Paxningar tas emot av `submit-spring-pax`, valideras och hastighetsbegränsas och
sparas i den RLS-skyddade tabellen `spring_2027_reservations` innan några mejl
skickas. Ett misslyckat mejlutskick får därför inte en mottagen paxning att gå
förlorad. I adminvyn **Vårpaxningar** kan en tvåstegsverifierad admin öppna
bokningen för en paxad kund. Kunden får då en personlig engångslänk och kan
välja en ledig lördag eller söndag mellan 1 mars och 15 juni 2027. En sådan
förturslänk reserverar inte kapacitet förrän kunden slutför bokningen.

Kör migrationerna före funktionsdeploy:

```bash
supabase db push
supabase functions deploy submit-spring-pax --no-verify-jwt
supabase functions deploy booking-invitation --no-verify-jwt
supabase functions deploy create-booking --no-verify-jwt
supabase functions deploy booked-slots --no-verify-jwt
```

## Kundflöde

1. Kunden bokar och väljer om RUT ska användas. `create-booking` räknar om priset på servern och skapar en reservation som måste bekräftas via mejl inom 24 timmar.
2. Kunden bekräftar via den personliga sidan `hantera-bokning.html`. Först då blockeras datumet. Inget andra bokningsmejl skickas efter bekräftelsen.
3. Vid RUT öppnar kunden efter bekräftelsen det tidsbegränsade engångsformuläret på `rut.html` direkt från den personliga bekräftelsesidan.
4. `submit-rut` validerar och AES-256-GCM-krypterar personnumret. Klartext sparas aldrig i `bookings`, mejl eller loggar.
5. Kunden kan via sin fragmentbaserade hanteringslänk ladda ner en kalenderfil, boka om, avboka, boka samma igen och välja en frivillig påminnelse efter 8 eller 12 veckor.
6. När arbetet är utfört klickar admin **Markera arbete utfört**. För ett RUT-jobb kan personnumret därefter visas kortvarigt så att den manuella fakturan kan skapas.
7. Admin fyller i fakturareferens, faktisk arbetstid och slutliga kostnader och klickar **Klart + skicka Swish**.
8. `complete-booking` skickar ett klartmejl med Swish Företag `123 677 43 84`, mottagare `Zac Hallgren`, exakt belopp, fakturareferens, mobilknapp och tydliga manuella betalningsuppgifter.
9. Betalningen kontrolleras manuellt i Swish Företag och markeras därefter som betald i admin. Först då kan RUT markeras som ansökt.
10. Den krypterade arbetskopian gallras manuellt när RUT-ärendet inte längre behöver den och automatiskt senast 180 dagar efter det senare av mottagandet och arbetsdagen, dock högst två år efter mottagandet.

Fakturan skapas och skickas utanför webbplatsen. `invoice_reference` kopplar Swishbetalningen och RUT-underlaget till den manuella fakturan.

## Aktiva Edge Functions

- `create-booking` – validerar tillgänglighet, räknar pris och skickar bokningsmejl.
- `booked-slots` – visar upptagna och spärrade datum.
- `validate-discount` – förhandskontrollerar rabattkod.
- `rut-booking-details` – verifierar RUT-åtkomsten utan att lämna ut kunduppgifter.
- `submit-rut` – validerar, krypterar och lagrar personnummer med en förbrukad engångstoken.
- `admin-rut-details` – adminskyddad visning, ny engångslänk, betalningskontroll, RUT-status och gallring.
- `complete-booking` – skickar klartmejlet med Swishuppgifterna.
- `manage-booking` – bekräftelse, säker RUT-åtkomst, ombokning, avbokning och frivillig återkommande inbjudan med hashad kundtoken.
- `send-booking-reminders` – idempotenta 24-timmarspåminnelser och frivilliga inbjudningar efter 8 eller 12 veckor.
- `request-photo-quote` – tar emot högst tre validerade bilder och vidarebefordrar dem som mejlbilagor utan permanent bildlagring.
- `submit-spring-pax` – validerar och lagrar vårpaxningar samt skickar intern notis och kvitto till kunden.
- `booking-invitation` – hanterar både reserverade datum och adminstyrd förtursåtkomst för vårpaxningar.

`stripe-webhook` finns kvar i källhistoriken för äldre Stripe-betalningar men ingår inte i det nya flödet och ska inte deployas på nytt.

## Databas

Kör alla migrationer, inklusive:

```bash
supabase db push
```

Migrationerna `20260715000000_secure_manual_rut.sql`, `20260715010000_restrict_rut_link_reissue.sql`, `20260715020000_finalize_rut_security.sql`, `20260715030000_complete_booking_platform.sql` och `20260720010000_rut_on_confirmation_page.sql`:

- hash-lagrar RUT-token och sätter 30 dagars giltighetstid
- skapar den låsta tabellen `rut_submissions`
- skapar åtkomstloggen `rut_submission_access_log`
- schemalägger automatisk gallring varje timme med `pg_cron`
- gallrar RUT-relaterade åtkomstloggar automatiskt efter två år
- lägger till separata belopp för arbete, material, transport, RUT och Swish
- lägger till statusfält för manuell RUT-ansökan
- återkallar äldre RUT-länkar som hade token i frågesträngen; admin kan skicka en ny fragmentbaserad länk
- spärrar direkta adminuppdateringar av betalnings-, RUT- och tokenfält; statusändringar går via kontrollerade serverfunktioner
- låter bara mejlbekräftade bokningar blockera ett datum och förhindrar dubbla aktiva bokningar
- skapar hashade kundlänkar, säkra om-/avbokningar, rate limiting och automatiska påminnelsejobb
- öppnar kundens RUT-formulär först efter mejlbekräftelsen och kontrollerar bokningsstatus atomiskt när underlaget sparas

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
- `CLARITY_API_TOKEN` – roterad Data Export-token, endast i Edge Functions
- `CLARITY_PROJECT_ID=xogpsbqaar`
- `CLARITY_API_BASE_URL=https://www.clarity.ms/export-data/api/v1`
- `CLARITY_CRON_SECRET` – samma slumpvärde som Vault-hemligheten `clarity_cron_secret`

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
supabase functions deploy manage-booking
supabase functions deploy send-booking-reminders
supabase functions deploy request-photo-quote
supabase functions deploy submit-spring-pax --no-verify-jwt
supabase functions deploy booking-invitation --no-verify-jwt
supabase functions deploy clarity-analytics
```

Se `CLARITY_ANALYTICS.md` för API-begränsningar, säker aktivering, cache, retention och adminrapport.

Kontrollera efter migreringen att cron-jobbet skapades:

```sql
select jobname, schedule, active
from cron.job
where jobname in (
  'purge-expired-rut-submissions',
  'purge-old-rut-access-logs',
  'purge-booking-workflow-ephemera',
  'send-booking-reminders'
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
