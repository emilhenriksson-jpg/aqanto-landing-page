# Godmorgon

Kort: API + MCP går att köra lokalt **mot Postgres** eller in-memory. Riktig LLM och publik HTTPS för Claude saknas fortfarande.

## Fungerar nu

- REST + MCP på samma origin (OAuth/PKCE, verktyg, onboarding-flöden)
- **`createPostgresServices`** — hela `Services`-ytan mot lokal Postgres
- Sätt `DATABASE_URL` → servern kör Postgres; utan den → in-memory + FakeLlm
- e2e: samma 22-testresa grön mot memory **och** Postgres
  (`cd photographic/e2e && HARNESS=memory pnpm test` / `HARNESS=postgres pnpm test`)
- Schema + `pnpm db:migrate` / `pnpm db:reset`; migreringar är idempotenta
- Web-rum-UI (demo-data) på `:5173`

## Fungerar inte

- Riktig OpenAI-LLM i processen (FakeLlm svarar deterministiskt; flagga saknas)
- Fly med durable Postgres + publik HTTPS så Claude Desktop kan ansluta på riktigt
- Web-appen är inte kopplad till REST ännu (demo-data)
- Riktiga e-post/SMS-koder (dev skriver koden i loggen)

## Ett kommando

```bash
cd photographic && pnpm install && pnpm db:migrate && DATABASE_URL=postgres://photographic:photographic@127.0.0.1:5432/photographic pnpm dev
```

→ `http://localhost:8787` — health `/health`, MCP `/mcp`.  
Signup-kod skrivs i loggen (`signup_code`).

Utan databas (fortfarande OK):

```bash
cd photographic && pnpm install && pnpm dev
```

## Publik MCP (så Claude kan ansluta)

**Snabbast — tunnel framför laptopen:**

```bash
DATABASE_URL=postgres://photographic:photographic@127.0.0.1:5432/photographic pnpm dev
npx untun@latest tunnel http://localhost:8787
```

Lägg till `/mcp` på https-URL:en. Claude: Customize → Connectors → custom connector.

**Fly:** `scripts/deploy.md`. Nu OK att sätta `DATABASE_URL` (Fly Postgres) — processen bootar mot riktiga portarna.

## Om du bara ska veta en sak

Persistensen är på plats lokalt. Det som saknas för “Claude svarar om dig” är en publik HTTPS-URL och (valfritt) riktig LLM bakom flaggan.
