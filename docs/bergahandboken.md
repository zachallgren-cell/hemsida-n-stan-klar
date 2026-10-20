# Bergahandboken – första versionen

## Befintligt system och lösning

Kontrollerat 20 oktober 2026. Webbplatsen är statiska HTML-, CSS- och JavaScript-filer. `admin.html` använder Supabase Auth, adminlistan `admin_users` och AAL2 (tvåstegsverifiering). Personalportalen använder `staff_profiles` och aktiva konton. Handboken återanvänder klientversionen 2.110.1, personalens design och dessa behörighetskontroller. Ingen ny JavaScript-dependency eller extern tjänst införs.

Bergahandboken är en egen flik i `admin.html`, med artikelredigeraren direkt i adminsystemets arbetsyta och befintliga Supabase-klient. Admin behöver inte lämna adminsystemet. `handbok.html` är personalens separata läsvy. Innehållsblock och redigeringskod återanvänds som en gemensam komponent. En inloggad användare utan aktiv personal-/adminbehörighet får inget innehåll. Sidans tomma skal och kod är statiska; artikelinnehållet är privat i databasen.

Redigerbart original: JSONB med `schemaVersion: 1`, `title`, `category`, `owner`, `order` och en ordnad lista `blocks`. Blocktyper: text, rubrik, steg, lista, informationsruta, bild, film, fil, extern länk och artikelreferens. Text är vanlig text, aldrig exekverbar HTML. Blockstruktur ger formaterat innehåll, enkel export och ingen koppling till en extern redigerartjänst. Inline fetstil/kursiv och tabeller ingår inte i första versionen.

## Installation och publicering av systemet

Koden och migrationen är förberedda i projektet. Den nya migrationen har testats i lokal PostgreSQL/PGlite, men har **inte körts i produktionsdatabasen**. Webbplatsändringarna har inte driftsatts.

1. Granska och tillämpa endast `supabase/migrations/20261020172122_bergahandboken.sql` i ordinarie migrationsflöde. Förutsätter befintlig personalmigration och privata behörighetsfunktioner. Kör inte alla väntande migrationer utan separat granskning.
2. Driftsätt `handbok.html`, `handbook.mjs`, `handbook-core.mjs`, `handbook.css` och de uppdaterade admin-/personalfilerna tillsammans.
3. Kontrollera med ett riktigt aktivt personalkonto och en admin med AAL2: skapa utkast, publicera, ändra utkast, öppna läsvyn igen och testa en bilaga. Testa faktiska videolänkar med personalens konton och nätverk.
4. Kontrollera Supabase Storage- och databasinställningar samt backup innan verkliga filer laddas upp. Behållaren är privat och begränsad till 50 MiB per fil och till listade filtyper. SVG/HTML/exekverbara filer tillåts inte.

För isolerad UI-förhandsvisning: `node tests/handbook-preview.mjs` och öppna `http://127.0.0.1:4174/admin.html` för redigeraren eller `http://127.0.0.1:4174/handbok.html` för personalens läsvy. Adminförhandsvisningen använder projektets riktiga menymarkup och handbokskomponent med ett begränsat testskal; övriga adminflikar är inte inkopplade där. Den använder tydligt märkt testinnehåll, en simulerad admin och webbläsarens localStorage, och kontaktar inte produktionsdatabasen. Den är ingen test av riktig inloggning eller Storage.

## Redigera och publicera

Öppna fliken Bergahandboken i adminsystemets vanliga sidomeny efter tvåstegsverifiering. Välj Ny artikel, ange rubrik, kategori, ansvarig och ordning. Välj innehållstyp och Lägg till block. Flytta block med upp/ned. Byt kategori för att flytta artikeln och sorteringsnummer för att ordna den inom kategorin. Egna kategorier kan skrivas direkt. De åtta föreslagna kategorierna finns som val.

Spara utkast bevarar arbetsversionen i databasen. Förhandsgranska utkast visar den innan publicering. Publicera byter den snapshot personalen läser. Det publicerade originalet påverkas inte av utkast eller återställning. Status visas i listan och ovanför redigeraren, och sidan varnar vid osparade ändringar. Versionskontroll med radlås och förväntat revisionsnummer stoppar överskrivning från en annan admin. Vid konflikt bevaras formuläret; kopiera önskade ändringar och öppna artikeln igen för att arbeta från senaste revisionen. Ingen automatisk sammanfogning.

Versionshistorik visar innehåll, handling, tid och redigerarens stabila användar-ID. Återställning skapar en ny revisionspost och ett nytt arbetsutkast; publicera därefter vid behov. Arkivering döljer artikeln och dess filer från personalen men bevarar original och historik. Återaktivering återvisar eventuell tidigare publicerad version.

Artikelns stabila länk är `handbok.html?article=<UUID>` och överlever namn- och kategoribyten. Artikelansvarig anges som namn/funktion; senast redigerad registreras serverledes med Auth-användarens UUID och tid.

