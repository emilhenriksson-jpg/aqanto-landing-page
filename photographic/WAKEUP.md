# Godmorgon

Kort: API + MCP går att köra lokalt. Postgres och riktig LLM är **inte** inkopplade ännu.

## Fungerar nu

- REST + MCP på samma origin (OAuth/PKCE, verktyg, onboarding-flöden)
- In-memory-referens (`@photographic/services-memory`) + **FakeLlm** — ingen OpenAI-nyckel behövs
- Schema + `pnpm db:migrate` finns; migreringar är idempotenta
- Tester för connect / agent / auth / rest / mcp är gröna lokalt

## Fungerar inte

- **Postgres-portarna** — `@photographic/db` har pool + migrate, men implementerar inte `Services` ännu
- Servern **vägrar** `DATABASE_URL` medvetet (hellre krasch än tyst fake)
- Riktig LLM i processen (FakeLlm svarar deterministiskt)
- Fly med attached Postgres bootar inte förrän db-wiring landar
- e2e mot din riktiga Claude (kräver publik HTTPS-URL)

## Ett kommando

```bash
cd photographic && pnpm install && pnpm dev
```

→ `http://localhost:8787` — health `/health`, MCP `/mcp`.  
Signup-kod skrivs i loggen (`signup_code`).

Skärmar utan backend: `pnpm --filter @photographic/onboarding dev` (kod `424242`).

## Publik MCP (så Claude kan ansluta)

**Snabbast — tunnel framför laptopen:**

```bash
pnpm dev
npx untun@latest tunnel http://localhost:8787
```

Lägg till `/mcp` på https-URL:en. Claude: Customize → Connectors → custom connector.

**Fly:** `scripts/deploy.md`. Deploy **utan** `DATABASE_URL` (in-memory) tills db-portarna finns. Data dör vid omstart / machine suspend.

## Om du bara ska veta en sak

Det du ser lokalt är produkten på låtsas-persistens. Samma HTTP/MCP-yta — inte samma lagring.
