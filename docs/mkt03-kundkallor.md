# MKT-03 – kundkälla och kampanj

Status 10 november 2026: **implementerat i en avgränsad release, lokalt verifierat och databasverifierat i riktig PostgreSQL med full återställning. Inte beständigt installerat eller publicerat. MKT-03 är inte slutgodkänt.**

Releaseunderlaget har isolerats från arbetsorder, företagsminne och agentprototyp. Användaren har avböjt ett nytt Supabase-testprojekt. Ingen separat testmiljö har skapats.

## Undersökning och återanvändning

- Webbplatsen är statisk HTML/JS. Bokning går via `booking.js` och Edge Function `create-booking`. Vanlig privatbokning är säsongsstängd; vårpaxning är öppen. Personliga bokningsinbjudningar använder det befintliga fyrstegsflödet. Säsongsreglerna har bevarats.
- `site.js` hade samtyckesstyrd UTM-lagring i sessionStorage och bokningar/vårpaxningar hade fem UTM-kolumner. Det saknades besöksgräns, extern hänvisares domän och kundens svar. Den separata UTM-skrivaren i `boka-google.html` har tagits bort så att den inte skriver över den gemensamma registreringen.
- Cookievalet `berga_cookie_consent=accepted` återanvänds. Samtyckets ändringshändelse återanvänds. Inga nya spårningscookies, personidentifierare eller externa tjänster har införts.
- Clarity-snapshots är aggregerade. Befintlig analys säger redan att bokningsevent/konverteringsgrad inte kan exporteras tillförlitligt. Dessa data används inte för att bestämma en boknings källa, och ingen kostnad per bokning eller bokningsgrad har lagts till.
- Den inledande inventeringen av produktionsdatabasen använde läsfrågor: 14 bokningar, inga med UTM-källa/kampanj och 12 med `price_before_rut`. Inga kundkontaktuppgifter behövde hämtas för denna undersökning. Ingen historisk källa har fyllts i.
- Befintliga manuella kontakter finns som `communication_events` kopplade till CRM-kunder. Fotoofferter mejlas och har ingen egen beständig offertpost. Den nya manuella källregistreringen lagrar därför en kort ärendereferens och kan kopplas till befintligt boknings-ID. Den ersätter inte CRM-kommunikationen eller offertinkorgen.
- Prisberäkningen på servern har separata kronor inklusive moms: `price_before_rut`, `labor_cost_before_rut`, `material_cost`, `transport_cost`, `rut_deduction`, `swish_amount`. `price_before_rut` är efter eventuell rabatt men före RUT. Slutförandet uppdaterar samma prisdelar. Befintlig ombokning uppdaterar samma bokningsrad.

## Källregel och besök

Automatisk insamling sparar den **senaste identifierbara externa källan i aktuell flik**, fram till bokning. Samma besök varar som längst till 30 minuters inaktivitet. Sidnavigering och interaktion förnyar aktivitetstiden. En avstängd flik avslutar normalt sessionStorage; webbläsare kan återställa sessionStorage vid sessionsåterställning. Tidsgränsen gäller även då. Flikar kan initialt få en kopia vid duplicering; därefter är deras lagring separat. Ingen spårning mellan enheter eller över längre besökshistorik sker.

- Externa ankomster med UTM-källa eller tillgänglig hänvisardomän kan ersätta föregående källa. En explicit rekommendationslänk (`ref`, utan lagrad identitet) är också ett underlag.
- Intern navigering, intern UTM-taggning och direkt återkomst raderar inte befintlig identifierbar källa.
- UTM source, medium, campaign, content och term sparas separat. En partiell UTM-ankomst utan identifierbar källa ersätter inte ett tidigare identifierbart underlag. Vid första ankomst kan partiella UTM-fält sparas utan att någon källa gissas.
- Efter samtycke används endast sessionStorage för besöksuppgifterna. Utan samtycke skickas ingen automatisk attribution. Vid nekad/återkallad åtkomst eller blockerad lagring används tomt underlag och bokningen fortsätter. Ingångsuppgifter före samtycket rekonstrueras inte från tidigare sidor.
- Bara hänvisarens domän sparas: aldrig dess sökväg, sökfråga, fragment eller andra parametrar. UTM-etiketter begränsas till 120 tecken, bokstäver, siffror, mellanslag och ett litet antal skiljetecken. E-postliknande strängar, URL:er, långa sifferföljder och för långa etiketter avvisas. Kontroll görs också på servern. Lägg aldrig personuppgifter i kampanjlänkar.
- Blockerare, utebliven referrer och integritetsinställningar kan begränsa underlaget. Ett tomt underlag betyder inte att kunden skrev webbadressen. UTM är uppgifter från länken, inte verifierat bevis på en annonsvisning eller betalning.

