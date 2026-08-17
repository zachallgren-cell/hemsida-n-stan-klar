# Berga Fönsterputs – adminpanel v2

## 1. Konkret UX-granskning

### Nuläge

- Adminen är en enda statisk sida (`admin.html`) med inbäddad CSS och JavaScript. Supabase används direkt från webbläsaren efter lösenord, TOTP och AAL2-kontroll.
- Navigationen liknar den publika webbplatsen. De operativa vyerna ligger som flikar efter inloggning, medan “Startsida”, “Våra tjänster” och “Om oss” får större visuell tyngd än adminkommandona.
- Inloggningssidan lägger en mycket stor introduktion och en instruktionstavla före arbetet. Samma visuella språk fortsätter med stora kort, stora radier och mycket luft.
- En bokning renderas som ett fullständigt kort med kontaktuppgifter, cirka 15 detaljrutor, betalningsformulär, alla statusar, alla åtgärder och eventuellt hela RUT-flödet. Det gör listan svår att skanna och blandar översikt, redigering och riskfyllda åtgärder.
- Statusvärden blandas mellan svenska och engelska (`unpaid`, `paid`, svenska RUT-texter). Nästan alla knappar visas samtidigt, även när de är inaktiva.
- Spärrade datum lagras och visas dag för dag. Ett semesterintervall blir därför många repetitiva rader.
- Kunder, uppföljning och kommunikationshistorik är attribut på bokningen, inte egna arbetsytor.

### Viktigaste problem och effekt

1. **Låg informationsdensitet:** administratören ser få bokningar per skärm och måste minnas information mellan långa scrollningar.
2. **Otydlig nästa åtgärd:** primära och sekundära handlingar konkurrerar. Disabled-knappar beskriver systemets tillstånd i stället för att leda arbetet.
3. **Svag objektmodell:** bokning, kund, betalning, RUT och kommunikation presenteras samtidigt trots att de är separata mentala objekt.
4. **Ingen arbetskö:** data visas, men det finns ingen samlad prioritering av vad som behöver göras i dag.
5. **Risk i känsliga flöden:** befintligt RUT-skydd är tekniskt starkt, men det visuella bruset runt åtgärderna ökar risken för felklick.
6. **Begränsad mobilnytta:** de stora korten staplas, men blir fortfarande mycket långa.

### Funktioner som måste bevaras exakt

- Supabase Auth med personligt konto, lösenordssetup, TOTP och krav på AAL2.
- RLS-baserad adminåtkomst och den befintliga kontrollen i Edge Functions.
- Kundens mejlbekräftelse innan adminbekräftelse.
- `complete-booking`: idempotent klartmejl med Swishnummer, belopp, fakturareferens och prisuppdelning.
- `admin-rut-details`: bekräfta, markera utfört/betalt, skicka ny engångslänk, visa dekrypterat personnummer tillfälligt, registrera ansökt/godkänt/avslag och gallra.
- AES-256-GCM-kryptering, hashlagrade engångstoken, RUT-åtkomstlogg och automatisk döljning efter en minut.
- Påminnelsernas claim/recheck/idempotency-logik samt återkommande inbjudningar.
- Rabattkodernas användningsräkning och bokningarnas historiska rabattvärden.
- Spärrade datum, kapacitetsundantag och konfliktkontroller i databasen.

## 2. Ny informationsarkitektur

```
Admin
├── Översikt
│   ├── Nyckeltal
│   ├── Att göra i dag
│   └── Dagens / kommande bokningar
├── Kalender
│   ├── Dag / vecka / månad / lista
│   └── Bokningar + spärrad tillgänglighet
├── Bokningar
│   ├── Sparade vyer
│   ├── Filter och sökning
│   └── Bokningsdrawer
├── Kunder
│   ├── Kundlista
│   └── Kundprofil + aktivitet
├── Uppföljning
│   ├── Dagens uppgifter
│   ├── Recension
│   └── Återaktivering / leveransfel
├── Betalningar och RUT
├── Rabattkoder
├── Inställningar
│   ├── Tillgänglighet
│   ├── Mejmallar och automatiseringar
│   └── Analys
├── Visa webbplatsen
└── Logga ut
```

