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
FROM base AS deps
COPY pnpm-lock.yaml ./
RUN pnpm fetch

FROM deps AS build
COPY . .
# `--offline` so this can only use what `pnpm fetch` already put in the store; a network
# fetch here would mean the lockfile and the image had drifted without anyone noticing.
RUN pnpm install --frozen-lockfile --offline
# Declaration emit for rest and its workspace deps. We still execute TypeScript
# with tsx at runtime — no separate JS bundle step yet.
RUN pnpm --filter @photographic/rest... run build

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
CMD ["sh", "-c", "if [ -n \"$DATABASE_URL\" ]; then pnpm db:migrate; fi; exec node --import tsx apps/rest/src/server.ts"]
