# Getting a public URL so Claude can connect

Claude reaches an MCP server from Anthropic's cloud, not from your laptop, so the
server has to be on the public internet.

**Today:** the process runs the in-memory reference implementation and FakeLlm.
It exits if `DATABASE_URL` is set (`apps/rest/src/server.ts`). Migrations exist
(`pnpm db:migrate`) and the Docker image runs them when `DATABASE_URL` is present,
but do not attach Postgres until `@photographic/db` implements the ports.

## Quick, for trying it out

```bash
pnpm install
pnpm dev                       # :8787 — REST + /mcp, in-memory
npx untun@latest tunnel http://localhost:8787
```

Take the https URL it prints and add `/mcp`.

## Fly, without Postgres (in-memory, data dies on restart)

```bash
fly launch --no-deploy            # accept the existing fly.toml
# Do NOT: fly postgres attach …   # would set DATABASE_URL and the process exits
fly secrets set OPENAI_API_KEY=sk-...   # optional; unused until real LlmPort is wired
fly deploy
```

MCP: `https://<app>.fly.dev/mcp`. Health: `/health`.

## Fly, with Postgres (only once db ports land)

```bash
fly postgres create --name photographic-db --region arn
fly postgres attach photographic-db
fly deploy
```

Boot runs `pnpm db:migrate` then starts the server.

## Pointing Claude at it

**Customize → Connectors → + → Add custom connector**, paste the `/mcp` URL, finish
OAuth. Add from web or desktop first; then it works on mobile too.

## Pointing ChatGPT at it

Web + developer mode only. Mobile MCP does not exist; voice mode reportedly cannot
call connectors. Fallback: copy `/v1/context/rendered` into Custom Instructions.
