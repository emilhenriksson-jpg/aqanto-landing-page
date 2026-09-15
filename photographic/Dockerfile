# Single image: REST API + MCP on one origin (`apps/rest` mounts `/mcp`).
#
# Claude and ChatGPT reach MCP from their clouds, so this process must be on a
# public HTTPS URL — a laptop behind a firewall will never work for those clients.
#
# Runtime: `DATABASE_URL` selects `@photographic/db` (real Services). Unset falls
# back to `@photographic/services-memory`. FakeLlm unless PHOTOGRAPHIC_LLM=openai
# and OPENAI_API_KEY are set. Migrations run on boot when DATABASE_URL is present.
#
# One `DATABASE_URL` serves both the boot migration and the server, which is why
# the connection string has to be the **session-mode pooler on port 5432**: it is a
# real session so DDL is safe, it is not port 6543 so prepared statements stay on,
# and it is IPv4 so the same string works from Fly, from CI and from a laptop. See
# SUPABASE.md.

FROM node:22-slim AS base
ENV PNPM_HOME=/pnpm
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable
WORKDIR /app

# Dependencies, fetched from the lockfile alone.
#
# `pnpm fetch` needs only `pnpm-lock.yaml` — it populates the store without reading a
# single package.json. That matters more than it sounds: this stage used to `COPY` every
# workspace manifest by hand, and the list silently fell four packages behind. pnpm does
# not fail on a missing workspace manifest; it creates the dependency symlink anyway and
# skips installing that package's own dependencies. The image then built cleanly and died
# at startup with `Cannot find package '@photographic/core' imported from
# packages/delivery/src/errors.ts`.
#
# So the list is gone. Adding a package now requires no change to this file.
#
# The root `package.json` is the one manifest that still has to be here, and not because
# `pnpm fetch` reads it. `corepack enable` resolves the pnpm version from the nearest
# `packageManager` field, and with only the lockfile copied there is no field to find, so
# corepack quietly installs the newest pnpm instead of the declared one. That is not
# cosmetic: pnpm 11 turned `minimumReleaseAge` on by default (1440 minutes), which
# rejects a lockfile containing any dependency published in the last day and fails this
# stage with an error about the lockfile rather than about the version drift. Copying the
# root manifest pins pnpm to the `packageManager` version, which is the whole point of
# declaring one.
FROM base AS deps
COPY pnpm-lock.yaml package.json ./
RUN pnpm --version && pnpm fetch

FROM deps AS build
COPY . .
# `--offline` so this can only use what `pnpm fetch` already put in the store; a network
# fetch here would mean the lockfile and the image had drifted without anyone noticing.
RUN pnpm install --frozen-lockfile --offline
# Declaration emit for rest and its workspace deps. We still execute TypeScript
# with tsx at runtime — no separate JS bundle step yet.
RUN pnpm --filter @photographic/rest... run build
# The consent screen, built into the image rather than assumed to be hosted somewhere.
#
# `apps/onboarding` serves `/login`, which is where `/oauth/authorize` redirects a
# person's browser to approve a client. It is not a dependency of `@photographic/rest`,
# so the filter above does not reach it, and without its `dist` present
# `resolveWebDist` finds nothing and `webUrl` falls back to `http://localhost:5174` —
# the dev server's port. The deploy then looks entirely healthy and MCP answers, while
# `/oauth/authorize` 302s a remote user to localhost and no client can ever finish
# connecting. Building it here is also what makes `webUrl` equal `PUBLIC_URL`, because
# the login page is then on this origin.
RUN pnpm --filter @photographic/onboarding... run build
# The product itself: Rum, Kalender, Godkänn, Papperskorg, Historik, Fråga, Kompass.
#
# Also not a dependency of `@photographic/rest`, and it was missing for the same reason
# the consent screen was — with a worse symptom, because the onboarding app's catch-all
# answered every unclaimed path with its own shell. So `GET /kalender` returned 200 and
# `text/html` while the calendar was not served at all, and a nonsense path returned 200
# too. `mountWebApp` now only serves a shell for a route the app actually declares, so a
# missing build is a 404 rather than a plausible-looking wrong page.
#
# `VITE_USE_DEMO=0` is not a tuning flag, it is the difference between the product and a
# brochure. `isDemoMode()` returns true unless this is exactly `'0'`, and Vite bakes it in
# at build time — so without it the deployed app renders `demo.ts` fixtures and never
# calls the API. Every screen then looks right and belongs to nobody: `/kompass` showed
# six principles with one marked "Din egen formulering (p-cmp1)" on an account that had
# never set one. That is the same silent-success shape as the catch-all above, one layer
# up, and it survived the same way — by looking like a working page.
RUN VITE_USE_DEMO=0 pnpm --filter @photographic/web... run build

# Fail the build rather than the first boot if a workspace package cannot resolve its
# own dependencies. This is the exact failure the manifest list caused, and it cost a
# deploy to find; catching it here costs one second.
RUN node --import tsx -e "import('./apps/rest/src/wiring.ts').then(()=>console.log('import graph OK'),e=>{console.error(e);process.exit(1)})"

FROM base AS runtime
ENV NODE_ENV=production
ENV PORT=8080
COPY --from=build /app /app
EXPOSE 8080

# Migrate when Postgres is configured (idempotent), then serve.
#
# `pnpm db:migrate` goes through the same `createPool` as the server, so both get TLS
# from `resolveDatabaseTls` and both verify against the Supabase root shipped in
# `packages/db/certs`. That was not true before: the migration built a bare pool, never
# saw `SUPABASE_CA_CERT`, and failed the container here with "self-signed certificate in
# certificate chain" before anything was served.
# The migration's exit status decides whether the server starts.
#
# This was `;`, with no `set -e`, so a failed migration was logged and then the server
# started anyway against a half-applied schema. One audit read the old line as blocking
# startup; two others re-tested the shell and it does not, which is why the handling here
# is written out rather than left to `set -e` being read correctly by the next person.
#
# The failure mode it removes is specific: a half-migrated schema serves most routes fine
# and 500s on whichever ones touch the new column, which reads as a bug in those routes
# rather than as a migration that never ran. Combined with the health check that used to
# answer `{ok:true}` unconditionally, Fly marked such a deploy healthy.
#
# No claim is made here about migrations being safe in general — this only guarantees that
# a migration which exits non-zero stops the boot. Concurrency is handled separately by
# the advisory lock in `packages/db/src/migrate.ts`.
#
# The migration is invoked as a plain node script rather than through `pnpm db:migrate`,
# and that is about availability rather than style. `corepack enable` in the base stage
# only installs shims; the pnpm tarball itself is fetched on first use and cached in
# `/root/.cache/node/corepack`, which `COPY --from=build /app /app` does not carry over.
# So the runtime image had the shim and not the package, and every boot downloaded pnpm
# from npmjs.org before serving anything — turning an npm outage into our outage at the
# one moment we can least afford it, a restart. Removing the call is better than
# pre-seeding the cache, because the running app has no reason to need a package manager.
#
# `pnpm db:migrate` resolved to `tsx src/migrate.ts` with pnpm setting the working
# directory to `packages/db`. Nothing here depends on that: `MIGRATIONS_DIR` is resolved
# from `import.meta.url`, so the file list is the same from any cwd.
CMD ["sh", "-c", "set -e; if [ -n \"$DATABASE_URL\" ]; then node --import tsx packages/db/src/migrate.ts || { echo 'db:migrate failed; refusing to start against a partial schema' >&2; exit 1; }; fi; exec node --import tsx apps/rest/src/server.ts"]