Översikt, listor och kalender delar samma bokningskälla. Full information renderas först när en bokning öppnas. Kund- och uppföljningsvyer kan initialt härledas från bokningar; persistenta CRM-fält introduceras separat så att frontendomläggningen inte kräver en riskfylld backendmigrering.

## 3. Textbaserade wireframes

### Översikt

```
[Sök kunder och bokningar…]                     [+ Ny bokning] [Aviseringar]
God morgon                                      Tisdag 18 augusti
[I dag 4] [Obekräftade 2] [Obetalda 3] [RUT 1]

Att göra i dag                                  Dagens bokningar
[!] Anna · Bekräfta bokning [Bekräfta]          09:00 Anna · Åkersberga
[$] Erik · Kontrollera betalning [Öppna]        13:30 Erik · Vaxholm
[R] Lisa · Hantera RUT [Öppna]                  16:00 Lisa · Täby
```

### Kalender

```
[I dag] [<] 17–23 aug [>]       [Dag] [Vecka] [Månad] [Lista] [Filter]
          Mån      Tis      Ons      Tor      Fre
08:00
09:00              Anna / Täby
10:00                       [Spärrat · Semester]
11:00
```

### Bokningar

```
[I dag] [Denna vecka] [Obekräftade] [Obetalda] [RUT]       [Filter]
Datum      Kund          Plats       Status       Betalning    Nästa åtgärd
18 aug     Anna Andersson Täby        Ny           Obetald      [Bekräfta]
19 aug     Erik Ek       Vaxholm     Bekräftad    Obetald      [Markera utfört]
                                                            [···]
                                                     ┌ Detaljdrawer ┐
                                                     │ Översikt ... │
                                                     │ Betalning... │
                                                     │ RUT ...      │
                                                     └──────────────┘
```

### Kunder

```
[Sök kund…] [Återkommande] [Ingen kommande bokning] [6 mån]
Kund             Senast        Nästa       Jobb   Kontakt       Nästa åtgärd
Anna Andersson   12 maj        18 aug      4      13 maj        Ingen åtgärd
```

### Uppföljning

```
[I dag] [Försenade] [Recension] [Inaktiva] [Misslyckade mejl]
Kund       Orsak                     Förfaller   Ansvarig    Åtgärd
Erik Ek    Utfört men obetalt        I dag       Zac         [Öppna]
Lisa Lund  Recensionsförfrågan       I dag       Zac         [Skicka]
```

### Betalningar och RUT

```
[Obetalda 3] [RUT redo 1] [Ansökta 2] [Avslag 0]
Kund       Faktura    Belopp     Betalning   RUT           Nästa åtgärd
Erik Ek    BFP-1042   1 269 kr   Obetald     Klar          [Kontrollera]
```

### Rabattkoder

```
Rabattkoder                                           [+ Ny rabattkod]
Kod        Typ       Värde   Användningar   Giltighet   Status   Åtgärder
SOMMAR20   Procent   20 %    4 / 50         31 aug      Aktiv    [Pausa] [···]
```

### Inställningar / tillgänglighet

```
Tillgänglighet                                  [+ Blockera tid]
2–22 juli 2026 · Semester                         [Redigera] [Ta bort]
29 augusti 13:00–17:00 · Utbildning              [Redigera] [Ta bort]
```

## 4. Föreslagen komponentstruktur

