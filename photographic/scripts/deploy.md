# Getting a public URL so Claude can connect

Claude reaches an MCP server from Anthropic's cloud, not from your laptop, so the
server has to be on the public internet.

**Today:** `DATABASE_URL` selects `@photographic/db`'s real `Services`. Without it the
process runs the in-memory reference implementation (data dies on restart). FakeLlm is
the default until `PHOTOGRAPHIC_LLM=openai` and `OPENAI_API_KEY` are set.

Two different jobs, two different sections below. **Local development** wants zero
setup and does not need to survive anything — a quick tunnel, below. **Production**
needs to be reachable from any device, all the time, whether or not anyone's laptop is
open — that needs a real host, not a tunnel from a machine that can sleep, lose power,
or be torn down. That is what "always connected" actually requires, and a tunnel alone
does not provide it: a stable hostname fixes *what a client calls*, not *whether
anything answers when it calls*.

## Production: `mcp.photographic.space` on Fly

**A tunnel is not the production answer.** `cloudflared` on a laptop dies when the lid
closes; on a Cloud Agent VM it dies when the VM is torn down. Both die with the machine.
"The memory must live in the cloud and always work from any device with internet" needs
a host that is itself always on — not a process tunnelling out of one that might not be.

**Why Fly, on the merits.** This repo already has the shape a deploy needs: a
`Dockerfile` that builds the one process serving REST + MCP on one origin, and a
`fly.toml` with a health check against `/health` and `min_machines_running = 1`. Fly's
own health check restarts a machine that stops answering; `auto_stop_machines = "off"`
means it is never scaled to zero to save cost. That is a real supervisor — "the process
crashed" and "the machine died" are both already handled — without installing or
maintaining one. Fly also issues and silently renews the TLS certificate for a custom
domain once it is attached (`fly certs`, below); a plain VPS would need that set up by
hand (a supervisor for the Node process, a reverse proxy, a cert renewal cron). The one
thing that made a durable Fly deploy premature — a database that had to stay reachable
from wherever the process happened to run — is what track 3 (Supabase, PR #2) removes.
Once storage is not on a laptop, there is no longer a reason to keep the process there
either.

**What is already prepared in this repo**, so this section is steps rather than design:
`fly.toml`'s `PUBLIC_URL` is fixed at `https://mcp.photographic.space` (not the
`*.fly.dev` origin), `auto_stop_machines = "off"` plus `min_machines_running = 1` (never
scaled down, ever), the existing `/health` check Fly uses to restart a machine that
stops responding, and `primary_region = "fra"` — Frankfurt, not Stockholm, because the
Supabase project (track 3) landed in `eu-central-1` (Frankfurt) rather than the
Stockholm this repo originally assumed. A single request is one round trip to the
client but several to Postgres — permission checks and reads are resolved per query, not
batched into one round trip (see `apps/mcp/src/dispatch.ts`: a single tool call routinely
makes three or more sequential calls into `services.*`, each at least one query) — so
co-locating the app with the database wins over shaving the one client-facing hop.
Stockholm would only win if most requests never touched Postgres, which is not this
app's shape.

### Steps

1. **Fly account.** `fly auth login` (or `fly auth signup`). This needs Emil's account
   and a payment method — see **Cost** and **Blocking** below; I do not have Fly
   credentials and could not run any of the following myself.
