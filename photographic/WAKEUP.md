# Godmorgon

Kort: API + MCP går att köra lokalt **mot Postgres** eller in-memory. Riktig OpenAI-LLM finns bakom env-flagga. **Publik HTTPS finns nu** — `./scripts/public-mcp.sh` ger en URL Claude kan ansluta till.

## Fungerar nu

- **Publik HTTPS**: `./scripts/public-mcp.sh` → tunnel + API på ett värdnamn. Hela
  OAuth-dansen och `/mcp` verifierade utifrån, inklusive inloggningssidan i en riktig
  webbläsare
- REST + MCP + **inloggningssidan** på samma origin (OAuth/PKCE, verktyg, onboarding-flöden)
- **`createPostgresServices`** — hela `Services`-ytan mot lokal Postgres
- Sätt `DATABASE_URL` → servern kör Postgres; utan den → in-memory + FakeLlm
- `pnpm db:seed` — Emil + Buyersclub Ledning i Postgres
- e2e: samma 22-testresa grön mot memory **och** Postgres
  (`cd photographic/e2e && HARNESS=memory pnpm test` / `HARNESS=postgres pnpm test`)
- Schema + `pnpm db:migrate` / `pnpm db:reset`; migreringar är idempotenta
- Web-rum-UI på `:5173` — rum, **Kalender** (dagsvy + zoom till källan), **Godkänn**
  (approvals), **Klienter** (client health); demo-data som default. Live API:
  `VITE_USE_DEMO=0`
- **Kalendern**: `GET /v1/calendar/day?date=ÅÅÅÅ-MM-DD` och
  `GET /v1/calendar/events/:seq`. Dagsvy i webben på `/kalender/:date`. Vecka/månad/år
  är medvetet inte byggt — det härleds ur loggen när det behövs.

## Ändrat beteende värt att veta innan du demar

**Varje skrivning till ett delat rum går genom Godkänn-kön**, även när användaren ber om
det rakt ut. `explicit: true` räcker inte längre: flaggan sätts av modellen utifrån text
den läst, och en del av den texten kommer från dokument vi inte skrivit. Demovägen "lägg
det i Buyersclub Ledning" svarar därför `202` och lägger ett ärende i kön i stället för
att spara direkt. Godkänn det i `Godkänn` eller via
`POST /v1/memory/proposals/:id {"accept":true}`.

Inbjudningar är **engångs** nu. En länk som redan lösts in svarar not-found, så
demoskript som återanvänder samma token måste skapa en ny inbjudan per person.

## Riktig LLM (valfritt)

```bash
export PHOTOGRAPHIC_LLM=openai
export OPENAI_API_KEY=sk-...
```

Utan dem körs FakeLlm (tester och `pnpm dev` förblir deterministiska). På Fly:

```bash
fly secrets set OPENAI_API_KEY=sk-... PHOTOGRAPHIC_LLM=openai
```

## Fungerar inte

- **Omstart tappar Claudes koppling.** OAuth-klienter och tokens ligger i processminnet
  (`MemoryClientStore` / `MemoryTokenStore` i `apps/rest/src/wiring.ts`), så connectorn
  måste läggas till igen efter varje omstart. Spår 3 flyttar det till Postgres
- Tunnelns värdnamn är nytt varje körning, så en sparad connector i Claude slutar gälla
- Web-appen defaultar fortfarande till demo-data; live path: `VITE_USE_DEMO=0` + curls in `scripts/demo-api.md`
- Riktiga e-post/SMS-koder (dev skriver koden i loggen)
- Aktivitet i delade rum är fortfarande demo-data — byggs om som vy över händelseloggen

## Ett kommando

```bash
cd photographic && pnpm install && pnpm db:migrate && pnpm db:seed && DATABASE_URL=postgres://photographic:photographic@127.0.0.1:5432/photographic pnpm dev
```

→ `http://localhost:8787` — health `/health`, MCP `/mcp`.  
Signup-kod skrivs i loggen (`signup_code`).

Utan databas (fortfarande OK):

```bash
cd photographic && pnpm install && pnpm dev
```

## Publik MCP (så Claude kan ansluta)

```bash
export DATABASE_URL=postgres://photographic:photographic@127.0.0.1:5432/photographic
pnpm db:migrate && pnpm db:seed
./scripts/public-mcp.sh
```

Skriptet startar tunneln, startar API:t med rätt `PUBLIC_URL`, väntar tills värdnamnet
svarar utifrån och skriver ut `/mcp`-URL:en. Claude: Customize → Connectors → custom
connector. Signup-koden står i API-loggen (`grep signup_code`).

Inloggningssidan serveras nu från API:t, så det räcker med **ett** värdnamn. Utan bygge
av `apps/onboarding` finns ingen sida att skicka folk till — skriptet bygger den åt dig.

`npx untun` funkar inte (paketets CLI saknar shebang); skriptet kör cloudflared direkt.
macOS: `brew install cloudflared`. Detaljer och Fly: `scripts/deploy.md`.

## Om du bara ska veta en sak

Claude kan ansluta. `./scripts/public-mcp.sh`, klistra in `/mcp`-URL:en, logga in med
koden ur loggen. Efter en omstart måste connectorn läggas till igen — tokens ligger i
minnet tills spår 3 flyttar dem. Riktig LLM: `PHOTOGRAPHIC_LLM=openai` + `OPENAI_API_KEY`.

## MCP-rök (ketchup i instructions)

Morgonkoll att OAuth → `/mcp` initialize + `tools/list` funkar, och att profilen nämner den seedade ketchup-allergin: se `scripts/mcp-smoke.md` (helst `connect-flow.test.ts` + `e2e` med `HARNESS=postgres`, eller `./scripts/mcp-smoke.sh`). Session-token från signup räcker **inte** till MCP — bara OAuth access token.

**Live mot :8787:** `LIVE_MCP=1 LIVE_MCP_LOG=/tmp/rest-demo-api.log pnpm --filter @photographic/e2e test:live` (`e2e/src/live-mcp.smoke.test.ts`, skippad utan `LIVE_MCP=1`).

`test:live`, inte `test`: resan nollställer samma databas som den levande processen kör
mot, och parallellt drar de undan schemat för varandra.

**Live mot tunneln:** sätt `LIVE_MCP_URL` och `LIVE_MCP_PUBLIC_URL` till https-URL:en.