- `AdminShell`: fast sidebar, mobilmeny, topbar och vyrouter.
- `GlobalSearch`, `NotificationButton`, `ProfileMenu`, `PrimaryAction`.
- `MetricStrip`, `TodayTaskList`, `UpcomingBookings`.
- `CalendarToolbar`, `CalendarGrid`, `CalendarEvent`, `AvailabilityBlock`.
- `SavedViews`, `FilterBar`, `DataTable`, `Pagination`, `BulkActionBar`.
- `BookingRow`, `BookingDrawer`, `BookingOverview`, `PaymentEditor`, `RutWorkspace`, `ActivityTimeline`.
- `CustomerTable`, `CustomerDrawer`, `NextBestAction`, `CustomerTimeline`.
- `FollowUpQueue`, `FollowUpTaskRow`.
- `StatusBadge`, `EmptyState`, `LoadingState`, `Toast`, `ConfirmDialog`.
- `BlockedRangeRow`, `DiscountCodeTable`, `DiscountCodeDialog`.

Den första implementationen behåller vanilla HTML/CSS/JS och de befintliga DOM-/API-kontrakten. Komponentgränserna uttrycks som små renderingsfunktioner så att ett framtida ramverksbyte inte behöver kombineras med affärslogiska ändringar.

## 5. Datamodell för CRM, kommunikation och automatisering

### Kunder

`customers`: normaliserad kontakt, typ, livscykelstatus, senaste/nästa bokning, senaste kontakt, nästa uppföljning, recensionsstatus, kommunikationspaus, preferenser och ansvarig.

`customer_addresses`: flera adresser per kund utan att skriva över bokningens historiska adress.

`customer_tags` + `customer_tag_links`: filtrerbara taggar utan kommaseparerade fritextvärden.

`customer_notes`: separata interna anteckningar med skapare och tidpunkt.

### Kommunikation

`communication_events`: append-only tidslinje för planerat, skickat, misslyckat, hoppat över, avbrutet och pausat. Innehåller aldrig personnummer eller hemliga token.

`email_templates`: versionerade mallar med ämne, innehåll, tillåtna variabler och aktiv status.

`scheduled_messages`: unik idempotensnyckel, tidpunkt, mallversion, bokning/kund, status, antal försök och maskinläsbar stopporsak.

### Automatiseringar

`automation_rules`: trigger, fördröjning, villkor, åtgärd, stoppvillkor och aktiv status.

`automation_runs`: en rad per utvärdering med unik `(automation_id, idempotency_key)`, beslut, triggerdata, stopporsak och utförd tid. Detta gör körningarna idempotenta och granskningsbara.

`follow_up_tasks`: kund, bokning, orsak, rekommenderad åtgärd, förfallotid, ansvarig, status och uppskjutning.

`activity_log`: aktör, händelsetyp, objekt, tidigare/nytt värde och metadata utan känsliga RUT-värden.

Databasschemat finns som en separat, additiv migration. Den ändrar inte befintliga tabeller eller Edge Functions innan den uttryckligen körs.

## 6. Bokningsstatus och nästa åtgärd

| Faktiskt systemläge | Svensk visning | Primär nästa åtgärd |
| --- | --- | --- |
| `awaiting_confirmation` | Väntar på kundens bekräftelse | Vänta / kontakta kund |
| `pending` + mejlbekräftad | Ny | Bekräfta bokning |
| `confirmed` | Bekräftad | Markera arbete utfört |
| `completed_at` utan betalningsmejl | Arbete utfört | Skicka betalningsmejl |
| betalningsmejl skickat + `unpaid` | Väntar på betalning | Kontrollera betalning |
| `paid` + RUT `ready/not_ready` | Betald | Hantera RUT |
| RUT `submitted` | RUT ansökt | Registrera beslut |
| RUT `approved` eller ej RUT + betald | Slutförd | Ingen åtgärd |
| `cancelled` | Avbokad | Ingen åtgärd |

Statusen härleds från befintliga fält i stället för att skriva nya värden. Därmed behålls kompatibiliteten med befintliga Edge Functions och constraints.

## 7. Automatiseringar