Rapportens prioritetsordning är:

1. Uttrycklig manuell korrigering, med administratör, tid och ändringsorsak.
2. Automatisk UTM-källa, annars extern hänvisardomän, annars explicit rekommendationslänk.
3. Kundens frivilliga svar, märkt **Självrapporterat**.
4. **Okänd källa** om inget underlag finns. Obesvarat och `Minns inte` lagras olika; båda ger okänd rapportkanal utan annat underlag.

Manuell korrigering kan återställas genom att tömma manuell källa och kampanj. Automatisk information och kundens originalsvar ändras aldrig av detta. Kampanj används bara när explicit kampanjunderlag finns. Partiell UTM-kampanj kan kombineras med självrapporterad kanal, med särskild märkning att kampanjen kommer från UTM. Byte till manuell källa använder endast den manuellt angivna kampanjen, så att en tidigare automatisk kampanj inte råkar följa med till fel kanal.

Betald/organisk anges endast utifrån uttryckligt medium, exempelvis `paid_social`/`cpc` respektive `organic_social`/`organic`. Google som hänvisare visas med **betald/organisk okänd**. Okända Google-domäner behålls som domän i stället för att gissas vara Google.

Vårpaxning är en befintlig förfrågan: när inbjudan blir bokning kopieras dess källunderlag atomiskt om bokningen saknar nyare automatisk källa. Kundsvaret är reserv om bokningens eget svar saknas. Hänvisningen `source_spring_reservation_id` och rapportens text visar att underlaget kommer från vårpaxningen. Detta är överföring av förfrågans uppgifter, inte spårning över besök. Vårpaxningen räknas aldrig som bokning i rapporten.

## Admin och rapport

Varje boknings detaljvy visar kundens svar, automatisk källa/domän, medium, kampanj, content/term samt rapportkälla och underlag. Bokningsväg hålls separat. Äldre bokningars bokningsväg är okänd när underlag saknas.

Under **Analys → Kundkällor och kampanjer** finns datumfilter på när bokningen **skapades**, inklusiva kalenderdatum i Europe/Stockholm. Tabellen grupperar på källa, kampanj och underlag. Underlaget skiljer exempelvis självrapporterat från automatiskt.

- Bekräftade/utförda bokningar räknas, inklusive inbjudningsbokningar i `pending` med verifierad mejlbekräftelse. Obekräftade, utgångna och avbokade räknas inte.
- Värdet är `price_before_rut / 1.25`. Om totalen saknas används endast en komplett uppsättning arbete + material + transport, dividerad med 1,25. RUT läggs aldrig till igen. Osäkra äldre värden lämnas tomma och antal saknade värden redovisas.
- Aktuellt pris och aktuell status läses vid varje rapportkörning. Prisändringar och avbokningar ändrar alltså även en tidigare periods rapport. Rapporten är bokat värde, inte redovisad omsättning.
- Ombokning av samma rad räknas en gång. `Boka samma igen` skapar ett nytt jobb och räknas som en ny bokning.
- Kundtyp bygger på tidigare bekräftade/utförda bokningar med samma trimmade, gemenerade mejladress. Första registrerade bokningen betyder **ny i registrerad historik**, inte bevis för att kunden aldrig tidigare anlitat företaget. Saknad mejladress ger okänd kundtyp. Återkommande är ingen kundkälla.
- Antal bokningar och unika mejladresser redovisas separat. Delade/bytta mejladresser och ofullständig historik begränsar kundräkningen. Summera inte unika kunder mellan kanaler.

### Manuella förfrågningar

Öppna **Registrera telefon-, mejl- eller meddelandeförfrågan**. Ange kort ärendereferens, källkod, eventuell kampanj, separat bokningsväg och ändringsorsak. Lämna boknings-ID tomt tills bokningen finns. Vid konvertering: registrera själva bokningen genom befintligt boknings-/efterhandsflöde, öppna sedan den sparade förfrågan och koppla till dess boknings-ID. Den sparade källan följer med i rapporten. Samma boknings-ID får bara ha en manuell källpost. Skapa ingen extra bokning för källregistreringen.

Kända källkoder föreslås i fältet, men egna tydliga källkoder går att registrera. Registrera inte `återkommande kund` som källa och lägg inte känsliga uppgifter i referens, kampanj eller ändringsorsak.

