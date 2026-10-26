# Visuell städning av Berga

Försiktig putsning av befintlig design. Webbplats, bokning, kundernas status-,
betalnings- och RUT-sidor, admin, personal, handbok och tävlingssidor använder
befintliga färger och komponenter. Typsnitt och textvikter har jämnats ut,
skuggor tonats ned och fokusmarkeringar förbättrats. Formulärtext på mobil är
minst 16 px för att undvika automatisk zoom vid inmatning. Sidfotens dubbla
rekryteringslänkar på startsidan, tjänstesidan och prissidan är borttagna.

## Mejl

`supabase/functions/_shared/email-presentation.ts` ger HTML-dokument och
mobilregler åt befintliga mallar. Enklare kvitton och adminnotiser får en
blå rubrikrad och ett vitt innehållskort. Befintliga utförligare mallar
behåller sitt innehåll, sina knappar och sin struktur.

Berörda funktioner:

- `create-booking`
- `complete-booking`
- `manage-booking`
- `request-photo-quote`
- `submit-spring-pax`
- `send-booking-reminders`
- `booking-invitation`
- `admin-rut-details`

Funktionerna behöver deployas tillsammans med sin delade fil för att mejlens
nya utseende ska börja användas. Ingen deploy ingår i denna ändring.
Mottagare, ämnesrader, svarsdresser, bilagor, personliga länkar,
idempotensnycklar och betalningsregler är bevarade.
Supabase Auths kontoinbjudningar och lösenordsmejl konfigureras separat hos
leverantören; de mallarna finns inte i projektet och har inte ändrats här.

## Lokal kontroll

Kör `npm run preview:polish` och öppna:

- `http://127.0.0.1:4176/` för webbplatsen.
- `http://127.0.0.1:4176/emails` för sex representativa mejl.
- `http://127.0.0.1:4176/review` för mobilbredder på 375 px.

Förhandsgranskningen tillåter endast statiska webbplatsfiler. Externa anrop och
formulärsändningar blockeras med CSP. Admin och personal visar sina inloggningsvyer.

Mejlen använder enbart syntetiska uppgifter. Paxningsmejlen fångas från den
riktiga hanteraren med ersatta nätverksanrop. Boknings- och klartmejlets
befintliga mallar renderas med testvärden för sina delavsnitt. Ändringsmejl
och påminnelse renderas via befintliga mallfunktioner. Förhandsgranskningen
är ingen fullständig simulering av boknings- eller betalningsflödet.

Verifiering: `npm run lint`, `npm test` och syntaxkontroll av de åtta berörda
Edge Functions. Mejltesterna kontrollerar bland annat escaping, belopp,
referens, personliga länkar, mottagare och idempotens. Visuell kontroll görs
i webbläsare på dator- och mobilbredd. Outlook/Gmail och andra faktiska
mejlklienter behöver ett separat testutskick vid driftsättning.

## Kundsidor: bokning och RUT

`customer-portal.css` är avgränsad till `hantera-bokning.html` och `rut.html`.
Sidorna har kompakt sidhuvud, normal innehållsbredd på mobil och gemensamma
blå knappar. Bokningsstatus, kundnamn, datum och pris syns direkt. Övriga
bokningsdetaljer, återkommande putsning, kalender och avbokning kan fällas ut.
RUT-formuläret visas före den utfällbara informationen om dataskydd.

De befintliga anropen, länkverifieringen och inmatningskontrollerna är bevarade.
Den lokala sidan `/rut-demo.html` visar formuläret med en syntetiskt verifierad
länk. Både den och `/hantera-bokning-demo.html` är statiska ögonblicksbilder
utan aktiva skript eller knappar, och finns bara i förhandsgranskningsservern.
