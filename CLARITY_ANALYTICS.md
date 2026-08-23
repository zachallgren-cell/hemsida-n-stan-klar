# Microsoft Clarity-analys

## Arkitektur

Webbplatsen är statisk HTML/CSS/JavaScript och publiceras från Git. Bokningsbackend, databas, Auth och schemalagda jobb körs i Supabase. Clarity laddas en gång från `cookie-consent.js`, först efter analyssamtycke. GA4 finns parallellt.

Integrationen består av:

- serverklienten `supabase/functions/_shared/clarity-client.ts`
- rapportlogik i `supabase/functions/_shared/clarity-analysis.ts`
- den AAL2-skyddade Edge Function-routen `clarity-analytics`
- dagliga aggregerade snapshots i `public.clarity_analytics_snapshots`
- adminfliken **Analys** i `admin.html`
- en nattlig, idempotent import via `pg_cron` och `pg_net`

API-tokenen används endast i Edge Function. Frontend får aldrig tokenen.

## Officiellt API och dokumenterade gränser

Integrationen använder endast:

```text
GET https://www.clarity.ms/export-data/api/v1/project-live-insights
Authorization: Bearer <JWT-token>
```

Parametrar är `numOfDays` (1, 2 eller 3) och upp till tre av Microsofts dokumenterade dimensioner: Browser, Device, Country/Region, OS, Source, Medium, Campaign, Channel och URL.

Microsoft dokumenterar följande gränser:

- högst 10 anrop per projekt och dygn
- endast rullande data för de senaste 1–3 dygnen
- högst 1 000 rader, utan paginering
- UTC i API-svaret
- aggregerade dashboardmått, bland annat trafik, scroll depth, engagement, sidor/referrer, dead/rage clicks, excessive scroll, quick backs och script/error clicks

Endpointen dokumenterar inte export av custom events, Smart Events, funnelsteg, heatmap-data eller råa session recordings. Admin visar därför dessa delar som **Ej tillgängligt** i stället för att uppskatta dem. Claritys webbgränssnitt kan fortfarande användas för recordings, heatmaps, Smart Events och manuella funnels.

## Konfiguration

Skapa en ny token som projektadmin i Clarity: **Settings → Data Export → Generate new API token**. Tokenen som tidigare delats i en chatt ska återkallas och ersättas.

Edge Function behöver:

```text
CLARITY_API_TOKEN=<ny roterad token>
CLARITY_PROJECT_ID=xogpsbqaar
CLARITY_API_BASE_URL=https://www.clarity.ms/export-data/api/v1
CLARITY_CRON_SECRET=<minst 32 slumpmässiga byte>
CLARITY_MOCK_MODE=false
CLARITY_ENVIRONMENT=production
```

Supabase tillhandahåller dessutom `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` och `SUPABASE_ANON_KEY`. Saknad Clarity-konfiguration ger ett tydligt, sanitiserat fel utan token eller stack trace.

Sätt hemligheterna utan att skriva dem i Git eller shellhistorik. Använd Supabase Dashboard för tokenen, eller en säker lokal hemlighetskälla. Lägg samma slumpmässiga cronhemlighet i Supabase Vault med namnet `clarity_cron_secret` och som Edge Function-secret `CLARITY_CRON_SECRET`. Värdena måste vara identiska.

## Import, cache och retention

Klockan 02:12 lokal tid i `Europe/Stockholm` hämtas tre aggregeringar för föregående rullande 24 timmar:

1. Source + Medium + Campaign
2. Device + OS + Browser
3. URL + Country/Region

Cron kör en lätt kontroll varje hel timme för att fungera korrekt över svensk sommar-/vintertid, men anropar Clarity endast under lokal timme 02. Uniknyckeln `(snapshot_date, project_id, dimension_key)` gör importen idempotent.

Admin använder 60 minuters server-cache. Den lokala säkerhetsbudgeten är nio reserverade anrop per Stockholmsdygn, en under Microsofts gräns. Varje faktiskt försök—även ett retry—reserveras atomiskt före nätverksanropet. 429 och 5xx hanteras utan att kundsidan påverkas. Endast säkra GET-anrop får exponential backoff; 429 upprepas inte automatiskt.

Snapshots gallras efter 270 dagar, i linje med Claritys nu dokumenterade nio månaders retention för aggregerad klick-/heatmapdata. API-token, recordings, DOM-innehåll och direkt identifierande kunddata sparas aldrig. Data Export-dokumentationen anger ingen separat rätt att lagra råa inspelningar; den instruerar användare att följa dataskyddsregler. Den här lösningen lagrar därför endast nödvändiga aggregat.

