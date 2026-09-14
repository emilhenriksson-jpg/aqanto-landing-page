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

## Vill du se det direkt

Skärmarna finns byggda och går att titta på utan backend:

```
cd photographic && pnpm install
pnpm --filter @photographic/onboarding dev
```

Den öppnar en förhandsvisning på låtsasdata. Koden är `424242`. Alla sex
kopplingskorten beter sig som de ska, och verifieringsskärmen väntar ett par sekunder
och rapporterar sen Claude som ansluten, vilket är ungefär så lång tid en riktig
handskakning tar.

`?screen=invite` visar vad Jacob ser när du bjuder in honom. `?screen=connect` går
direkt till kopplingsskärmen.

## Är MCP rätt väg in?

Ja som ryggrad, nej som enda väg. Hela resonemanget ligger i `PROTOCOL.md`, men kort:

Inget annat är både tvåvägs och personligt inloggat. En läs-bara-koppling hade gjort
Photographic till en finare profilsida — det måste gå att säga "lägg det i Buyersclub
Ledning" inifrån samtalet. Och MCP bär instruktioner i systemposition, vilket är det
närmaste en garanti för "full kontext direkt" som finns i ett protokoll.

Men MCP har tre hål som inte är små. Det kräver installation, och efter Cursor och VS
Code blir det brant. Instruktionsfältet är rådgivande — vissa klienter slänger det, och
då kommer kontexten fram bara om modellen väljer att fråga. Och det finns helt enkelt
inte i ChatGPT:s röstläge, som är precis det fall produkten är till för.

Så fyra kompletterande vägar, rangordnade efter friktion och inte efter hur smarta de är:

1. **E-post och SMS in.** `emil@in.photographic.me`. Vidarebefordra en PDF, skicka en
   tanke. Kräver ingen installation alls, för appen är redan öppen — det är mejlen. Det
   här bör finnas före allt annat.
2. **Webbläsartillägg.** Det enda som faktiskt får in kontext i ChatGPT web, Gemini och
   Grok. Det är också vad konkurrenterna gör. Ärlig kostnad: det beror på någon annans
   DOM och går sönder vid omdesign, så det rapporterar leverans som alla andra kanaler
   istället för att tyst sluta fungera.
3. **Dela-menyn på telefonen.**
4. **Kopiera profilen.** Statisk och blir gammal, men fungerar överallt, även i röstläget.

## Instruktionerna till modellerna

Det här är egentligen produkten. Åtta verktyg, och beskrivningarna är skrivna som
beslutsunderlag snarare än dokumentation — varje verktyg säger lika tydligt när det
*inte* ska användas som när det ska. Vaghet där är precis det som fyller ett minne med
skräp.

Reglerna jag satte, utan att fråga dig:

- **Spara tyst** när det handlar om personen, håller över tid, är självbärande och under
  200 tecken. Att luta mot att spara är rätt här, men bara för att radering är billig och
  reversibel. En onödig rad kostar tre ord att ta bort; en missad kostar att du upprepar
  dig för varje modell i månader.
- **Fråga alltid** vid instruktioner, vid något som motsäger det som redan finns, vid
  känsliga uppgifter, och vid allt modellen *gissat* fram. Instruktioner alltid, hur små
  de än är: en felaktig instruktion ändrar varje ansluten modell samtidigt och du kan
  inte spåra orsaken efteråt.
- **Aldrig** uppgiften i sig, tillfälliga tillstånd, hemligheter, eller något från ett
  delat rum in i det personliga.
- **Bekräfta på en rad** med kortnamnet: `Sparat i ditt personliga rum (p-7k2m)`. Kort
  nog att ignorera, precis nog att agera på.

Reglerna ligger i verktygsbeskrivningen för `remember` och inte i systeminstruktionen,
så de når modellen i det ögonblick den bestämmer sig istället för att konkurrera med din
profil vid sessionsstart.

## Papperskorgen

Som du bad om. Radering flyttar till papperskorgen, ligger kvar i 30 dagar, och försvinner
sedan på riktigt. Trettio dagar för att det måste överleva en semester.

Och det är papperskorgen som betalar för friktionen jag tog bort någon annanstans:
eftersom "glöm det" går att ångra är verktyget instruerat att agera direkt istället för
att fråga "är du säker?", och det är medvetet *inte* märkt som destruktivt så att
klienterna inte lägger en bekräftelsedialog ovanpå.

Det tvingade fram ett beslut jag inte hade tagit annars. Att radera raden är ingen
radering så länge samma text ligger kvar i händelseloggen, och loggen är skrivskyddad i
databasen. Nu tillåter den exakt en mutation — från gallringsfunktionen, bakom en flagga
som alltid städas bort — och vägrar allt annat, inklusive DELETE. Spåret av *att* något
togs bort överlever gallringen; bara texten går. Verifierat mot databasen.

## Historiken

Att spara tyst är det som gör upplevelsen sömlös. Att inget registreras är det som gör
den okontrollerbar. Så allt en modell gjorde utan att fråga ligger i historiken, med
vilken modell som gjorde det och när.

Den roligaste biten är att du kan fråga vilken ansluten modell som helst *"hur vet du
det om mig?"* och få ett riktigt svar: vilken modell som sparade det, när, från vilket
rum, och om du godkände det. Den vanliga invändningen mot AI-minne är inte att det
glömmer, utan att det vet något oförklarligt. Ingen i den här kategorin gör det bra.

## Det jag lade till utan att fråga

**Import av dina befintliga ChatGPT-minnen.** Ett tomt minne har inget värde just den
dag du bestämmer om du ska behålla det, och du har redan fyrtio fakta liggande i
ChatGPT. Klistra in listan, få in allt.

Skillnaden mot konkurrenterna: inget skrivs. Varje rad blir ett förslag med en
godkänn-alla-knapp, för att svälja ett annat systems slutsatser tyst är att ärva dess
misstag utan att kunna se vilka av de fyrtio som var fel. Instruktioner kräver ett
uttryckligt ja även i en massgodkänning.

Den vägrar API-nycklar och kortnummer, och visar dem inte tillbaka på skärmen.

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
- `apps/onboarding`: de fyra skärmarna ovan. 18 test, och ett av dem kontrollerar just
  att ett knapptryck aldrig räknas som lyckad koppling.
- `@photographic/agent`: verktygen och instruktionerna. 39 test.
- Import av ChatGPT-minnen. Papperskorg och gallring i databasen, verifierad mot
  Postgres.

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

## Om du bara läser två filer

`CONNECT.md` för beslutet att alla delar samma adress, och `PROTOCOL.md` för varför MCP
är ryggraden men inte enda vägen in. Båda är korta.

Vill du se hur det faktiskt låter för modellen, öppna
`packages/agent/src/policy-text.ts`. Det är den filen som avgör om Photographic känns
sömlöst eller känns som ett formulär som tjatar.