| Regel | Utlösare | Villkor | Stoppvillkor / idempotens |
| --- | --- | --- | --- |
| Tack efter jobb | `completed_at` satt | Giltig mejl, kommunikation tillåten | En nyckel per bokning + malltyp; paus/avregistrering stoppar |
| Recensionsförfrågan | Slutförd bokning + 2 dagar | Ingen mottagen recension, ingen tidigare förfrågan | Stoppa vid mottagen/”ska inte kontaktas”; en förfrågan per jobb |
| Recensionspåminnelse | Förfrågan skickad + 7 dagar | Ingen recension och ingen tidigare påminnelse | Max en påminnelse per jobb; stoppa vid bounce/paus/avregistrering |
| Återaktivering | 3/6/12 månader efter senaste jobb | Ingen kommande bokning och kommunikation tillåten | Ny bokning, paus, avregistrering eller frekvenstak stoppar |
| Säsong | 11/12 månader efter senaste jobb | Ingen kommande bokning, inget nyligt återbokningsmejl | Samma stoppregler som återaktivering |
| Offertuppföljning | Offert/manuell kontakt + vald fördröjning | Ingen bokning och ej slutförd uppgift | Bokning eller slutförd uppgift stoppar |

Alla utskick skapas först som `scheduled_messages`. En worker gör en sista kontroll precis före leverans, använder en stabil idempotensnyckel hos både databasen och mejlleverantören och skriver alltid utfall/stopporsak till tidslinjen.

## 8. Prioriterad implementeringsplan

1. Frontendskal, ny navigation, global sökning, dashboard och svensk statusmappning.
2. Kompakt bokningstabell och en detaljdrawer som återanvänder befintliga säkra åtgärder.
3. Veckokalender och intervallgruppering av spärrade datum.
4. Härledd kundlista, betalnings-/RUT-kö och uppföljningskö på befintlig bokningsdata.
5. Additiv CRM-/kommunikationsmigration och administrativa RLS-policyer.
6. Mallredigering och schemalagd kommunikationsworker med dry-run, paus och idempotens.
7. Recensionsflöde, därefter återaktivering och säsongsregler.
8. Fördjupad aktivitetslogg, bulkåtgärder, sparade vyer och ansvarsfördelning.

## 9. Kritiska testfall

1. Ej inloggad användare kan inte se boknings-, kund- eller RUT-data.
2. Inloggad AAL1-användare stoppas vid TOTP; AAL2 öppnar adminskalet.
3. Ny bokning visar exakt en primär åtgärd och öppnas i drawer från lista, kalender och dashboard.
4. Kundbekräftelse krävs innan adminbekräftelse.
5. Markera utfört bevarar bokningsdata och skickar inget mejl av sig självt.
6. Klartmejl kräver fakturareferens, positivt Swishbelopp och giltig RUT-uppdelning.
7. Ett redan skickat klartmejl kan inte dubbelskickas.
8. Betalning kan inte markeras före utfört arbete.
9. RUT-personnummer kan endast öppnas via AAL2-Edge Function, loggas och döljs efter en minut/sidbyte.
10. RUT-avdrag över 50 % av arbetskostnaden stoppas.
11. Sammanhängande spärrade datum med samma orsak visas som ett intervall.
12. Konflikt med befintlig bokning varnas innan ett intervall spärras; bokningen flyttas eller tas aldrig bort automatiskt.
13. En recensionsförfrågan och högst en påminnelse kan skapas per bokning.
14. Mottagen recension avbryter alla väntande recensionsutskick.
15. Ny bokning avbryter väntande återaktiveringsutskick.
16. Global paus, kundpaus, avregistrering och bounce stoppar utskick med loggad orsak.
17. Rabattkod kan aktiveras/pausas utan att historiska bokningsvärden ändras.
18. Tangentbord kan nå navigation, filter, tabellrader, drawer och stängknapp; fokus återgår till öppnande rad.
19. Desktop, 1024 px, 768 px och 390 px saknar horisontell sidscroll.

