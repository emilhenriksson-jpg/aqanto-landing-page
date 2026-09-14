# Godmorgon

Kortversionen: onboardingen är klar och testad. Det var den du var mest orolig för, och
det är den delen som är hårdast specificerad nu.

## Det du frågade om sist

**Hur hittar varje användare sin MCP-länk?**

Svaret blev: hon behöver ingen egen länk. Alla använder samma adress.

```
https://photographic.me/mcp
```

Inte `/mcp/emil`, inte `/mcp/<token>`. Identiteten kommer från inloggningen när man
kopplar, aldrig från adressen.

Det låter först sämre. En personlig länk känns omtänksam. Men en länk som innehåller en
hemlighet hamnar i skärmdumpar, i supportärenden och i fel fönster. Ska du dra tillbaka
någons åtkomst måste du byta en adress hon redan lagt in i fyra program. Och
rumsmedlemskap ändras hela tiden — allt som bakas in i en adress är fel i samma sekund
som någon lämnar ett rum.

En adress som är ofarlig att publicera kan inte läcka. Och den är kort nog att säga i
telefon till en kollega, vilket spelar större roll än det låter för något som sprids
via inbjudningar.

Priset är ett extra klick för att godkänna inloggningen. Det klicket är det som gör
resten säkert.

**Hur enkelt är det att koppla?**

| Program | Hur | Hur säkert kontexten kommer fram |
|---|---|---|
| Cursor | ett klick | läser serverns instruktioner |
| VS Code | ett klick | läser serverns instruktioner |
| Claude Code | ett kommando | hook vid sessionsstart |
| Claude | kopiera adressen, lägg in från web eller desktop | läser serverns instruktioner |
| Codex | ett kommando | bara när modellen själv frågar |
| ChatGPT | kopiera adressen, Developer mode, bara i webbläsaren | bara när modellen själv frågar |

Cursor och VS Code har riktiga ett-klicks-länkar. De två har olika format av rena
historiska skäl, och att linda Cursors i det `mcpServers`-objekt som `mcp.json`
dokumenterar är precis det som gör att Cursor vägrar. Ett test avkodar vår egen länk och
kontrollerar att inlindningen inte finns, så det kan inte glida tillbaka.

De andra har inga installationslänkar alls, så de får kopieringsknapp och numrerade
steg. Deras begränsningar står synligt, inte gömda i en tooltip:

- Claude-kopplingen måste läggas in från web eller desktop innan den fungerar i mobilen.
- ChatGPT fungerar bara i webbläsaren, och dess röstläge kan inte anropa connectors
  över huvud taget. Där är alternativet istället att kopiera din profil till Custom
  Instructions.

Jag skrev det rakt ut istället för att låta optimistiskt. Självsäkra instruktioner som
inte kan fungera kostar mer förtroende än en ärlig begränsning gör.

**Kan man skapa nya användare?**

Ja. Lösenordsfritt: e-post eller telefon, sexsiffrig kod, klart. Och den landar direkt
på kopplingsskärmen — att skapa konto och koppla sin AI är ett flöde, inte två ärenden.

Den som blir inbjuden till ett rum ser innehållet först, trycker gå med, skriver koden
och är inne. Personligt rum skapas tyst i bakgrunden. Hon möter aldrig en
registreringsvägg, för det är där inbjudningsloopen annars dör.

## Det jag är mest nöjd med

Kopplingsskärmen säger aldrig "klart" bara för att konfigurationen skrevs. Det kan vi
observera lokalt och det bevisar ingenting.

Istället står det:

> Öppna Claude och fråga: **Vad vet du om mig?**

och sen väntar skärmen. I samma sekund som profilen levereras slår den om:

> Claude anslöt 22:04 och läste din profil.

Kommer inget inom en dryg minut får hon en åtgärd skriven för just det programmet, inte
ett allmänt felmeddelande. Och kom kontexten fram via en svagare väg än det programmet
klarar, står det också.

Nästan alla i den här kategorin hoppar över det steget. Det är skillnaden mellan att
lita på minnet och att tysta sluta använda det.

## Läget i övrigt

Klart och testat:

- Grunden: databasschemat, domäntyperna och alla portgränssnitt. Schemat är applicerat
  och verifierat mot Postgres 16 med pgvector.
- `@photographic/connect`: registrering, installationslänkar, verifiering. 66 test, utan
  databas och utan nätverk.

Pågår: db, auth, rooms, ingest, projection, retrieval, documents, llm, rest, mcp, web,
voice. Alla har kod på plats men ingen har rapporterat färdigt än.

`e2e/src/journey.test.ts` är målet för hela bygget — 15 scenarier, från registrering
till att Claude får din profil till att en inbjuden person inte kan se ditt personliga
rum. Den rapporterar som **skippad**, inte grön, tills kompositionsroten finns. En svit
som blir grön av att inte göra något är sämre än en som fallerar.

## Två saker jag behöver av dig

1. **Opus-kvoten tog slut mitt i natten.** Subagenter kunde inte längre startas, så
   resten kördes av mig själv. Fyller du på kvoten kan arbetet parallelliseras igen.

2. **MCP-servern kan inte nås utifrån från bygg-VM:en.** Så jag kunde verifiera allt
   lokalt men inte mot en riktig Claude. `scripts/deploy.md` har de två vägarna: en
   tunnel om du vill testa på fem minuter, eller Fly för en riktig adress. Det är det
   enda som står mellan dig och att se det fungera i din egen Claude.

## Om du bara läser en fil

`CONNECT.md`. Den är kort och innehåller resonemanget bakom det enda beslut som resten
hänger på.