HAN-01 har inte tillhandahållits. Inga löner, bonusar, säkerhetsregler eller ansvar har hittats på. Artiklar skapas av er. Märk nya förslag som ”Förslag – behöver godkännas” och behåll dem som utkast tills innehåll och ansvar godkänts. Ange frivillig grannkontakt som frivillig när ett sådant godkänt avsnitt läggs in; ange inte bonusbelopp utan beslut.

## Jobbchecklistor

Handboken beskriver hur och varför; avprickning sparas fortfarande i jobbets befintliga checklista. Vid skapande av checklistemall kan en rad skrivas `Kontrollera utrustning | artikelns UUID`. Referensen sparas i befintliga `help_text`, kopieras till jobbet och blir ”Läs instruktionen i Bergahandboken” i personalportalen. Handboksartikeln ändras inte av avprickning. Befintliga hjälptexter fungerar som tidigare. Första versionen har inget artikelval i denna mallredigerare; UUID hämtas från artikelns webbadress.

## Filmer och åtkomst

| Källa | Beteende | Åtkomst och begränsning |
| --- | --- | --- |
| YouTube watch-, youtu.be-, shorts- och embed-länk | Inbäddad spelare på youtube-nocookie.com, med extern reservlänk | Ägaren måste tillåta inbäddning. Olistat kan ses och delas av alla med länken. Privat material kräver Googles egen behörighet och kan ge spelarproblem. |
| Vimeo standard- och player-länk | Inbäddad spelare; hash för olistade filmer bevaras; reservlänk | Kontrollera videons visnings- och domäninställningar, eventuell betalplan och lösenord. Privat film kan inte generellt bäddas in. Domänbegränsning ersätter inte personalinloggning. |
| Andra tjänster, exempelvis Drive, Loom och Teams/Stream | Klickbar länk | Deras egen inloggning/delning gäller. Ingen godtycklig iframe eller inklistrad embedkod accepteras. |
| Egen MP4/WebM | HTML-videospelare, filen sparas i privat Supabase Storage | Läsrätt kräver aktiv personal och referens i publicerad, oarkiverad artikel. Ingen automatisk konvertering/streamingoptimering; testa filens codec i måltelefoner. |

En extern länk lagrar bara länk och bildtext hos Berga; ingen kopia av filmen laddas upp till Supabase. Länkade tjänster kan samla egna användaruppgifter när spelaren laddas. Faktisk uppspelning/behörighet kan inte garanteras genom URL-formatet och måste provas med ett personalkonto. Webbläsaren skickar endast origin som referrer för spelaren, vilket hjälper domänkontroll och YouTube-kompatibilitet.

Egna filer ligger i den nya privata behållaren `handbook` i **befintliga** Supabase. Bilder hämtas autentiserat till lokala blob-URL:er. Film använder signerad URL med en timmes giltighet; kopierad URL fungerar tills den går ut även efter att kontot inaktiverats eller artikeln arkiverats. Ladda om sidan om spelaren behöver en ny URL. Nedladdade filer går inte att återkalla. Filer tas inte bort automatiskt när block tas bort: tidigare versioner behöver dem. Föräldralösa uppladdningar kan uppstå om artikeln aldrig sparas; städa först efter kontroll mot alla versioner.

