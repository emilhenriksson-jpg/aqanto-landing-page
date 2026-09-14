# Working agreement for agents on Photographic

Read this before writing a single line. It exists so that ten agents can work at the
same time without colliding.

## The one rule

**You own your package. You do not edit anyone else's files.**

If you need a change outside your package, do not make it. Append a line to
`STATUS.md` under `## Blockers` describing what you need and from whom, and work around
it locally. The orchestrator resolves cross-package changes.

The only shared files are `packages/core/**` and `packages/db/migrations/**`, and they
are **frozen**. They are the contract every other package compiles against. If the
contract is genuinely wrong, raise a blocker; do not edit it.

## Ownership map

| Package | Owner task | May edit |
|---|---|---|
| `packages/core` | frozen contract | orchestrator only |
| `packages/db` | schema, pool, repositories, migrations runner | `db` agent |
| `packages/auth` | OAuth 2.1 server, PKCE, DCR, sessions | `auth` agent |
| `packages/rooms` | rooms, membership, invites, permission resolution | `rooms` agent |
| `packages/ingest` | remember/update/forget, dedupe, conflict, proposals | `ingest` agent |
| `packages/projection` | profile builder, brief builder, context bundle | `projection` agent |
| `packages/retrieval` | hybrid search, RRF fusion | `retrieval` agent |
| `packages/documents` | upload, extraction, chunking | `documents` agent |
| `packages/llm` | real `LlmPort` (OpenAI) + deterministic fake | `llm` agent |
| `apps/rest` | HTTP API | `rest` agent |
| `apps/mcp` | MCP server | `mcp` agent |
| `apps/web` | web app | `web` agent |
| `apps/voice` | Realtime voice client | `voice` agent |

## Non-negotiables

These are the things that cannot be fixed later. Violating one is a failed task even if
the tests pass.

1. **Every read resolves permission itself.** Every port method takes `actor` first and
   filters by membership *inside the SQL query*. Never fetch then filter in TypeScript.
   That is how rooms leak into each other.

2. **`app.event` is append-only.** The database rejects UPDATE and DELETE on it. All
   memory mutations append an event; `item`, `profile`, `brief` and embeddings are
   projections that a replay can rebuild. If you find yourself mutating state without
   an event, stop.

3. **Provenance is never optional.** Who wrote it, which client, which session, when.
   It cannot be backfilled.

4. **Denied access renders as 404, never 403.** Confirming a room exists is already a
   leak. Use `NotPermittedError`.

5. **Nothing calls an LLM or a network directly.** Go through `LlmPort` / `NotifyPort`
   so the test suite runs offline and free.

6. **The personal profile is never searched.** It is injected whole, under
   `PROFILE_TOKEN_BUDGET`. Retrieval applies to shared rooms and documents.

7. **Soft delete only, always with undo.**

## Conventions

- TypeScript, ESM, `.js` extensions in relative imports (required by `verbatimModuleSyntax`).
- `pnpm` workspaces. Add dependencies with `pnpm --filter <pkg> add <dep>`.
- Tests with `vitest`, colocated as `*.test.ts`.
- SQL lives in `.sql` files or tagged templates, never string-concatenated with input.
- Swedish in user-facing strings, English in code and comments.

## Definition of done for your task

1. `pnpm --filter <your-package> run typecheck` passes.
2. `pnpm --filter <your-package> run test` passes.
3. You appended a short entry to `STATUS.md` under `## Completed`.
4. You committed to your own branch with a descriptive message.

Do not open a pull request. The orchestrator merges.

## Database access in tests

A local Postgres 16 with `pgvector` is running:

```
postgres://photographic:photographic@127.0.0.1:5432/photographic
```

Schema is `app`. Integration tests should create their own throwaway data with random
UUIDs and clean up after themselves; the database is shared between agents, so never
`TRUNCATE` and never assume an empty table.
