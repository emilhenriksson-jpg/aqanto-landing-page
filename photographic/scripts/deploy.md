# Getting a public URL so Claude can connect

Claude reaches an MCP server from Anthropic's cloud, not from your laptop, so the
server has to be on the public internet.

**Today:** `DATABASE_URL` selects `@photographic/db`'s real `Services`. Without it the
process runs the in-memory reference implementation (data dies on restart). FakeLlm is
the default until `PHOTOGRAPHIC_LLM=openai` and `OPENAI_API_KEY` are set.

## One command

```bash
./scripts/public-mcp.sh
```

Brings up a Cloudflare quick tunnel, starts the API knowing the hostname it will be
reached on, waits until that hostname actually answers from outside, and prints the
`/mcp` URL to paste into Claude. Ctrl-C stops both.

Set `DATABASE_URL` first if you want the run to persist:

```bash
export DATABASE_URL=postgres://photographic:photographic@127.0.0.1:5432/photographic
pnpm db:migrate && pnpm db:seed
./scripts/public-mcp.sh
```

## Why one URL is enough

A client discovers everything from the MCP endpoint's own metadata, so the deployment
should be one hostname — and now is. `apps/rest` serves the built `apps/onboarding` app
over every path the API has not claimed, which is what puts the login page an
authorization request redirects to on the same origin as `/mcp`.

That matters because the browser app calls its API with same-origin relative paths and
relies on a Vite proxy that exists only on a laptop. Published behind one hostname
without this, the OAuth flow dead-ends after the redirect on an origin that serves no
HTML — and the only symptom is a blank page, long after every test has passed.

`scripts/public-mcp.sh` builds the app if there is no build. By hand:

```bash
pnpm --filter @photographic/onboarding run build
```

Overrides, when the pages really are published somewhere else:

| Variable | Effect |
| --- | --- |
| `PUBLIC_URL` | OAuth issuer, resource identifier, base of every URL the metadata hands out. Must be the hostname clients call. |
| `WEB_DIST` | Path to the built browser app. Defaults to `apps/onboarding/dist`. Set it empty to serve none. |
| `WEB_ORIGIN` | Where the login and connect pages live. Defaults to `PUBLIC_URL` when we serve them, `http://localhost:5174` when we do not. |

Boot logs `servingWebApp` and the `loginUrl` it will redirect people to. Check that line
before pasting anything into Claude: pointing the login page at a dev server that is not
running is the one way to break a connection that otherwise works.

## Tunnel, not Fly

A quick tunnel needs no account, no configuration and no database to move later, which is
the right trade while storage is still being decided (Supabase is the likely home). The
cost is that the hostname is new on every run, so a connector saved in Claude is
invalidated by the next restart. Fine for a demo, wrong for something kept connected.

**`npx untun` does not work.** It is the shorter command and this repo used to recommend
it, but `untun@0.2.2` ships `dist/cli.mjs` with no shebang, so npx's shim hands it to
`sh` and every line is a syntax error. It drives cloudflared underneath anyway; the
script uses cloudflared directly and downloads it on Linux if it is missing. On macOS:

```bash
brew install cloudflared
```

A quick tunnel occasionally prints a hostname that is never published in DNS, and
cloudflared reports a healthy connection either way. That is why the script checks
`/health` *through* the tunnel before printing anything. If it reports the URL does not
answer, run it again — you get a new name.

## Anything that stays up

Needs a stable hostname and a database that is not on the laptop. Hold off on a durable
Fly Postgres: storage is likely moving to Supabase, and the point of keeping this on a
tunnel is that nothing about the database becomes hard to move.

When that lands, the shape is unchanged — a container from the `Dockerfile`, `PUBLIC_URL`
set to the real hostname, and `DATABASE_URL` pointed at whatever hosts Postgres. Boot
runs `pnpm db:migrate` then starts the server. Nothing in the process knows or cares
which Postgres it is.

```bash
fly secrets set OPENAI_API_KEY=sk-... PHOTOGRAPHIC_LLM=openai   # optional real LLM
```

## Pointing Claude at it

**Customize → Connectors → + → Add custom connector**, paste the `/mcp` URL, finish
OAuth. Add from web or desktop first; then it works on mobile too.

The sign-up code is not emailed yet — it is written to the API log as `signup_code`, so
have that log open while you connect:

```bash
grep signup_code /tmp/photographic-rest.log
```

**Reconnecting after a restart.** OAuth clients and tokens are held in process memory
(`MemoryClientStore` / `MemoryTokenStore` in `apps/rest/src/wiring.ts`), so restarting the
API drops Claude's registration and the connector has to be added again. Moving those to
Postgres is track 3's work.

## Pointing ChatGPT at it

Web + developer mode only. Mobile MCP does not exist; voice mode reportedly cannot
call connectors. Fallback: copy `/v1/context/rendered` into Custom Instructions.

## Verifying

```bash
B=https://<host>.trycloudflare.com
LIVE_MCP=1 LIVE_MCP_URL=$B LIVE_MCP_PUBLIC_URL=$B \
  LIVE_MCP_LOG=/tmp/photographic-rest.log \
  pnpm --filter @photographic/e2e test:live
```

Registers a client, runs PKCE authorize, approves it, exchanges the code and calls
`initialize` — every step a request Claude makes for itself. See `scripts/mcp-smoke.md`.