2. **Deploy.** From `photographic/`:
   ```bash
   fly launch --no-deploy   # only if the app does not exist yet in this Fly org
   fly deploy --ha=false
   ```
   `--ha=false` is not optional cost-shaving, it is the difference between the machine
   count that was costed and double it. Without it Fly creates a *second* machine on the
   first deploy of an `[http_service]` app — "Creating a second machine for high
   availability and zero downtime deployments" — regardless of `min_machines_running = 1`.
   That is a real trade (a one-machine deploy has a few seconds where nothing answers),
   but it doubles a $13.15/month machine to $26.30, and it is a decision to take
   deliberately rather than to inherit from a default. It also used to be actively
   harmful: with the old `LocalBlobStore` default, two machines meant an upload landed on
   one machine's disk and a later read could be routed to the other and find nothing.
   Builds from the existing `Dockerfile`. This can succeed and answer at
   `https://photographic.fly.dev` before the custom domain and cert are wired up in
   steps 4–6 — useful for confirming the container itself boots — but no client should
   register against that origin: `PUBLIC_URL` inside the container is already
   `https://mcp.photographic.space`, so the app *claims* an issuer that the `*.fly.dev`
   hostname does not yet answer to. Treat the bare `.fly.dev` origin as build-verification
   only, never as something to paste into Claude.
3. **Secrets** (not in `fly.toml` — anything reaching here is a secret, not config):
   ```bash
   fly secrets set CODE_SECRET=$(openssl rand -hex 32)      # see the table below
   fly secrets set SESSION_SECRET=$(openssl rand -hex 32)   # separate on purpose
   fly secrets set DATABASE_URL=postgres://...   # Supabase connection string, PR #2
   fly secrets set SUPABASE_URL=https://<ref>.supabase.co \
                   SUPABASE_SERVICE_ROLE_KEY=eyJ...   # document originals, see below
   fly secrets set OPENAI_API_KEY=sk-... PHOTOGRAPHIC_LLM=openai   # optional real LLM
   ```
   Without `DATABASE_URL` the deployed process runs the in-memory reference
   implementation — fine for proving the deploy boots, wrong for anything meant to
   persist or for Claude to actually use.

   **`SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` are not optional in production**, even
   though the process boots happily without them. They are what `resolveBlobStore` needs
   to pick `SupabaseStorageBlobStore`; without them it falls back to `LocalBlobStore` and
   writes document originals to the machine's own disk, which Fly replaces on every
   deploy. The failure is silent in the worst way: the upload succeeds, the extracted text
   stays in Postgres and stays searchable, and only the original file is gone. Check the
   boot log says `{"msg":"blob_storage","kind":"supabase"}` and not `"local"`.

   The bucket must exist first — the adapter does not create it, and a missing bucket
   surfaces as a `400` from Storage rather than as anything about configuration. Private,
   always; `signedUrl` is what hands out time-limited access:
   ```bash
   curl -X POST "$SUPABASE_URL/storage/v1/bucket" \
     -H "apikey: $SUPABASE_SERVICE_ROLE_KEY" -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY" \
     -H 'Content-Type: application/json' \
     -d '{"id":"documents","name":"documents","public":false}'
   ```
   The key is readable headlessly from the Management API — no dashboard visit needed:
   `GET /v1/projects/{ref}/api-keys?reveal=true`, the entry with `name: service_role`.

   ### The signing secrets, and what breaks if each one changes

   Both were missing from this runbook, and the code fell back to a fresh `randomUUID()`
   per boot behind a warning nobody reads. In production both are now a hard boot failure
   instead, because a key that changes on every restart is not a degraded key — it silently
   invalidates everything it ever signed.

   | Secret | Signs | If it changes |
   | --- | --- | --- |
   | `CODE_SECRET` | the HMAC over `destination:code` for signup codes | every login code in flight stops verifying; a person mid-signup has to request a new one |
   | `SESSION_SECRET` | browser session tokens | everyone signed out of the web app; MCP clients are unaffected, since they hold OAuth tokens rather than sessions |

   **They are deliberately two variables.** One key doing both jobs cannot be rotated for
   either: rotating to invalidate leaked sessions would void every login code in flight,
   and rotating over a code concern would sign everyone out. It also concentrated blast
   radius — login codes pass through the application log, and anyone who obtained the key
   that signs them could mint a valid session for any `personId` they could see.
   `SESSION_SECRET` falls back to `CODE_SECRET` when unset, so an existing deploy keeps
   working until it is set.

   ### Two database roles

   The application has connected as the schema owner, which means an injection or mistake
   in application code reaches `DROP TABLE` — and the append-only guarantee is enforced by
   triggers the owner can disable, so "the log is the truth" has been resting on the
   application not making a mistake rather than on the database refusing one.

   Migrations need DDL; the application needs none. So:

   | Variable | Role | Needs |
   | --- | --- | --- |
   | `MIGRATION_DATABASE_URL` | the owner (`postgres` on Supabase) | DDL across `app`. Used only by `pnpm db:migrate`, including the boot migration |
   | `DATABASE_URL` | `photographic_app` | `SELECT/INSERT/UPDATE/DELETE`, sequences, `EXECUTE`. No DDL, no `TRUNCATE`, no writes to `app.schema_migrations` |

   Migration `0016_app_role_grants.sql` grants all of that, and sets default privileges so
   a table added later is covered without anyone remembering. It does **not** create the
   role, because a login role needs a password and that does not belong in the repository.
   One operator step, once:

   ```bash
   # 1. Create the role with a generated password, as the owner.
   psql "$MIGRATION_DATABASE_URL" -c "CREATE ROLE photographic_app LOGIN PASSWORD '<generated>'"

   # 2. Apply the grants. Before this the role can reach nothing.
   MIGRATION_DATABASE_URL=... pnpm db:migrate

   # 3. Keep the owner for migrations, point the app at the restricted role.
   fly secrets set MIGRATION_DATABASE_URL='<owner URL>' \
                   DATABASE_URL='<same URL with photographic_app and its password>'
   ```

   Order matters: set `MIGRATION_DATABASE_URL` in the same command as the new
   `DATABASE_URL`, or the next boot migration runs as the restricted role and fails.
   **Rollback** is one command — set `DATABASE_URL` back to the owner URL — because the
   grants migration is additive and changes nothing about the owner's own access.

   The grants block is guarded on the role existing, so it is a no-op on a database where
   it does not: local development, CI, and every deploy before step 1. That is what makes
   it safe to ship ahead of the switch rather than as part of it.
