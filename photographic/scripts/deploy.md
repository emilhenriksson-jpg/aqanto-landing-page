# Getting a public URL so Claude can connect

Claude reaches an MCP server from Anthropic's cloud, not from your laptop, so the
server has to be on the public internet.

**Today:** `DATABASE_URL` selects `@photographic/db`'s real `Services`. Without it the
process runs the in-memory reference implementation (data dies on restart). FakeLlm is
the default until `PHOTOGRAPHIC_LLM=openai` and `OPENAI_API_KEY` are set.

## Quick, for trying it out

```bash
pnpm install
pnpm db:migrate
DATABASE_URL=postgres://photographic:photographic@127.0.0.1:5432/photographic pnpm dev
npx untun@latest tunnel http://localhost:8787
```

Take the https URL it prints and add `/mcp`.

## Fly, with Postgres (recommended)

```bash
fly launch --no-deploy            # accept the existing fly.toml
fly postgres create --name photographic-db --region arn
fly postgres attach photographic-db
# optional real LLM:
fly secrets set OPENAI_API_KEY=sk-... PHOTOGRAPHIC_LLM=openai
fly deploy
```

Boot runs `pnpm db:migrate` then starts the server.
MCP: `https://<app>.fly.dev/mcp`. Health: `/health`.

## Fly, without Postgres (in-memory, data dies on restart / suspend)

```bash
fly launch --no-deploy
# Do NOT attach Postgres
fly deploy
```

## Pointing Claude at it

**Customize → Connectors → + → Add custom connector**, paste the `/mcp` URL, finish
OAuth. Add from web or desktop first; then it works on mobile too.

## Pointing ChatGPT at it

Web + developer mode only. Mobile MCP does not exist; voice mode reportedly cannot
call connectors. Fallback: copy `/v1/context/rendered` into Custom Instructions.
