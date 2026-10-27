# Intervjuinbjudningar

I Admin → Ansökningar öppnar du kandidaten. Under ”Bjud in till arbetsintervju” väljer du datum, svensk tid, längd, plats/möteslänk och mailmall. Lägg eventuellt till ett personligt meddelande, förhandsvisa och skicka. Uppföljningsformuläret sparas separat.

Tre mallar finns: varm och personlig, stilren och professionell samt kort och tydlig. Se `intervjumail-exempel.html` för de faktiska mallarna med exempeluppgifter.

Kandidaten behöver inget konto. Mailknapparna öppnar `intervju.html` med ett förvalt svar; kandidaten bekräftar sedan på sidan. Besök/länkförhandsvisningar registrerar aldrig ett ja eller nej. Svar sparas atomärt och visas när administratören öppnar ansökan igen. Ett nej betyder att tiden inte passar, inte att ansökan avslås. För att ändra ett redan lämnat svar kontaktar kandidaten Berga via mail.

## Installation

Databastilläggen och Edge Function installerades i produktion 2026-10-27. Migrationernas filnamn matchar produktionshistoriken. Inga riktiga intervjumail har skickats under verifieringen. Instruktionerna nedan beskriver installation och framtida publicering.

1. Kontrollera att de befintliga migrationerna för `job_applications` och REK-03 är installerade. Kör sedan enbart den nya migrationen `supabase/migrations/20261027163555_interview_invitations.sql` i rätt projekts migrationsflöde. Undvik att samtidigt publicera andra väntande migrationer från arbetskatalogen.
2. Publicera Edge Function `interview-invitation`, inklusive `interview-shared.mjs` och `_shared/read-json.ts`. Från projektroten: `supabase functions deploy interview-invitation --project-ref xeyippgcoqfskcmqzazx --use-api`. Konfigurationens `verify_jwt = false` behövs för kandidatens svarslänkar. Utskick kräver verifierad Auth-session och kandidatåtkomst genom befintlig RLS med admin- och MFA-kontroll.
3. Funktionen återanvänder serverhemligheterna `RESEND_API_KEY`, `BOOKING_FROM_EMAIL`, `BOOKING_CONTACT_EMAIL` och `PUBLIC_SITE_URL`, samt Supabases egna miljövariabler. Avsändaren ska vara verifierad i Resend. `PUBLIC_SITE_URL` måste peka på hemsidan där `intervju.html` publiceras, aldrig på en lokal förhandsvisning.
4. Publicera `admin.html`, `admin-applications.js`, `admin-applications.css`, `admin-interviews.mjs`, `interview-shared.mjs`, `intervju.html`, `intervju.css` och `intervju.mjs` tillsammans i webbplatsens vanliga publicering.
5. Gör ett godkänt provutskick till en egen testansökan och bekräfta svaret, innan riktiga kandidater kontaktas. Inget verkligt provutskick har gjorts i denna implementation.

## Leverans och åtkomst

En obesvarad inbjudan per kandidat reserveras före mailutskicket. Samma begärande-ID och Resend-nyckel återanvänds vid nätverksfel. Uppgifterna låses under ett osäkert försök; öppna ansökan igen för att återuppta en reserverad inbjudan. Det är avsiktligt att inte skapa en ny inbjudan medan leveransen är osäker.

Resends idempotensfönster är 24 timmar. Efter 23 timmar krävs manuell leveranskontroll i Resend och databasen innan ett osäkert utskick kan återupptas. Nytt utskick använder alltid en ny nyckel efter att det tidigare försöket har utretts. Obesvarade inbjudningar som passerat intervjustarten markeras utgångna när en ny inbjudan skapas. Svarslänken gäller fram till intervjustarten. Länken är personlig och bör inte vidarebefordras.

Databasen lagrar bara hash av svarstoken, och token lämnas inte ut i adminläsningar. Svarsendpointen returnerar endast intervjuuppgifter och svar, aldrig ansökan, namn eller interna anteckningar. Token ligger i URL-fragmentet, tas bort ur adressfältet efter läsning och används bara i POST-anrop. En rotation av service role-hemligheten påverkar återupptagning av ännu inte bekräftade utskick; redan skickade svarslänkar fungerar fortfarande via sin lagrade hash.

## Verifiering

`node --test tests/interview*.test.mjs tests/recruitment.integration.test.mjs tests/job-applications.test.mjs` testar tidszon, mail, faktiska serverhanteraren med simulerad transport, databas/RLS och båda gränssnitten. `node tests/interview-preview.mjs` startar en fristående lokal förhandsvisning med testdata på port 8772. Den skickar aldrig riktiga mail.
