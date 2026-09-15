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

## Public MCP in ~60 seconds (tunnel)

Fly is better for something that stays up. For a morning demo, put HTTPS in front of
the local process:

```bash
# terminal 1 — API (Postgres optional but preferred)
DATABASE_URL=postgres://photographic:photographic@127.0.0.1:5432/photographic pnpm dev

# terminal 2 — pick one
npx untun@latest tunnel http://localhost:8787
# or: cloudflared tunnel --url http://localhost:8787
# or: ngrok http 8787
```

Set the tunnel origin so OAuth redirects and resource metadata match what Claude sees:

```bash
export PUBLIC_URL=https://<tunnel-host>   # no trailing slash
# if the rest process was already up, restart it with PUBLIC_URL set
```

Without `PUBLIC_URL` (or the equivalent `PUBLIC_URL` / `WEB_ORIGIN` your build reads),
authorize redirects can bounce to `http://localhost:8787` and the connector will fail
after login. Paste `https://<tunnel-host>/mcp` into Claude → Customize → Connectors.

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

## Verified locally

Docker was not available in this environment (`docker: command not found`), so the
image was not built. The Dockerfile build-stage compile step succeeded:

```bash
pnpm --filter @photographic/rest... run build
```