4. **Attach the custom domain and request a certificate:**
   ```bash
   fly certs add mcp.photographic.space
   fly certs setup mcp.photographic.space
   ```
   The second command prints the *exact* DNS record(s) this specific app needs right
   now — typically a CNAME to the app's own `<app>.fly.dev` target, sometimes with an
   additional `_fly-ownership` TXT record for domain-ownership verification. Fly's own
   output is the source of truth here, not this document guessing at it.
5. **DNS**, for each record step 4 printed:
   ```bash
   CLOUDFLARE_API_TOKEN=... ./scripts/cloudflare-dns-record.sh <TYPE> <NAME> <CONTENT>
   # e.g.
   CLOUDFLARE_API_TOKEN=... ./scripts/cloudflare-dns-record.sh CNAME mcp.photographic.space photographic.fly.dev
   ```
   `photographic.space` is already on Cloudflare's nameservers from the earlier tunnel
   work, so this is adding a record to an existing zone, not another nameserver change.
   Idempotent and safe to re-run; refuses to silently overwrite a record that already
   points somewhere else (`FORCE=1` if you really mean to repoint it). Leave `proxied`
   at its default `false` ("DNS only", grey cloud) — Fly's certificate issuance needs to
   see the record directly, and Cloudflare's proxy in front adds real complexity (SSL
   mode, an ownership record, potential validation loops) this script does not set up.
   Turn proxying on afterwards, deliberately, only if the CDN/WAF is wanted on purpose.
   **I did not run this myself.** The instruction for this round was explicit — do not
   create the DNS record from this VM — and separately, there is nothing to point it at
   yet: step 4's target does not exist until someone with Fly access completes steps 1–4.
6. **Confirm the certificate issued:**
   ```bash
   fly certs check mcp.photographic.space
   ```
   Re-run after DNS propagates if it is still pending.