Manuell ändring kräver befintlig adminbehörighet, AAL2 och verifierad MFA-faktor. Saknad AAL-uppgift nekas också. Webbläsaren kan inte direkt skriva tabellerna eller ändra/revidera loggen. Sparning och loggning sker i samma transaktion. Versionskontroll förhindrar att en gammal vy skriver över en ny korrigering. De publika RPC:erna är SECURITY DEFINER enligt projektets befintliga mönster, med fast search_path, explicit behörighetskontroll och återkallad PUBLIC/anon-åtkomst. Se även [Supabases RLS-dokumentation](https://supabase.com/docs/guides/database/postgres/row-level-security).

## Databas och driftsättning

Migration: `supabase/migrations/20261102082305_mkt03_booking_attribution.sql`.

Den lägger till kundsvar, hänvisardomän, uppgift om spårningssamtycke och ursprunglig vårpaxningsreferens; återanvänder UTM-kolumnerna; skapar `marketing_entries` och `marketing_audit`, fyra adminskyddade RPC:er samt en trigger för vårpaxningens befintliga inbjudningskoppling. Inga gamla källor eller bokningsvägar fylls i. Ingen ny serverhemlighet behövs.

Driftsätt i denna ordning:

1. Granska migrationen och projektets övriga pågående ändringar. Arbetsträdet hade andra ändringar före MKT-03. Kör inte en bred `db push` eller publicera alla filer utan att först granska dessa.
2. Installera migrationen i en separat Supabase-testmiljö med befintlig bokningsdatabas, admin-/MFA-konfiguration och tidigare migrationer. Kör databasens advisors. Kontrollera kolumn-/funktionsåtkomst med riktig anon-token, vanlig användare, admin AAL1 och admin AAL2.
3. Deploya `create-booking` och `submit-spring-pax` till testmiljön, med testmiljöns befintliga konfiguration/secrets. Publicera de ändrade statiska filerna mot testmiljön. Ingen ändring av säsongsstängningen behövs; använd en riktig testinbjudan för bokning.
4. Testa riktig lagring, bekräftelse, mejl i avsedd testinkorg, vårpaxning → inbjudan → bokning, manuell förfrågan → befintlig bokning, behörigheter, prisändring, ombokning och avbokning. Kontrollera prisdelarna i databasen och rapporten.
5. Efter godkänd testmiljö och godkännande för produktion: ta ordinarie säkerhetskopia, installera just den granskade migrationen, deploya funktionerna och publicera de statiska filerna. Databasen måste uppdateras före funktionerna. De nya marknadsföringsfälten får inte tyst tappas genom schema-fallback.
6. Relevanta funktionskommandon: `supabase functions deploy create-booking --no-verify-jwt` och `supabase functions deploy submit-spring-pax --no-verify-jwt`. Kontrollera alltid valt projekt före körning. Publiceringen följer webbplatsens befintliga GitHub Pages-flöde, inte en ny hostingtjänst.

Ändrade klientdelar är `site.js`, `booking.js`, `paxning.js`, `bokning.html`, `boka-google.html`, `admin.html`, integritetstexten samt nya `marketing-admin.js` och `marketing.css`. Delade script har versionsmärkts om i alla befintliga publika ingångssidor. Adminens exakta CSP-hash har uppdaterats utan att säkerhetspolicyn försvagas.

Käll- och ändringsposter följer företagets beslutade gallringsrutin för bokningar/kontaktärenden. Ingen ny automatisk gallringstid har hittats på. Kopplade bokningar skyddas mot radering av källposternas FK; radering/gallring behöver hanteras samlat av behörig databasadministratör, inklusive loggens eventuella ärendereferenser. Företaget behöver dokumentera ansvarig och praktisk gallringsrutin före produktion.

## Verifiering

Automatiska tester kör riktig klientlogik, de riktiga serverfunktionernas validering och bokningshandler samt migrationens SQL i **PGlite (lokal PostgreSQL)**. Externa anrop är simulerade och inga mejl skickas på riktigt.

| Fall | Lokal verifiering |
|---|---|
| UTM-bokning med annat kundsvar | Riktig booking-handler → lokal PostgreSQL; fälten och rapportprioritet verifierade |
| Enbart extern hänvisare | Domän, kanal och okänd betald/organisk verifierade |
| Intern navigering/direkt återkomst/senaste externa källa | Gemensam besökslogik verifierad i DOM; 30 minuters utgång testad |
| Nekat/återkallat samtycke, blockerad lagring | Ingen automatisk källa; bokningshandler och klient fortsätter |
| Obesvarat respektive Minns inte | Olika lagrade värden; okänd rapportkälla utan annat underlag |
| Manuell förfrågan → bokning | DOM + SQL och webbläsare; unik koppling, original bevaras och ändringslogg skrivs |
| Vårpaxning → bokning | Befintlig inbjudningskoppling utlöser testad SQL-trigger; nyare automatisk källa bevaras |
| Avbokning, ombokning, prisändring | SQL-rapport omräknas utan extra bokning eller dubblerad RUT |
| Läsning och ändring | Anon, vanlig användare, admin AAL1 och admin utan AAL nekas; admin AAL2 tillåts; direkt tabellskrivning nekas |
| Adminens fel/samtidiga ändringar | Formulärdata bevaras vid fel; gamla revisioner och dubbel bokningskoppling nekas |

Webbläsarverifierat i det befintliga adminsystemet med syntetiska poster: rapport, manuell registrering och koppling till bokning. Kundflödets steg 1–3 och valfria kundfråga kontrollerade med nekade analyscookies. Mobilbredd 319 px: sidbredd 319 px i både admin och bokning, ingen överrullning av sidan; rapporttabellen rullar separat. Bilder finns i `docs/mkt03-admin-mobile.png` och `docs/mkt03-booking-mobile.png`.

Slutkontroll av den avgränsade releasen: `npm test` gav **85 godkända tester, 0 fel**, varav **9 MKT-03-tester**. `npm run lint` passerade. Det blandade lokala arbetsträdet hade tidigare 136 godkända tester; det är inte releaseunderlaget.

Den 10 november kördes migrationen och syntetiska integrationskontroller i den befintliga Supabase-databasens riktiga PostgreSQL inom `BEGIN`/`ROLLBACK`, med kort låstimeout. Kontrollerna verifierade rapportvärde, separata källunderlag, manuell förfrågan och unik bokningskoppling, ändringslogg och revisionskonflikt, prisändring, avbokning, ombokning, vårpaxningens överföring samt åtkomst för anon, utomstående användare, admin utan AAL, admin AAL1 och admin AAL2. Alla kontroller passerade. Efter återställningen verifierades att nya schemat och syntetiska bokningar saknades. Inga mejl skickades.

`node scripts/verify-marketing-rollback.mjs` skriver en granskningsbar transaktion till standardutmatning och ansluter inte till databasen. Kör med `--installed` endast när migrationen redan är installerad. Detta är en databasverifiering med återställning, inte ett verkligt HTTP-/mejltest i separat testmiljö.

Kör `npm test` och `npm run lint`. Isolerad interaktiv testvy: `node tests/marketing-preview.mjs`, sedan `http://127.0.0.1:8773/admin.html`. Testvyn använder endast lokal PostgreSQL och syntetiska uppgifter; CSP blockerar externa tjänster.

**Inte verifierat:** separat Supabase-testmiljö, verkliga mejl/HTTP-databastransaktioner i testmiljö, eller drift efter produktionspublicering. Användaren har avböjt nytt testprojekt; stegen 2–4 ovan är därför kvar som rekommenderad fullständig miljöverifiering och har inte utförts. Databastestet med återställning ersätter inte dessa steg.

Inför eventuell produktion: releasens två Edge Functions utgår från redan incheckad huvudgren. Produktionsfunktionerna har äldre versioner. Granska därför också huvudgrenens befintliga regler för vårinbjudan, säsongsstängning och mejlpresentation innan funktionerna ersätts. Övriga funktioner eller lokala migrationer ingår inte i MKT-03-releasen.

## Kampanjlänkar

Använd gemener och samma kampanjnamn konsekvent. Exempel, inte redan publicerade kampanjer:

- Organiskt Facebook-inlägg: <https://bergafonsterputs.se/bokning.html?utm_source=facebook&utm_medium=organic_social&utm_campaign=var2027&utm_content=inlagg_01>
- Instagram-profil: <https://bergafonsterputs.se/bokning.html?utm_source=instagram&utm_medium=organic_social&utm_campaign=var2027&utm_content=profil>
- QR-kod på flyer: <https://bergafonsterputs.se/bokning.html?utm_source=flyer&utm_medium=qr&utm_campaign=var2027&utm_content=akersberga_01>

`qr` innebär inte automatiskt betald trafik. Nuvarande vanliga besökare kommer till vårpaxningen; inbjudna kunder fortsätter till bokningen. Inga personliga inbjudningstoken ska finnas i offentliga kampanjlänkar.
