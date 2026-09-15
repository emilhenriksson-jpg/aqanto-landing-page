# Godmorgon

Photographic lever under `photographic/`. Läs **`photographic/WAKEUP.md`** för hela morgonbriefen.

## Ett kommando

```bash
cd photographic && pnpm install && pnpm db:migrate && pnpm db:seed && \
  DATABASE_URL=postgres://photographic:photographic@127.0.0.1:5432/photographic pnpm dev
```

→ API + MCP på `http://localhost:8787` (`/health`, `/mcp`). Signup-kod i loggen.

Web (demo-UI): `pnpm --filter @photographic/web dev` → `:5173`
(rum, Godkänn, Klienter). Live API: `VITE_USE_DEMO=0`.

Publik Claude: tunnel eller Fly — se `photographic/WAKEUP.md` och `photographic/scripts/deploy.md`.

MCP-morgonkoll: `cd photographic && ./scripts/mcp-smoke.sh` (OAuth connect-flow + e2e ketchup).