7. **Verify from outside:**
   ```bash
   curl -fsS https://mcp.photographic.space/health
   ```
   From a different network than whatever deployed it — a phone on cellular, not the
   machine that ran `fly deploy` — because "reachable from any device" is the actual
   claim, and a curl from the deploying machine cannot tell the difference between that
   and "reachable from here."

### Requirements, checked against what is configured

| Requirement | How this satisfies it |
| --- | --- |
| Always-on | `min_machines_running = 1` + `auto_stop_machines = "off"` in `fly.toml` — never scaled to zero, not even under low traffic. |
| Survives restarts | Fly's own `/health` check restarts a machine that stops answering; a crash or a future `fly deploy` does not need anyone to notice. |
| `PUBLIC_URL` fixed as the issuer | `fly.toml`'s `[env]` sets it to `https://mcp.photographic.space` from the first deploy — never the `*.fly.dev` origin, so no client ever registers against the wrong issuer and then has it move. |
| HTTPS terminated properly | Fly terminates TLS at its edge (`force_https = true`), using the certificate from `fly certs` above; renewal is automatic once issued. |
| Reachable from any device | Once DNS (step 5) and the cert (step 6) are live: any HTTPS client, anywhere — no laptop, no tunnel process, nothing that has to stay open. |

### What this still needs from the platform track

A stable, always-on host answers "does the hostname keep working," not "does Claude
stay registered." OAuth client and token state currently lives in process memory
(`MemoryClientStore` / `MemoryTokenStore`, `apps/rest/src/wiring.ts`) — a `fly deploy`
replaces the running machine, and a crash-restart does too, both of which wipe that
memory exactly as a laptop restart does today. The hostname not moving does not stop
that: Claude's registration still needs to be re-added after every deploy until that
store is Postgres-backed. That file is explicitly out of scope for this branch (PR #2
owns OAuth storage) and nothing here touches it — flagging it because "always works" is
not true in practice until it lands, no matter how solid the hosting is.

### Cost, honestly

The `fly.toml` in this repo requests `shared-cpu-2x` with 2GB RAM. Run continuously —
which "always-on" requires, by definition — that is **$13.15/month in `fra`** (Fly's own
pricing table, checked 2026-09-15), not the $11.83 Stockholm (`arn`) figure Emil approved
before the region moved: Fly's per-second compute rate is region-dependent, and Frankfurt
carries a small markup over Stockholm — about $1.32/month more, roughly 11%. Real, but
small next to what co-location saves on every request (see above); not something to
re-litigate the region decision over, but worth Emil seeing the actual number rather than
the one he approved. No Fly-managed Postgres is added here; Supabase (track 3) is a
separate line the platform track owns, and its own regional pricing is a question for
that track, not this one. A dedicated IPv4 (~$2/month) is optional and not needed for the
CNAME-based custom domain in step 5. This needs a Fly account with a payment method
attached — I do not have access to Emil's Fly account or billing, and could not run any
`fly` command in the steps above myself.

### What is still blocking a permanent endpoint

1. **Fly account access.** Deploying needs Emil's (or a service's) Fly login and a
   payment method. I have neither, so steps 1–4 and 6 above are unexecuted by me.
2. **Supabase `DATABASE_URL`.** PR #2's migration. Without it, a deploy runs the
   in-memory reference implementation — provable, not usable.
3. **OAuth client/token persistence.** PR #2's storage work, see above — without it,
   every deploy still drops Claude's registration even on a hostname that never moves.
4. **The DNS record itself.** Deliberately not created from here: it has to point at the
   real Fly target from step 4, which does not exist yet, and the zone is still
   finishing propagation from the earlier nameserver switch. `scripts/cloudflare-dns-record.sh`
   is ready for whoever completes step 4 to run once that target exists.

## Local development: quick tunnel (default)

```bash
./scripts/public-mcp.sh
```