Tekniskt underlag: [YouTube-inbäddning](https://developers.google.com/youtube/player_parameters), [YouTube-delning](https://support.google.com/youtube/answer/157177), [Vimeo-inbäddning](https://help.vimeo.com/hc/en-us/articles/12426259908881-How-to-embed-my-video), [Vimeos privata länkar/hash](https://help.vimeo.com/hc/en-us/articles/12427906892689-Use-oEmbed-with-private-videos), [Supabase Storage-behörigheter](https://supabase.com/docs/guides/storage/security/access-control).

## Kostnader innan driftsättning

Ingen ny betaltjänst har aktiverats. Projektets faktiska abonnemang/återstående kvot är inte verifierat genom faktureringspanelen. Offentlig [Supabase-prislista](https://supabase.com/pricing), kontrollerad 20 oktober 2026: Free omfattar 1 GB fillagring, 5 GB vanlig och 5 GB cachad utgående trafik. Pro börjar på 25 USD/månad och inkluderar 100 GB fillagring samt 250 GB vardera vanlig/cachad trafik; överskjutande fillagring 0,0213 USD/GB/månad, vanlig trafik 0,09 USD/GB och cachad 0,03 USD/GB. Projektets övriga förbrukning delar kvoten. Skatt, valuta och övriga tillägg kan tillkomma. Ingen planändring är gjord.

Exempel: en film på 40 MB sedd 100 gånger ger ungefär 4 GB utgående trafik, beroende på hur stor del som laddas. Privat lagring ger ingen automatisk videokomprimering. Håll filmer korta och komprimerade. Ny videoplattform, större filgräns eller betalplansändring ska kostnadsbedömas och godkännas före införande. YouTube/Vimeo-länkar skapar ingen Supabase-videolagring; ett separat konto hos tjänsten kan ha egna avgifter och begränsningar.

## PDF

Exportera publicerat till PDF hämtar publicerade artiklar på nytt, utan sökfilter, utkast eller historik. Utskriftsvyn innehåller innehållsförteckning, exportdatum, kategori, ansvarig, uppdateringsdatum och publicerat revisionsnummer. Välj Spara som PDF i webbläsarens utskriftsdialog. Ingen ny tjänst eller avgift. Bilder hämtas före utskrift. Filmer är länkade referenser i PDF, och uppladdade bilagor är märkta bilagor som laddas ner separat. Bifogade PDF:er slås inte automatiskt ihop med handbokens export. Sidnummer och slutlig paginering styrs av webbläsaren.

## Backup och återställning

Databas: `handbook_articles` innehåller original, publicerade snapshots, arkivflagga och metadata. `handbook_versions` innehåller revisionshistorik. Tabellerna har RLS och inga direkta API-rättigheter för personal/admin. Endast granskade RPC-funktioner med interna kontroller kan läsa/skriva. Service role har tabellåtkomst för operatörsbackup; den nyckeln får aldrig förekomma i klientkod.

Projektet innehåller inget automatiserat backupjobb för databasen eller bilagorna. Anslutna projektet och dess befintliga offentliga bildbehållare `puts-gp-public-photos` har kontrollerats, men tillgång, senaste körning och retention för Supabases hanterade backup kunde inte fastställas via tillgängliga verktyg. Betrakta inte detta som bekräftad backup. Kontrollera Database → Backups i Supabase innan drift. Enligt [Supabases backupdokumentation](https://supabase.com/docs/guides/platform/backups) omfattar databasbackuper inte själva Storage-filerna; dessa måste kopieras separat. Free behöver egna exporter; tillgängliga hanterade backuper/retention beror på plan.

För innehållsmigrering: admin-knappen Exportera original och historik ger JSON med artiklar och alla versioner. Den kopierar **inte** bilagornas binärdata. För fullständig handboksbackup finns `scripts/handbook-backup.mjs`: sätt `HANDBOOK_TOKEN` i operatörens processmiljö till en kortlivad befintlig AAL2-adminsession och kör `node scripts/handbook-backup.mjs /säker/sökväg/ny-backupmapp`. Klistra inte in token i kod, loggar eller Git. Exporten hämtar artiklar, historik och alla refererade filer, inklusive bilagor i äldre versioner, till `assets/`. Manifestet bevarar originalsökvägar, storlek och SHA-256. Det skrivs sist och endast vid lyckad kopiering. Exporten är avsedd för ett underhållsfönster utan samtidig redigering; inte en atomisk databassnapshot. Avbruten kopia utan manifest är inte en fullständig backup. För schemalagd operatörsbackup bör en separat säker lösning för autentisering och rotation först väljas; inget jobb har installerats.

Förvara exporterna krypterat med begränsad åtkomst och flera återställningspunkter. Bilagor och historik kan innehålla internt material. Full projektåterställning kräver även Auth-användare eftersom redigerar-ID:n är främmande nycklar.

Återställ i en separat testmiljö först:

1. Återställ Auth-användare, admin-/personalmodell och handboksmigrationen. Samma användar-ID:n behöver finnas (eller mappas uttryckligen vid systemflytt).
2. Kör `node scripts/handbook-restore-sql.mjs /backup/manifest.json /säker/restore.sql` för en granskbar transaktion. JSON-export från admin fungerar också för artikeldata. Skriptet skriver inte över en befintlig utfil. Granska och kör SQL med databasoperatörens verktyg. Skriptet stoppar om handbokstabellerna inte är tomma, och bevarar ID:n, snapshots, datum och historik.
3. Ladda upp varje `assets[].file` i den privata behållaren `handbook` under exakt `assets[].path` från manifestet, via Supabase Dashboard eller operatörens Storage-API. Kontrollera SHA-256 mot manifestet före uppladdning och använd manifestets `contentType` som filens MIME-typ. Återställ inte enbart metadata i `storage.objects`; filernas bytes krävs.
4. Verifiera antal artiklar/versioner och filhashar, prova utkast/publicerat och ladda ner bilaga med aktiv personal. Kontrollera att obehörig/inaktiv personal nekas.
5. Öppna för användare först efter godkänt återställningstest. Radera inte enda fungerande kopian vid fel.

Lokala tester verifierar serverbehörigheter, publicerad snapshot under utkastarbete, konfliktstopp, ny historik vid återställning, Storage-policyer och bevarad data efter databasomstart. Riktig Storage, videouppspelning, kontoinloggning och PDF-paginering behöver dessutom verifieras i driftmiljön.
