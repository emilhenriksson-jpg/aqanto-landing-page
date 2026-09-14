# Build status

Orchestration state for the overnight run. Every agent appends here; the orchestrator
reads this first on each wake-up.

## Assumptions made without the user

Emil is asleep. These were decided autonomously and are cheap to reverse in the morning.

- Code lives in `photographic/` inside the `aqanto-landing-page` repo so it can be
  lifted out later with `git subtree split` without touching the landing page.
- "Done" means: Claude can connect to the MCP server and answer questions about the
  person, **and** an invite to a shared room works end to end.
- Technical decisions taken freely. Nothing decided about pricing, naming or legal.
- Embeddings sized at 1536 (`text-embedding-3-small`). Changing this is a migration.
- Swedish for user-facing strings, English for code.
- No API key was available at the start of the run, so `LlmPort` is built against a
  deterministic fake first and the real implementation second.

## Blockers

_Agents append here. Do not edit another package to unblock yourself._

## Completed

- **orchestrator** — foundation: pnpm workspace, frozen SQL schema (applied and tested
  against local Postgres 16 + pgvector), `@photographic/core` domain types, all ports,
  policy constants, `AGENTS.md`, `ARCHITECTURE.md`.
  Verified by hand: append-only trigger rejects UPDATE and DELETE on `app.event`; only
  one personal room per person; a non-member resolves to zero accessible rooms.