Brings up a Cloudflare quick tunnel, starts the API knowing the hostname it will be
reached on, waits until that hostname actually answers from outside, and prints the
`/mcp` URL to paste into Claude. Ctrl-C stops both. Zero setup, no account, nothing to
configure — the right default while developing, and it stays the default even now that
production is Fly, above.

Set `DATABASE_URL` first if you want the run to persist:

```bash
export DATABASE_URL=postgres://photographic:photographic@127.0.0.1:5432/photographic
pnpm db:migrate && pnpm db:seed
./scripts/public-mcp.sh
```

## Why one URL is enough

A client discovers everything from the MCP endpoint's own metadata, so the deployment
should be one hostname — and now is, in both places above. `apps/rest` serves the built
`apps/onboarding` app over every path the API has not claimed, which is what puts the
login page an authorization request redirects to on the same origin as `/mcp`.

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

## Named tunnel: a development convenience, not a production route

**This is not the path to a permanent endpoint** — that is Production, above, now that
Emil has decided on Fly. What a named tunnel is genuinely good for: a hostname that
survives across local dev-server restarts on your own machine, so a connector saved in
Claude does not need re-adding every time `public-mcp.sh` restarts during a work session,
and a real domain-scoped OAuth flow to test against without waiting on a deploy. It is
still, underneath, a `cloudflared` process on whatever machine started it — a laptop lid
closing or a Cloud Agent VM being torn down takes it down exactly like a quick tunnel,
just less often.

**Why this still matters even for development.** `PUBLIC_URL` is the OAuth issuer and
the protected-resource identifier. Every client that connects reads it from the MCP
endpoint's own metadata and embeds it at registration time; once that has happened, the
issuer cannot change out from under the client without breaking it. A quick tunnel makes
this concrete on every restart, because the hostname really does change. A named tunnel
fixes one hostname so it does not change between runs of a local dev session — useful for
that, and only for that.

The example hostname below is **`mcp.photographic.space`**, on **`photographic.space`**
(registered at Vercel, DNS hosted at Cloudflare). Substitute your own if doing this for a
different domain — nothing in `scripts/public-mcp.sh` or
`scripts/cloudflare-tunnel-setup.sh` hardcodes it.

### One-time Cloudflare setup

The zone has to be *on* Cloudflare — DNS hosting, not domain registration — because a
named tunnel's hostname is a CNAME to `<tunnel-id>.cfargotunnel.com`, and only Cloudflare's
own nameservers resolve that. Vercel keeps the registration; only DNS hosting moves. (This
is the same zone the Production section's DNS record above lives in — one migration, used
for both.)

1. **Add the site to Cloudflare.** Dashboard → **Add a site** → `photographic.space` →
   pick the Free plan. Cloudflare scans the existing DNS records and shows you two
   nameservers (e.g. `ns1.cloudflare.com`, `ns2.cloudflare.com` — yours will differ).
2. **Switch nameservers at Vercel.** Vercel dashboard → the domain → **Nameservers** →
   replace whatever is there with the two Cloudflare gave you. This is the one step that
   moves anything — registration, WHOIS, and billing all stay at Vercel. Propagation is
   usually minutes, can be up to ~24h; the Cloudflare dashboard shows the zone status
   change from "Pending Nameserver Update" to **Active** when it is done, and the setup
   below refuses to continue until it sees that.
3. **Create an API token.** Cloudflare dashboard → profile icon → **My Profile** → **API
   Tokens** → **Create Token** → custom token with exactly:
   - Account → Cloudflare Tunnel → **Edit**
   - Zone → DNS → **Edit**, scoped to the `photographic.space` zone
   - Zone → Zone → **Read**
4. **Get the account id.** Same dashboard, any domain overview page's right sidebar shows
   **Account ID**.

Those two values are secrets, not config — set them as environment secrets (e.g. Cursor
Cloud Agent secrets, or your own secret manager), never committed:

| Secret | Where it is used |
| --- | --- |
| `CLOUDFLARE_API_TOKEN` | `scripts/cloudflare-tunnel-setup.sh` (tunnel + DNS) and `scripts/cloudflare-dns-record.sh` (plain DNS records, e.g. for the Fly deploy above) |
| `CLOUDFLARE_ACCOUNT_ID` | `scripts/cloudflare-tunnel-setup.sh` only — DNS-only records do not need an account id |

### Running the setup

```bash
./scripts/cloudflare-tunnel-setup.sh
```

Idempotent — re-run it after a partial failure or a hostname change. It:

1. Confirms the zone that owns `TUNNEL_HOSTNAME` (default `mcp.photographic.space`) is
   active in your Cloudflare account. If it is not — nameservers not switched or not
   propagated yet — it stops here with that diagnosis rather than guessing.
2. Finds or creates a tunnel named `TUNNEL_NAME` (default `photographic-mcp`).
3. Points that tunnel's public hostname route at `http://127.0.0.1:$PORT` (default
   `8787` — this is the ingress Cloudflare uses, independent of wherever the tunnel
   process itself runs).
4. Creates the proxied CNAME `mcp.photographic.space → <tunnel-id>.cfargotunnel.com`, or
   confirms an existing one already points there. If a DNS record for that hostname
   already exists and points somewhere else, it refuses to overwrite it and tells you to
   resolve that by hand — clobbering an unrelated record silently is worse than stopping.