## Datum och rapporter

Admin har snabbval för 7, 14 och 30 dagar samt ett eget intervall på högst 270 dagar. Lokal period används för urval, medan varje API-snapshot behåller exakta UTC-tider. Eftersom API:t saknar historiska intervall kan rapporten inte fylla dagar före aktiveringen.

Sessioner summeras från dagliga device-snapshots. Användare är en summa av dagliga unika användare och kan inte dedupliceras över flera dagar. Detta märks tydligt i admin.

Trafik grupperas konservativt utifrån Source, Medium och Campaign till Facebook, Instagram, Google organic, Google Ads, Direct, Flygblad, Rekommendation och Övrigt. Osäker källa blir Övrigt. Ett inkommande `ref` bevaras endast som kategorin `referral`; råvärdet och kundidentitet sparas aldrig.

## Events och integritet

`site.js` skickar bara eventnamn till Clarity och skickar aldrig eventparametrar. Följande finns i kundflödet när handlingen verkligen sker:

- `booking_cta_click`
- `booking_started`
- `booking_step_1_complete` till `booking_step_4_complete`
- `price_shown`
- `booking_summary_shown`
- `booking_completed` först efter lyckad lagring
- `booking_error` endast vid ett faktiskt submitfel, inte vanlig fältvalidering
- `quote_request_started`, `quote_request_sent`, `phone_click`, `email_click`
- `referral_landing_view`, `referral_booking_started`, `referral_booking_completed`

`referral_link_shared` saknas eftersom projektet ännu inte har någon faktisk delningsfunktion. Inget syntetiskt event skapas. Formulär och den personliga bokningspanelen har `data-clarity-mask="true"`. Personliga hanteringsvärden ligger i URL-fragment, som inte skickas i HTTP-URL:en.

Kontrollera även Clarity-projektets Masking-inställning och behåll standardmaskning för input, siffror och e-post. Lägg aldrig kunddata i UTM-parametrar.

## Admin och manuell hämtning

Logga in i `admin.html`, slutför TOTP-verifieringen och öppna **Analys**. Endast en användare som passerar befintlig `private.is_booking_admin()` med AAL2 kan läsa rapporten eller göra API-anrop.

- **Hämta ny data** använder cache om dagens data är yngre än 60 minuter.
- **Testa API** gör ett minimerat Device-anrop och visar period, radantal och antal metrics. Token visas aldrig.
- 7/14/30 dagar och egna datum läser bara snapshots och förbrukar inga Clarity-anrop.

## Testläge och feltestning

Mockläge är avstängt som standard och får aldrig aktiveras i produktion. För lokal utveckling krävs både `CLARITY_MOCK_MODE=true` och ett icke-produktionsvärde i `CLARITY_ENVIRONMENT`. Admin ska då märkas **Testdata**. Mockdata får inte användas för beslut.

Enhetstesterna täcker giltigt/tomt/ofullständigt svar, 401, 429, timeout, dimensionsgräns, datumfönster, division med noll, enhetsandelar och källaggregering:

```bash
deno test supabase/functions/_shared/clarity-client.test.ts
```

## Driftsättning

1. Rotera den exponerade Clarity-tokenen och skapa en ny.
2. Sätt Edge Function-secrets och Vault-hemligheten enligt ovan.
3. Kör `supabase db push --dry-run --linked` och granska migrationen.
4. Kör `supabase db push --linked`.
5. Deploya `supabase functions deploy clarity-analytics`.
6. Publicera de statiska filerna.
7. Logga in med TOTP i admin och kör **Testa API** en gång.
8. Kontrollera `cron.job` för `import-clarity-analytics` och `purge-old-clarity-analytics`.
9. Kontrollera följande morgon att tre snapshots finns för datumet.

För att stänga av integrationen säkert: inaktivera cron-jobbet, ta bort `CLARITY_API_TOKEN` från Supabase secrets och återkalla tokenen i Clarity. Kundsidans Clarity-installation och bokningslogik fortsätter fungera oberoende av exportintegrationen.

## Felsökning

- 401: tokenen är ogiltig eller utgången; rotera den.
- 403: tokenen saknar Data Export-behörighet, eller admin saknar AAL2/allowlist.
- 429: invänta nästa Clarity-dygn; gör inte upprepade manuella test.
- timeout/5xx: tidigare snapshots visas fortfarande; försök senare.
- tom rapport: kontrollera period, cron, samtyckesgrad och att integrationen varit aktiv tillräckligt länge.
- saknade funnelmått: en dokumenterad API-begränsning, inte ett importfel.
