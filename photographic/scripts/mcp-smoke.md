# Morning MCP smoke

Prove that MCP on `http://localhost:8787/mcp` answers with a profile that knows a
seeded fact (ketchup allergy), without inventing a brittle curl dance.

**Honest constraint:** `/mcp` only accepts **OAuth access tokens**
(`oauth.introspect` in `apps/rest` wiring). A browser `session-…` token from
signup works for `/v1/profile` (see `scripts/demo-api.md`) but **not** for MCP.
The path that already works end-to-end is the REST connect-flow suite — same
composition as `pnpm dev`.

## Prefer this (no live server required)

These two commands are the morning proof. Run them from `photographic/`.

### 1. OAuth → MCP initialize + tools/list (HTTP, real socket)

```bash
pnpm --filter @photographic/rest exec vitest run src/connect-flow.test.ts
```

What it proves (mirrors a desktop client):

- unauthenticated `/mcp` → 401 + `resource_metadata` pointing at OAuth discovery
- dynamic client registration, PKCE authorize, signup code from logs, approve,
  code → access token
- `initialize` returns **instructions** (profile in system-prompt position)
- `tools/list` includes `remember`, `list_trash`, …

Helper to copy from: `mcpSession()` at the bottom of
`apps/rest/src/connect-flow.test.ts`.

### 2. Seeded / journey fact in MCP instructions (ketchup)

```bash
cd e2e && HARNESS=postgres pnpm test
# or memory: HARNESS=memory pnpm test
```

The journey asserts the handshake instructions contain `ketchup` after the fact
is approved (`hands the profile to Claude during the MCP handshake` in
`e2e/src/journey.test.ts`). That harness builds instructions the same way MCP
does; it does not open HTTP — pair it with (1) for the transport.

Optional one-liner wrapper: `./scripts/mcp-smoke.sh`.

## Live stack (boot + seed) — when you want localhost:8787 warm

```bash
cd photographic
pnpm install
export DATABASE_URL=postgres://photographic:photographic@127.0.0.1:5432/photographic
pnpm db:migrate
pnpm db:seed
# Seed: emil@photographic.me — personal room includes "Allergisk mot ketchup"
DATABASE_URL="$DATABASE_URL" pnpm dev
```

Health: `curl -sS http://127.0.0.1:8787/health`

Signup code for Emil (or any email) is logged as `signup_code` — same as
`scripts/demo-api.md`. That yields a **session** token. To call `/mcp` you still
need an **OAuth access token** (register → authorize → approve with session →
`/oauth/token`). Do not hand-roll that in the morning; run the connect-flow test
above, or finish the flow in a real client (Cursor / Claude connector) against
`http://localhost:8787/mcp` (or a tunnel — `scripts/deploy.md`).

### 3. Live HTTP against localhost:8787 (optional)

Requires REST already up (and preferably `pnpm db:seed` so Emil has ketchup). Codes are
logged as `signup_code` — point `LIVE_MCP_LOG` at that file (e.g. tee of `pnpm dev`).

```bash
LIVE_MCP=1 LIVE_MCP_LOG=/tmp/rest-demo-api.log pnpm --filter @photographic/e2e test:live
```

`test:live`, not `test`. The live smoke is excluded from the default e2e run because the
journey calls `reset(pool)` on the same database the live process is serving, and vitest
runs files in parallel: together they drop the schema mid-signup and fail with
`relation "app.person" does not exist`, which looks exactly like a broken product.

Skipped unless `LIVE_MCP=1`. Asserts `initialize` instructions contain `ketchup`.

### 4. Live HTTP against the public URL

Same test, pointed at the tunnel — every step is a request Claude makes for itself, so
this is the closest thing to the real client short of the client.

```bash
./scripts/public-mcp.sh          # prints the https URL it brought up

B=https://<host>.trycloudflare.com
LIVE_MCP=1 LIVE_MCP_URL=$B LIVE_MCP_PUBLIC_URL=$B \
  LIVE_MCP_LOG=/tmp/photographic-rest.log \
  pnpm --filter @photographic/e2e test:live
```

`LIVE_MCP_PUBLIC_URL` has to match too: it is the `resource` the authorize request names,
and the authorization server rejects one that is not its own (`invalid_target`).

### Manual initialize (only after you already have an access token)

If a client or the connect-flow helper already minted `ACCESS_TOKEN`:

```bash
# initialize — look for "ketchup" (or "Allergisk") in result.instructions
curl -sS -N -X POST http://127.0.0.1:8787/mcp \
  -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -H "authorization: Bearer $ACCESS_TOKEN" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"smoke","version":"0"}}}'

# then tools/list with the mcp-session-id header from that response
```

Unauthenticated POST to `/mcp` must be 401 — that alone is not a green smoke.

## What “green” looks like

| Check | Pass |
| --- | --- |
| connect-flow vitest | all green; instructions non-empty; tools include `remember` |
| e2e `HARNESS=postgres` | handshake instructions contain `ketchup` |
| live `/mcp` with OAuth token | `initialize` instructions mention ketchup / allergy for seeded Emil |