5. Fetches the tunnel token and writes it, with `TUNNEL_HOSTNAME`, to
   `/tmp/photographic-tunnel.env` (mode `600`; it holds a secret with the reach of the API
   token's scopes — delete it when you no longer need it).

Then:

```bash
source /tmp/photographic-tunnel.env
./scripts/public-mcp.sh
```

`public-mcp.sh` reads exactly `TUNNEL_HOSTNAME` and `TUNNEL_TOKEN` from the environment;
setting `TUNNEL_HOSTNAME` is what switches it from a quick tunnel to a named one, and it
refuses to start — rather than silently falling back to a random `trycloudflare.com`
hostname — if that variable is set without a way to authenticate the tunnel. The same
`/health`-through-the-tunnel check as the quick-tunnel path runs before it prints success,
because a named tunnel's DNS record can be missing or wrong in exactly the same
"cloudflared reports healthy, nothing outside can reach it" way a quick tunnel's can.

If you would rather drive the Cloudflare dashboard by hand instead of running the setup
script (useful for seeing the pieces, or if the token is missing a scope): **Zero Trust →
Networks → Tunnels → Create a tunnel** → Cloudflared connector, name it, then **Public
Hostname** tab → subdomain `mcp`, domain `photographic.space`, service `HTTP` →
`localhost:8787`. Saving that creates the DNS record for you. Copy the token from
**Overview → Add a replica** and set it as `TUNNEL_TOKEN`.

### Locally-managed alternative

If you already manage `cloudflared` credentials yourself (`cloudflared tunnel login` +
`cloudflared tunnel create`) rather than a remotely-managed token, `public-mcp.sh` also
accepts `TUNNEL_ID` (the id or name `tunnel create` printed) plus
`TUNNEL_CREDENTIALS_FILE` (the JSON it wrote) instead of `TUNNEL_TOKEN`. Point
`TUNNEL_ID + TUNNEL_CREDENTIALS_FILE`'s route at the same hostname with
`cloudflared tunnel route dns <id> mcp.photographic.space` once. `scripts/cloudflare-tunnel-setup.sh`
does not manage this path — it is API-token-only — but the runtime script supports either.

### Verifying

```bash
curl -fsS https://mcp.photographic.space/health
```

Should return the same health payload as `/health` on localhost. `public-mcp.sh` already
does this through the tunnel before it prints the `/mcp` URL — this is for checking it
again independently, e.g. from a phone on a different network, which is the actual claim
("reachable from the outside") rather than "reachable from the same machine that started
it." Note this is the same hostname the Production section above uses — do not run both
a named tunnel and the Fly deploy against the same hostname's DNS record at once; whichever
wrote the record last wins, silently, for the other.

### Diagnosing a half-finished setup

| Symptom | Likely cause |
| --- | --- |
| `cloudflare-tunnel-setup.sh` stops at "hittar zonen" with "Ingen zon ... äger ..." | Nameservers not switched at Vercel yet, or switched but not propagated. Check zone status in Cloudflare (must say **Active**). |
| Setup script fails immediately with "Saknar: CLOUDFLARE_API_TOKEN ..." | Secrets not set in this environment. They only reach newly started agents/shells — a shell that was already running before they were added will not see them. |
| Setup script fails on a Cloudflare API call with a `9109`/"Invalid access token" style error | Token missing a scope, wrong account id, or the token was scoped to the wrong zone. |
| Setup script refuses with "Det finns redan en CNAME ... som pekar på ..." | Something else already owns that hostname's DNS record. Fix it by hand in Cloudflare DNS, then re-run. |
| `public-mcp.sh` exits immediately with "TUNNEL_HOSTNAME=... är satt, men inga tunnel-credentials" | `TUNNEL_HOSTNAME` set without `TUNNEL_TOKEN` (or `TUNNEL_ID`+`TUNNEL_CREDENTIALS_FILE`) reaching this shell. Did you `source` the env file the setup script wrote? |
| `public-mcp.sh`'s tunnel dies within ~2s in named mode | Bad `TUNNEL_TOKEN`, or `TUNNEL_CREDENTIALS_FILE` unreadable/mismatched with `TUNNEL_ID`. Check `$TUNNEL_LOG` (printed on failure). |
| `https://mcp.photographic.space/health` never answers, cloudflared looks healthy | DNS record missing or points at the wrong tunnel; the tunnel's Public Hostname route points at the wrong port/scheme; or the zone is still propagating. `cloudflare-tunnel-setup.sh` is idempotent — re-running it re-asserts the ingress and DNS record and will surface a mismatch. |

## Pointing Claude at it

**Customize → Connectors → + → Add custom connector**, paste the `/mcp` URL, finish
OAuth. Add from web or desktop first; then it works on mobile too. For anything meant to
stay connected, that URL should be the Production one (`https://mcp.photographic.space`
once Fly is deployed) — a quick or named tunnel is fine for trying this out, but both are
tied to a machine staying up in a way production is not meant to be.

The sign-up code is not emailed yet — it is written to the API log as `signup_code`, so
have that log open while you connect:

```bash
grep signup_code /tmp/photographic-rest.log
```

**Reconnecting after a restart.** Two separate things determine whether Claude survives a
restart, not one. A stable hostname — a named tunnel in development, Fly in production —
fixes the issuer Claude registered against, so it is still valid after a restart of the
*process*. OAuth clients and tokens themselves are a different axis: they are held in
process memory (`MemoryClientStore` / `MemoryTokenStore` in `apps/rest/src/wiring.ts`), so
restarting the API — or, in production, a `fly deploy` replacing the running machine —
still drops the registration itself even with a hostname that never moves, and the
connector has to be added again. Moving those to Postgres is track 3's (PR #2's) work.
With a quick tunnel, both things break on every restart at once, which is easy to
misdiagnose as one problem when it is two.

## Pointing ChatGPT at it

Web + developer mode only. Mobile MCP does not exist; voice mode reportedly cannot
call connectors. Fallback: copy `/v1/context/rendered` into Custom Instructions.

## Verifying

```bash
B=https://mcp.photographic.space   # or https://<host>.trycloudflare.com in local dev
LIVE_MCP=1 LIVE_MCP_URL=$B LIVE_MCP_PUBLIC_URL=$B \
  LIVE_MCP_LOG=/tmp/photographic-rest.log \
  pnpm --filter @photographic/e2e test:live
```

Registers a client, runs PKCE authorize, approves it, exchanges the code and calls
`initialize` — every step a request Claude makes for itself. See `scripts/mcp-smoke.md`.
