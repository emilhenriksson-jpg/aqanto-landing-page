# Single image: REST API + MCP on one origin (`apps/rest` mounts `/mcp`).
#
# Claude and ChatGPT reach MCP from their clouds, so this process must be on a
# public HTTPS URL — a laptop behind a firewall will never work for those clients.
#
# Runtime: `DATABASE_URL` selects `@photographic/db` (real Services). Unset falls
# back to `@photographic/services-memory`. FakeLlm unless PHOTOGRAPHIC_LLM=openai
# and OPENAI_API_KEY are set. Migrations run on boot when DATABASE_URL is present.

FROM node:22-slim AS base
ENV PNPM_HOME=/pnpm
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable
WORKDIR /app

FROM base AS deps
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json tsconfig.base.json ./
COPY packages/core/package.json            packages/core/
COPY packages/db/package.json              packages/db/
COPY packages/auth/package.json            packages/auth/
COPY packages/agent/package.json           packages/agent/
COPY packages/connect/package.json         packages/connect/
COPY packages/services-memory/package.json packages/services-memory/
COPY packages/rooms/package.json           packages/rooms/
COPY packages/ingest/package.json          packages/ingest/
COPY packages/projection/package.json      packages/projection/
COPY packages/retrieval/package.json       packages/retrieval/
COPY packages/documents/package.json       packages/documents/
COPY packages/llm/package.json             packages/llm/
COPY apps/rest/package.json                apps/rest/
COPY apps/mcp/package.json                 apps/mcp/
COPY apps/web/package.json                 apps/web/
COPY apps/voice/package.json               apps/voice/
COPY apps/onboarding/package.json          apps/onboarding/
COPY e2e/package.json                      e2e/
RUN pnpm install --frozen-lockfile

FROM deps AS build
COPY . .
# Declaration emit for rest and its workspace deps. We still execute TypeScript
# with tsx at runtime — no separate JS bundle step yet.
RUN pnpm --filter @photographic/rest... run build

FROM base AS runtime
ENV NODE_ENV=production
ENV PORT=8080
COPY --from=build /app /app
EXPOSE 8080

# Migrate when Postgres is configured (idempotent), then serve.
CMD ["sh", "-c", "if [ -n \"$DATABASE_URL\" ]; then pnpm db:migrate; fi; exec node --import tsx apps/rest/src/server.ts"]
