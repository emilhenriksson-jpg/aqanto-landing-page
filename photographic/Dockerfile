# Single image serving the REST API and the MCP server.
#
# The MCP server has to be reachable over public HTTPS: both Anthropic and OpenAI
# connect from their own cloud infrastructure, never from the user's device. A local
# server behind a firewall will not work no matter which client is used.

FROM node:22-slim AS base
ENV PNPM_HOME=/pnpm
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable
WORKDIR /app

FROM base AS deps
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY packages/core/package.json           packages/core/
COPY packages/db/package.json             packages/db/
COPY packages/auth/package.json           packages/auth/
COPY packages/rooms/package.json          packages/rooms/
COPY packages/ingest/package.json         packages/ingest/
COPY packages/projection/package.json     packages/projection/
COPY packages/retrieval/package.json      packages/retrieval/
COPY packages/documents/package.json      packages/documents/
COPY packages/llm/package.json            packages/llm/
COPY apps/rest/package.json               apps/rest/
COPY apps/mcp/package.json                apps/mcp/
COPY apps/web/package.json                apps/web/
COPY apps/voice/package.json              apps/voice/
RUN pnpm install --frozen-lockfile

FROM deps AS build
COPY . .
RUN pnpm --filter @photographic/web run build \
 && pnpm --filter @photographic/voice run build

FROM base AS runtime
ENV NODE_ENV=production
COPY --from=build /app /app

# The migration runner is idempotent, so running it on every boot is safe and means a
# deploy can never serve against an out-of-date schema.
CMD ["sh", "-c", "pnpm db:migrate && node --import tsx apps/rest/src/server.ts"]

EXPOSE 8080
