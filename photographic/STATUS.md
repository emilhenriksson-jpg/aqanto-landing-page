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

_None open for tokens: shared CSS lives in `@photographic/design-tokens` (`./tokens.css`); apps/web, apps/onboarding and apps/voice import it._

- **Login codes are in the application log in plaintext, and SMS is the only way in.**
  `PHOTOGRAPHIC_SMS` defaults to `log`, `LogCodeSender` writes
  `logger.warn('signup_code', { destination, code })`, and `REDACTED_KEYS` in
  `apps/rest/src/logger.ts` contains `destination` but **not** `code`. So anyone who can
  read `fly logs` — or any log aggregator added later — can request a code for any number
  and sign in as that person. The Fly API token can read those logs.

  Deliberately still open, and this is the trade: reading codes out of the log is
  currently Emil's only way into his own account, so closing it before SMS works locks him
  out of the product. It lands the moment 46elks is proven, in two parts that should go
  together — [PR #11](https://github.com/emilhenriksson-jpg/aqanto-landing-page/pull/11)
  refuses the `log` channel in production, and `code` joins `REDACTED_KEYS` as the second
  lock so a future channel cannot reintroduce it. Two independent reviews flagged this;
  neither is wrong, it is sequenced rather than unnoticed.

- **anslutning** — Fly deploy for `mcp.photographic.space` is designed and scripted but
  not executed: no Fly account access from this agent. Needs someone with Emil's Fly
  login + a payment method to run `fly deploy` / `fly certs add` / `fly certs setup`
  (steps in `scripts/deploy.md`, Production section) — then
  `./scripts/cloudflare-dns-record.sh` (already written and tested against a mock) can
  add the DNS record `fly certs setup` prints. Also blocked on PR #2 for two things: the
  Supabase `DATABASE_URL` (without it the deploy runs the in-memory reference, not real
  storage) and moving `MemoryClientStore`/`MemoryTokenStore` (`apps/rest/src/wiring.ts`)
  to Postgres — without that, a `fly deploy` or crash-restart still drops Claude's OAuth
  registration even on a hostname that never moves, so "always works" is not true in
  practice yet.

## In progress

- **orchestrator** — deeper `VITE_USE_DEMO=0` wiring beyond curls. Design rounds 1–4 done
  on the room UI; next polish is invite-first-viewport confidence under real devices.

## Known limitations, written down rather than discovered later

- **A restart drops Claude's connection.** OAuth clients and tokens live in process
  memory (`MemoryClientStore` / `MemoryTokenStore` in `apps/rest/src/wiring.ts`), so
  every restart forgets the dynamic registration and the connector has to be added
  again. Track 3 is moving these to Postgres — deliberately not fixed here.
- **The tunnel hostname is new on every run**, so a connector saved in Claude is
  invalidated by the next restart. That is the accepted cost of not committing to a
  deployment while storage is still being decided.
- **SMS is still the log.** Email is real as of `d8731c7` (Resend, selected by
  `createCodeSenderFromEnv`); SMS has a 46elks sender but defaults to `log`, so codes sent
  to a phone number still only appear in the API log as `signup_code`. The default for
  both is the log, so an unconfigured process behaves as it always did.
  <!-- Corrected on the Track 2 branch: this line said "no real email or SMS", which
       d8731c7 had already made false. Fixed here rather than on the foundation, because
       every push there re-conflicts the stacked PRs. -->

- **Shared-room Aktivitet is still demo data.** Left alone on purpose: it is being
  rebuilt as a view over the append-only event log with full provenance, so a standalone
  activity endpoint now would be thrown away.

## Track 2 — event log & calendar

Branch `cursor/photographic-event-log-calendar-fc2d`, PR #3. Owns domain migrations:
**0003** (`provenance_and_authorship`) and **0004** (`calendar_and_trash_views`). Track 3
should number from 0005 upwards; the ledger keys on filename, so two files sharing a
number would both apply in filename order, which is a coin toss nobody should have to
think about.

### Security fixes, done first

- **`requiresApproval()` could be switched off by model-supplied content.** `explicit`
  was tested before the gates for instructions, contradictions and shared rooms, and it
  is a boolean an AI client sets from what it read — including text inside documents we
  did not write. It is tested last now and relaxes only the 240-character rule.
  Consequence, and it is deliberate: **every write into a shared room passes the Godkänn
  queue**, including one the person asked for out loud (build-plan decision 2).
- **Invites were not single-use.** `accept` never checked `status = 'pending'`, so a link
  kept admitting people after the first acceptance. Single-use now, refused as a
  not-found so a spent link cannot be told from a fictional one, and the status update is
  conditional in SQL so two simultaneous clicks cannot both pass. `peek` closes with it.

### Working end to end

- **Provenance on the log.** `motivation`, `explicit`, `source_*`, `client_id`,
  `from_room_id`, `to_room_id` on `app.event`, and `session_ref` finally filled in on the
  write path — the chain from a memory back to its conversation was broken at the first
  link. All six questions from scope §4 are answerable, including for memories written
  before the columns existed: a client plus a session is derived as a conversation.
- **The eight memory event kinds**, with ⚠️ Omtvistat as the eighth (approved).
- **`item.superseded` is emitted**, in the same transaction as the status change. The one
  operation that removes information from the current state was the one the log did not
  record.
- **Calendar day view** at `/kalender/:date`, a rail destination. Shows every memory
  event for the day with its motivation, keeps a correction beside what it corrected, and
  puts contributions from other members first and marked — there is no owner moderation
  of incoming material, so visibility is the whole defence.
- **Zoom**: dag → minneshändelse → källa, at `/kalender/handelse/:seq`. Every value the
  memory has held, and the source as a place (the session, and what else came out of it).
- **Trash and history are views over the log.** `app.trash` derives membership from the
  last lifecycle event; delete-undo-delete now has one answer instead of two that drift.
- **Disputes.** Across authors in a shared room both statements stay active, carry each
  other, and always travel together into retrieval. Only the losing author or an owner
  resolves one, never a model, and there is no tool for it.
- **Room isolation in the data layer**: a trigger refuses any memory placed in a shared
  room without a person asking, and another refuses a second member in a personal room.
- **`member.left` / `membership.left_at`**, with owner succession to the longest-serving
  editor, and a deliberate "ta bort mina bidrag" path through the ordinary trash.
  Contributions otherwise stay, attributed.
- **Inert RLS policies dropped** (approved) and `ARCHITECTURE.md` corrected in the same
  change — it pointed the opposite way from build-plan decision 4.
- `sensitivity` now forces the approval gate, so the MCP tool description stops promising
  something the code did not do. `local_only` was never in the public tool schema.

### Automatic memory routing

The last unbuilt piece of the core idea. A write with no room named used to default to the
personal room silently, so "Photographic decides where it goes" was really "the client
decides, and the client always says private". `remember`'s `roomId` is optional now, and
leaving it out means `routeMemory` decides and records why.

Three properties hold by construction rather than by care:

- **Nothing auto-shares.** The router picks a target; it does not decide whether the write
  lands. A routed room meets the same `requiresApproval` gate a hand-named one does, and
  that gate refuses every write into a shared room. The worst a wrong routing decision can
  do is put a question in the Godkänn queue. There is no code path here that returns "and
  no approval needed".
- **Uncertainty resolves towards private.** A weak best match or two rooms matching about
  equally both mean private — not because private is neutral but because it is the
  reversible one.
- **The model may only make the outcome more private.** The shortlist is lexical and
  deterministic; `LlmPort.confirmPlacement` can veto a candidate and can never propose
  one. Same asymmetry as the `explicit` fix: untrusted input may tighten a decision, never
  loosen it.

**On the fake or unavailable LLM** — the question worth writing down. Falling back to
"always private, always ask" would have been safe and would have made the feature invisible
in the only environment it is tested in. Instead the decision is split: *which room is a
candidate* is computed from text without a model, and the model only ever narrows. So
routing behaves identically against `FakeLlm`, an unconfigured process and a provider
outage — the e2e suites exercise real room placements, not a stub — while a real model adds
a veto. `confirmPlacement` is optional on the port for exactly this reason, and every
failure path inside `OpenAiLlm.confirmPlacement` lands on `belongs: false`, which keeps the
memory private.

The room match is crude on purpose: token overlap against title, description and the room's
own memories, with a short function-word list and a few Swedish suffixes stripped. Without
the suffixes it cannot match "ledningen" to a room called "Ledning", which in a Swedish
product is most of the misses.

**Replace it, do not grow it.** The retrieval track is building its Swedish text handling
as a reusable function in `core` rather than inline in search, specifically so routing has
something real to adopt. When that lands, `stem` and `FUNCTION_WORDS` in `routing.ts`
should be deleted in favour of it — a second hand-rolled suffix list is the thing to avoid.
Left alone here on purpose while both branches are in flight.

Two things found while building it, both now tested:

- **Routing bypassed the token's room scope.** `assertRoomInScope` guards every path where
  a room is *named*; routing is the path where none is, so a token issued for one room
  could reach the personal room by not mentioning it. `routeMemory` filters candidates by
  `actor.roomScope` and refuses with `NotPermittedError` when nothing is reachable.
- **The routing reason was lost on approval.** It was recorded on `proposal.created` but
  the memory that eventually landed carried a generic sentence. `app.proposal.motivation`
  now carries it through, because deciding again at approval time — from a room list that
  may have changed since — is a different decision wearing the first one's clothes.

Also: the explanation quotes the person's own spelling. Matching runs on stripped, stemmed
tokens; "eftersom det nämner forvarv, buyersclub" is the inside of the matcher, not a
sentence anybody wrote.

### Notes for whoever touches this next

- **Two bugs the new tests found**, both pre-existing: purging a memory failed on a
  foreign key when a proposal or a superseding item still pointed at it (fixed in 0003 —
  `SET NULL`, because those are pointers and the rows holding them are records of their
  own); and the e2e Postgres harness was wiping the schema the other packages read, so it
  now uses a database of its own (`..._e2e`, created on demand, falling back if it
  cannot).
- `explicit: true` no longer saves into a shared room. Test helpers for that exist:
  `harness.saveIntoRoom` in e2e, `saveIntoRoom` in `apps/rest/src/app.test.ts`.
- Not built, deliberately: week/month/year rollups. Derivable from the same log whenever
  they are wanted, and shipping summaries before the thing being summarised would have
  been the wrong order.
- Not touched, per ownership: OAuth client/token storage, scope middleware,
  `resolveByName`. `app.event.client_id` and `app.item.author_client_id` are in place and
  null until Track 3 moves the client store to Postgres — an honest gap rather than a
  confident guess.

Rebased onto the foundation tip at `d8731c7` (real email delivery + public HTTPS), so
these numbers include that work. Two conflicts, both resolved by keeping the union:
`STATUS.md` (this section under its own heading, theirs left untouched) and
`e2e/vitest.config.ts` — they excluded the live smoke from the default run and gave it
`test:live`, I set `fileParallelism: false`; both are needed and the merged file says why.

Green: monorepo typecheck clean; core 52, agent 54, auth 34, connect 91, delivery 28,
llm 9, web 45, services-memory 7, db 3, onboarding 24, mcp 40, rest 72; e2e 44 memory +
44 postgres (22 journey + 22 calendar/routing), plus
`pnpm --filter @photographic/e2e test:live` against a running process.

### Verified against a running system, not only by tests

- **The session chain, which was the point of the `session_ref` fix.** A real MCP client
  over the full OAuth dance calls `remember`; the resulting `item.created` carries
  `session_ref`, and it joins to an `app.client_session` row with `transport = mcp` and
  `profile_delivered = true`. `source_ref = session_ref`, so `GET /v1/calendar/events/:seq`
  opens the conversation it came out of. Script: `/tmp/mcp-write.mjs` in that run — not
  committed, it is twenty lines of OAuth and a tool call.
  Note: the e2e harness's actors carry no session, so `session_ref` is null in that
  database. That is honest rather than broken — no session, no ref.
- **Both database triggers refuse raw SQL** that bypasses every application path: a
  non-explicit insert into a shared room, and a second member in a personal room.
- **`pg_policies` in schema `app` is empty** and `relrowsecurity` is false on `item`,
  `document`, `chunk`, `brief` and `event`.
- **Bottom clearance on the calendar, measured rather than eyeballed.** `.shell__main`
  computes `padding-bottom: 140px` at 420px wide, and at the true bottom of the page the
  last card sits 210px above the fixed tab bar with the footer link clear too. On desktop
  the last card and footer are both fully visible and the 64px rail ends well left of the
  content. Worth writing down because a *mid-scroll* screenshot of a page with a fixed tab
  bar always looks like a clipping bug — the bar paints over whatever is under it at that
  moment. `media/kalender-mobil.png` in the project store is therefore a full-page capture,
  where the bar appears once at the real bottom and cannot be misread.
- **Running `src/calendar.test.ts` alone against Postgres** leaves `item.disputed`,
  `item.dispute_resolved`, `item.superseded` and `member.left` rows in the log, one
  `membership.left_at` written, `disputed` present in `app.memory_event`, and two authors
  recorded per shared room. Worth knowing: the two e2e files each reset the schema, so
  inspecting the database after a full run only shows whichever ran last.

## Completed

- **orchestrator** — **public HTTPS, and Claude can connect.** Verified reachable this
  morning at `https://called-job-paragraph-necessary.trycloudflare.com/mcp` (a quick
  tunnel, so that exact hostname dies with the process — `./scripts/public-mcp.sh`
  prints a fresh one).
  The missing piece was not the tunnel. A client discovers everything from the MCP
  endpoint's own metadata, so one hostname should be enough, and it was two: the login
  page an authorization request redirects to lives in `apps/onboarding`, which calls its
  API with same-origin relative paths through a Vite proxy that exists only on a laptop.
  Behind a tunnel the flow dead-ended after the redirect, on an origin serving no HTML —
  a blank page, long after every test had passed. `createApp` now serves the built
  browser app over the paths the API has not claimed, and `loadConfigFromEnv` points
  `loginUrl` at our own origin when we are the ones serving it.
  Mounted last and behind an explicit API prefix list, because a single-page app answers
  every unknown path with its shell: `GET /v1/typo` has to stay a JSON 404, or a client
  that gets HTML where it expected an error reports an empty room rather than a failure.
  Verified three ways, all against the public URL rather than localhost: discovery and
  the `www-authenticate` challenge by curl; the whole OAuth dance plus `initialize` by
  `e2e` live smoke; and the browser half — `/login`, the Swedish consent screen, the
  code delivered to a loopback redirect URI — driven by hand in a real browser, then
  exchanged for a token and an `initialize` whose instructions carry Emil's seeded
  ketchup allergy. 16 new `apps/rest` tests; typecheck clean; e2e 22 memory + 22 postgres.
  Two things found on the way, both of which had been passing everything. The live smoke
  and the Postgres journey shared a database and ran in parallel, so the journey's
  `reset(pool)` dropped the schema mid-signup and failed with `relation "app.person"
  does not exist` — indistinguishable from a broken product; the smoke now has its own
  config and `test:live` script. And `npx untun`, which `WAKEUP.md` and `scripts/deploy.md`
  both recommended, does not run at all: `untun@0.2.2` ships `dist/cli.mjs` with no
  shebang, so npx hands it to `sh`. It drives cloudflared underneath anyway, so the
  script now calls cloudflared directly and downloads it on Linux if it is missing.
  `./scripts/public-mcp.sh` checks `/health` *through* the tunnel before printing a URL,
  because a quick tunnel sometimes gets a hostname that is never published in DNS and
  cloudflared reports a healthy connection either way — observed once while testing.
  Deliberately not Fly with durable Postgres: storage is likely moving to Supabase, and
  the point of staying on a tunnel is that nothing about the database becomes hard to move.

- **voice** — `apps/voice` was an empty stub (`export {}`). Added a minimal Swedish calm
  landing: Wordmark + one sentence + violet disabled CTA “Kommer snart”, tokens from
  `@photographic/design-tokens`. Placeholder only until the realtime client lands.

- **orchestrator** — `@photographic/design-tokens`: single `tokens.css` from `DESIGN.md`,
  imported by `apps/web` and `apps/onboarding` (duplicate local token files removed;
  apps not merged).

- **orchestrator** — foundation: pnpm workspace, frozen SQL schema (applied and tested
  against local Postgres 16 + pgvector), `@photographic/core` domain types, all ports,
  policy constants, `AGENTS.md`, `ARCHITECTURE.md`.
  Verified by hand: append-only trigger rejects UPDATE and DELETE on `app.event`; only
  one personal room per person; a non-member resolves to zero accessible rooms.

- **orchestrator** — `@photographic/connect`: passwordless sign-up, the connect screen
  as data, one-click install links, and delivery verification. 66 tests, no database
  and no network. Decision recorded in `CONNECT.md`: one shared MCP URL for everyone,
  identity from OAuth, never a per-person address.
  Verified by decoding our own Cursor deeplink: the payload is the bare transport
  config, with no `mcpServers` wrapper (the wrapper is what makes Cursor reject it).

- **orchestrator** — `apps/onboarding`: the four screens a new person actually meets.
  Passwordless sign-up, invite landing with the room content shown before any form, the
  connect screen rendered entirely from `@photographic/connect` descriptors, and
  delivery verification. Plus client health with a green/amber/red dot per AI.
  18 tests against a fake API. `pnpm --filter @photographic/onboarding dev` opens
  `/dev.html` and runs the whole flow on fake data, so the screens can be reviewed
  before the backend exists.
  Verified: production build excludes the fake API entirely, and no test reports success
  from a click — only from an observed delivery.

- **orchestrator** — trash, history and the agent contract. Migration 0002 adds the
  30-day trash, the purge function, and the activity view; `app.event` now permits
  exactly one mutation, redaction from inside the purge, and still refuses DELETE.
  `@photographic/agent` holds the eight tools and the session instructions (39 tests).
  `previewImport` turns a pasted ChatGPT memory list into proposals (89 tests in
  connect). `PROTOCOL.md` settles MCP-as-backbone plus four lower-friction surfaces.
  Verified against Postgres: the redaction flag does not leak, DELETE is refused even
  mid-purge, unrelated events survive intact, and text is gone from every referencing
  event after a purge.

- **orchestrator** — `apps/rest`: the HTTP API over the ports, with the middleware order
  stated once and load-bearing (context, CORS, rate limit, auth, immediately in front of
  the routes that need it). `createApp` constructs nothing itself, so the same app runs
  against the reference implementation and against Postgres without a line changing.
  36 tests.
  Verified: every 404 is padded to a floor, because "exists but you may not see it" and
  "does not exist" have to be indistinguishable and response time leaks the difference
  for free.

- **orchestrator** — `apps/mcp`: the MCP server, mounted at `/mcp` on the same origin as
  the API. Per-person instructions in `InitializeResult`, so a model has the profile
  before the person types anything, one session per connection rather than per request,
  and the data boundary applied to every read. 39 tests, including the real client SDK
  over a socket.
  One origin, not two: a client discovers the authorization server from the MCP
  endpoint's own metadata, and splitting the hosts would mean maintaining two OAuth
  deployments to serve one login.

- **orchestrator** — `@photographic/auth`: OAuth 2.1 with PKCE and open dynamic
  registration, which is what makes one-click connection possible — nobody visits a
  developer console to use their own memory. Registration being open is also why the
  redirect rules are the only thing between us and a code delivered to an attacker, so
  they are exact-matched at authorize time, plain `http` is refused off loopback, and
  PKCE is required with no downgrade path. Private-use schemes like `cursor://` are
  allowed, because RFC 8252 recommends reverse-DNS and no shipping client follows it;
  what protects them is PKCE, not the scheme check. 34 tests, written against the
  attacks rather than the happy path.
  `/oauth/authorize` splits in two because Photographic has no passwords: it validates
  everything, parks the request, and sends the browser to a login page that approves it
  with a session token. Fixing the redirect URI and the challenge *before* the person
  sees a login screen is the part that matters — nothing afterwards can move where the
  code goes.
  Verified end to end on a socket and again in `apps/rest/src/connect-flow.test.ts`: a
  401 from `/mcp`, discovery, registration, PKCE, login, approval, code exchange, refresh
  rotation, `initialize` with a real profile, a tool call that writes and finds it again —
  and then the parts that must stop working, a revoked token and a replayed refresh token
  taking its whole family down.

- **orchestrator** — `createWiring`: the composition root, extracted from `server.ts`.
  Builds everything and starts nothing, so the wiring is testable; `server.ts` reads the
  environment, builds it and serves it. This found two seam bugs that every unit test had
  been passing over: the login page pointed at an origin that serves no HTML, and the MCP
  endpoint advertised a scope set with no `offline_access`, which would have handed every
  client an hour of access and no way to renew it.

- **orchestrator** — the room overview: every room a person has now reaches every session
  as one line — name, whether other people write in it, and a headline saying what the
  room is for. The personal room is still injected whole; the others are named, not read.
  This closes the gap between "knows everything about you" and "does not know your rooms
  exist", which is the failure a model cannot notice: it answers from the profile, sounds
  certain, and is wrong about work living in a room it was never told about.
  The headline is its own projection, not the first line of a brief. A brief is what a
  room contains and changes daily; a headline is what a room *is*. The owner's own
  description wins and is never regenerated, so a person can state what every model
  understands a room to be (`PATCH /v1/rooms/:id/description`, capped at the length the
  overview can actually carry). Otherwise it is summarised under its own prompt in the
  job that rebuilds the brief — never on the read path, because session start is a voice
  turn — and the personal room is skipped entirely, which would otherwise mean a model
  call on every fact a person saves about themselves.
  Two bugs fixed on the way, both of which had been passing every test: room titles and
  headlines reached the model in instruction position rather than inside the data
  boundary, so a room named "ignore previous instructions" was a write primitive into
  every session its members opened; and the room list was the first block dropped when
  the budget got tight, which is the one thing it must never be. Headlines now give way
  before room names, and room names never give way at all.
  Not built, deliberately: an MCP tool for describing a room. Eight tools is already at
  the limit where selection accuracy starts to fall, and this is an action a person takes
  in the app once per room, not something a model should be choosing between mid-sentence.

- **orchestrator** — `apps/web`: the room app is no longer a placeholder. Home is a rail
  with the personal room as the default landing (brand, title, lede, token meter, then
  profile sections as card groups), "Alla" opens the room grid (personal first,
  violet-tinted), and shared rooms open with brief + memories. Soft-delete with undo on
  every memory line. Demo data only — the API is not wired yet — so the screens can be
  reviewed on their own. 3 component tests green; `pnpm --filter @photographic/web dev`
  on :5173.
  Design language from `DESIGN.md`: one violet accent, Inter, standing-inside-the-room
  rather than a dashboard.

- **orchestrator** — `@photographic/db`: migrate/reset scripts work against the local
  Postgres (`pnpm db:migrate` is a no-op when the schema is already there; empty ledger
  with existing tables gets recorded rather than re-applied). Postgres ports started for
  identity, rooms, invites, events and permissions; they typecheck. Not yet assembled
  into `createPostgresServices`, so `DATABASE_URL` still refuses to boot — by design,
  until the remaining ports (ingest, projection, bundle, retrieval, trash, history,
  sessions, jobs) land and the e2e harness can run `HARNESS=postgres`.

- **orchestrator** — Postgres composition root landed. `createPostgresServices` wires every
  port (identity → rooms → invites → ingest → projection → bundle → retrieval →
  documents → trash → history → events → sessions → jobs → audit) with the same job
  handlers as memory (`rebuild_projections`, `summarise_document`, `purge_trash`).
  `apps/rest` selects it when `DATABASE_URL` is set; the process no longer exits.
  `e2e` harness runs the same 22-test journey against memory (`HARNESS=memory`) and
  Postgres (default when `databaseUrl` / `DATABASE_URL` is present; resets schema per
  run). Smoke tests in `@photographic/db` cover register → remember → profile and
  invite isolation. All green: db 3, e2e 22×2, rest 53, monorepo typecheck clean.

- **orchestrator** — `PHOTOGRAPHIC_LLM=openai` + `OPENAI_API_KEY` selects `OpenAiLlm`
  via `createLlmFromEnv` in the rest composition root; default remains FakeLlm so the
  suite stays deterministic. Deploy docs and WAKEUP.md cover Fly+Postgres and the flag.

- **orchestrator** — design pass on `apps/web` personal room: fuller violet wash hero that
  fills the first viewport (standing *inside* the room), softer token-meter gradient so
  brand is atmospheric rather than a solid bar, entry motion with reduced-motion respect.
  Round 1 of ≥3 against DESIGN.md; Alla/shared-room screenshots still pending.

- **orchestrator** — `pnpm db:seed` loads Emil + Buyersclub Ledning into local Postgres so
  morning demos and e2e against a real ledger do not start from an empty schema.

- **orchestrator** — root `WAKEUP.md` points at `photographic/WAKEUP.md` and the one
  command that boots API+MCP with migrate+seed; short Swedish handoff for anyone who
  lands in the repo root first.

- **orchestrator** — web design round 2: person/room avatars, a shared hero treatment so
  personal and shared rooms feel like the same place, and Alla polish so the room grid
  reads as standing in the foyer rather than a dashboard tile wall.

- **orchestrator** — Approvals (`Godkänn`) and Client health (`Klienter`) screens in
  `apps/web`: pending proposals to accept or dismiss, and a per-AI green/amber/red
  health view so delivery status is visible without leaving the room app.

- **orchestrator** — REST client scaffold behind `VITE_USE_DEMO` (default demo). Demo data
  stays the review path; `VITE_USE_DEMO=0` is the switch toward a live API without
  forcing that wiring on every `pnpm dev`.

- **orchestrator** — `apps/web` component tests now 11 green (was 3), covering the new
  screens and the shared room chrome from round 2.

- **orchestrator** — invite recipient preview at `/i/:token` outside the shell rail:
  readable room content + one violet “Gå med” (demo join confirm). Growth loop screen
  from DESIGN.md.

- **orchestrator** — web design round 3: standing-inside-the-room polish (hero depth,
  Alla foyer, rail calm). Shared rooms gained a sparse Swedish **Aktivitet** feed.
  REST CORS defaults include `127.0.0.1:5173` so Vite→API works locally. Web tests 15.

- **orchestrator** — calm **Dokument** shelf on personal + shared rooms (demo rows,
  empty copy when none). Room interior now matches DESIGN.md: memories, documents,
  activity.

- **orchestrator** — `scripts/demo-api.md`: curl journey proving web→REST against local
  Postgres (`db:migrate`/`db:seed`, signup code from `signup_code` log, session,
  `/v1/rooms`, `/v1/profile`). Web client paths already match; no client fixes needed.

- **orchestrator** — morning MCP smoke verified green: `./scripts/mcp-smoke.sh`
  (connect-flow 15 + e2e postgres 22 with ketchup in instructions). Live `:8787`
  also green: OAuth → `POST /mcp` `initialize` instructions contain seeded `ketchup`
  for `emil@photographic.me`. Gated suite: `LIVE_MCP=1 LIVE_MCP_LOG=/tmp/rest-demo-api.log
  pnpm --filter @photographic/e2e test` → `e2e/src/live-mcp.smoke.test.ts` (skipped by
  default). Seed refills empty demo facts if e2e reset left the email without ketchup.
  Session token alone → 401; OAuth access token required (mcp-smoke.md).

- **orchestrator** — design round 4: Klienter is a quiet stacked list (not a 3-card
  status grid). Soft-delete live path race-safe; `@photographic/design-tokens` shared;
  `LIVE_MCP=1` optional e2e smoke; morning `./scripts/mcp-smoke.sh` green.

- **orchestrator** — Godkänn + Klienter load from REST when `VITE_USE_DEMO=0`
  (`listProposals` / `listClients`). `scripts/demo-web.md` documents session
  token + live web. Voice placeholder landing shipped earlier.

- **orchestrator** — shared-room live memories via `GET /v1/rooms/:id/items`
  (`listForRoom` on retrieval); web loader + contract tests green (24 web tests).

- **orchestrator** — Papperskorg screen (footer link from personal room, not a 5th
  rail icon) with demo + live `GET /v1/trash` / restore. Invite first-viewport CTA
  polish. `GET /v1/rooms/:id/documents` on REST for Dokument shelf (web live wiring next).

- **orchestrator** — Historik screen (footer link) with demo + live history loader;
  live Dokument shelf via room documents endpoint; web suite 37 green.

## Track 3 — platform & documents

Branch `cursor/photographic-platform-documents-80d8`, PR #2. Only this heading is mine;
I do not edit anything above it.

### Migration ownership

**Track 3 migrations are numbered from 0010.** 0003–0009 are left free for the domain
migrations Track 2 owns. Files apply in filename order, so a gap costs nothing and
renumbering an applied migration costs a database. Nothing in 0010 or 0011 touches a
table on Track 2's list.

- `0010_documents_and_storage.sql` — document text and extraction state, chunk headings
  and a Swedish FTS vector, the storage ledger.
- `0011_oauth_persistence.sql` — OAuth client/token/authorization made real, the
  authorization parking table, immutable client identity, `client_grant`, write budget.

### Done

- **OAuth state in Postgres.** The `app.oauth_*` tables existed since 0001 with nothing
  writing to them, so tokens and registrations died on restart and every revocation was
  temporary until the next deploy. `wiring.ts` now selects Postgres stores when
  `DATABASE_URL` is set and logs which it chose at boot. `apps/rest`'s 68 tests pass
  against **both** paths, which is how the 401 below was caught.
- **`agent_client` is an identity, not a guess.** It was string-matched against the name
  a client sends on every request, so a client chose its own label in someone's memory
  history. Now derived once at registration by `deriveClientIdentity` and frozen by
  trigger. An unrecognised client is `unknown` / `okänd klient` and stays that way.
- **Per-client rename and revocation.** `app.client_grant` is one row per person per
  client — what `Klienter` lists, what the person renames, what revocation acts on, and
  where the daily write budget is counted. `PATCH`/`DELETE /v1/clients/:clientId`.
  Without a database both answer 503 rather than an empty list.
- **Scopes enforced per route and per tool.** One table in `apps/rest/src/scoped-routes.ts`
  registered per method, and per-tool scopes on every MCP tool with `tools/list`
  filtered. `scope.test.ts` reads the routes out of the app and fails if any is
  unguarded — it found two I had missed. Insufficient scope is 403 `insufficient_scope`,
  not the 404 a permission denial gets.
- **`resolveByName` no longer guesses.** Substring matching meant "spara i ledning" hit
  "Buyersclub Ledning". Now exact slug, exact folded title, or a prefix unique among the
  person's own rooms; anything else is not-found. The rule moved to `matchRoomByName` in
  core because both implementations had their own copy of it.
- **Documents: extraction, chunking, storage limit.** `@photographic/documents` had a
  blob store and an HTML extractor behind an empty entry point. Finished: PDF (pdf.js),
  Word (mammoth via HTML so headings survive), text with encoding detection, a
  heading-aware chunker, and the 10 GB limit counted per person and per distinct object.
  Extraction never fails an upload — the bytes are stored first. 49 tests against real
  PDF and `.docx` fixtures built byte by byte.
- **Invite consent text.** `SHARED_ROOM_CONSENT` in core, shown in the invite's first
  viewport next to "Gå med", with a test. Emil confirmed this as a requirement.
- **Documents end to end.** `DocumentPort` widened (`download`, `originalText`,
  `storageUsage`); both implementations call the same `ingestDocument` pipeline. REST:
  `POST /v1/documents` with `room: "Buyersclub Ledning"` or nothing for private memory,
  plus `/text`, `/file`, `/chunks` and `GET /v1/storage`. Chunk search is real Postgres
  FTS through `app.search_chunks`. 11 new e2e tests against both backends.
- **Swedish upload UI + storage meter.** Upload into a room from the Dokument shelf, with
  three distinguishable outcomes. `StorageMeter` hides itself below a fifth of the limit.
- **`@photographic/supabase`.** Postgres re-point (TLS, transaction-pooler detection),
  Supabase Storage as a `BlobStore`, Auth as identity only. 35 tests, offline.
  See `SUPABASE.md`.

### Verified live, not just in tests

Against local Postgres with a real PDF, through the running API and the web UI: uploaded
by room name, extracted via pdf.js, chunked, found by full-text search, found again by
the Swedish compound "uppsagning" against "Uppsagningstiden", downloaded byte-identical,
invisible to a second account (404 and an empty search), charged once when the same bytes
arrived twice, and the AI summary appearing without touching the extracted source.

### Bugs found, all of which typechecked

- The write-budget SQL function named an output column `day`, shadowing the column it
  inserts into.
- The token-store wrapper that records grants was `{ ...tokens, create }`. Spreading a
  class instance drops every prototype method, so it had no `findByAccessHash` and every
  MCP request after a successful token exchange returned 401.
- `splitByCharacters` with overlap ≥ chunk size emitted a near-duplicate chunk per
  character. Not a hang — worse, because nothing fails and the index fills with the same
  sentence.
- `e2e` compiled with `strict: false`. Hid nothing of its own, but another package's
  discriminated unions stopped narrowing the moment `db` depended on `auth`. Now strict.
- `packages/db` and `e2e` ran their test files in parallel against one shared database
  that several of them reset. Both now sequential. In `e2e` this sits alongside the
  foundation's fix for the same class of collision — excluding the live smoke from the
  default run — and both are needed: excluding the smoke does nothing about `journey`
  and `documents` racing each other.
- **`wiring.ts` was merged by git without a conflict and needed checking anyway.** The
  connectivity work added the mail provider to the same file this track added the
  Postgres OAuth stores to, in a different region. A clean textual merge is not the same
  as correct wiring, and every other test in `apps/rest` is handed its dependencies, so
  none of them would have noticed a silent revert. `wiring.merge.test.ts` now pins it:
  a client registered against one wiring is still known to a second one built from
  scratch against the same database, which is the property `MemoryClientStore` cannot
  satisfy. Verified by reverting the wiring on purpose and watching it fail.
- The Swedish stemmer does not split compounds, so searching "uppsägning" did not find
  "uppsägningstiden" — found by writing the test wrong and believing the test. Migration
  0012 adds a trigram fallback scored strictly below every full-text hit.
- The document upload confirmation lived inside the shelf, which remounts when the shelf
  reloads after a successful upload — so the message could vanish in the frame it
  appeared. Caught by watching a screen recording, not by a test. Hoisted above the
  branch; the case it matters for is "sparad, men vi kunde inte läsa ut text ur den".

### Export and permanent deletion

On `cursor/photographic-export-deletion-80d8`, stacked on the branch above because both
build on its storage port. Full reasoning in `photographic/EXPORT.md`.

**One decision departs from the spec, deliberately.** The design document scopes an
export to `accessible_room_ids` — full transcripts of every shared room — justified by
"she can read it in the app anyway". That does not hold: app access is gated on *current*
membership and revocable, which the trust spec itself insists must never be cached, and a
zip on a laptop is exactly that cache made permanent and moved off our infrastructure.
Section 1.3's own premise — a shared room is a collective memory no single member may
unilaterally change — points the same way. So the default is the person's own (personal
room in full, plus what they wrote anywhere), and a full room transcript is an explicit
per-room request. Both write `export.created` with `included: own | full`, so the
stronger act looks stronger to the room's other members.

**The deletion decision matches the spec and the copy.** Contributions stay in shared
rooms, pseudonymised — the invite consent promised that in the first viewport, and
stripping them would change what the other members remember behind their backs.
`contributions` is mandatory in the API and `NOT NULL` with no default in the schema, so
"never preselected" is a property of the system rather than a UI convention. It is
pseudonymisation, not anonymisation, and `EXPORT.md` says so.

Both deletion paths are built: 30-day freeze and immediate `radera nu` behind a typed
confirmation. Tokens are revoked on both, the moment the request is made.

### A migration this forced, which is why building it early was worth it

`app.event.room_id` cascades from `app.room` and the append-only trigger refuses DELETE,
so deleting a personal room raised `app.event is append-only` and permanent account
deletion was **not implementable at all**. Found by writing it and running it.

`0014_permit_personal_room_erasure.sql` opens a narrow hatch in the same shape 0002
already chose for redaction: a transaction-local flag that one function sets and always
clears, that function taking a *person* rather than a room and refusing anything but
their own personal room. Seven tests try to abuse it rather than use it.

**Track 2: this changes a guarantee you own.** The invariant is now "append-only except
from inside `app.purge_expired_items` (UPDATE) and `app.erase_personal_room` (DELETE)".
If you reorganise the trigger, both hatches must survive or account deletion breaks.

Also for Track 2: `app.activity` filters on event type, so `export.created`,
`account.deletion_requested` and `account.deletion_cancelled` are in the log but not on
the history screen until the view learns them.

### Two deploy blockers, fixed on the same branch

Both stopped the first Fly boot. Found by the deploy work; the Supabase project now
exists (Frankfurt, `eu-central-1`) so this was measurable rather than theoretical.

**1. The boot migration could not reach Supabase.** Its chain terminates at
`Supabase Root 2021 CA`, a private root in no system trust store, and `pnpm db:migrate`
built a bare pool that never read `SUPABASE_CA_CERT` — while only the app composed one,
and the Dockerfile runs the migration first. The decision moved into `createPool`, which
both paths go through, so `resolveDatabaseTls` is now the single answer and
`supabasePoolConfig` keeps only the pooler quirk. The Supabase root ships in
`packages/db/certs`, fingerprint corroborated from S3 over a publicly-trusted certificate
and against the live pooler, and pinned by a test.

`sslmode` is refused rather than worked around, both cases measured against the live
project: `require` is an alias for `verify-full` in `pg` and fails against a private
root, and an `sslmode` in the URL *discards* an explicit `ssl` option, so the obvious fix
does nothing. `no-verify` is refused too. And the trap that would have made a careless
fix worse than the bug: with no `sslmode` and no `ssl`, `pg` connects in **plaintext**
and Supabase's pooler accepts it — so a remote host with no CA is an error, never a
fallback.

**2. The image could not boot at all.** The Dockerfile listed workspace manifests by hand
and had fallen four packages behind. pnpm does not fail on a missing workspace manifest —
it creates the dependency symlink and skips installing that package's own dependencies —
so the build succeeded and startup died with `Cannot find package '@photographic/core'
imported from packages/delivery/src/errors.ts`. Now `pnpm fetch`, which needs only the
lockfile, plus a build step that imports the server's graph so this fails the build
rather than the deploy.

`SUPABASE.md` was wrong and is corrected: the **session-mode pooler on 5432** for both
the migration and the app, because the Dockerfile has one `DATABASE_URL`. The old
"5432 direct for migrations, 6543 for the app" cannot be followed, and direct is
IPv6-only — fine from a Fly machine, not from CI.

Also: the root `test` script now runs packages one at a time. `packages/db`, `e2e` and
`apps/rest` share one Postgres and some reset its schema; the per-test resets the
deletion work added widened that race until it started failing nondeterministically as
`relation "app.oauth_client" does not exist`.

### Verified live

Against the real Supabase project: read its certificate chain, confirmed the bundled
root's SHA-256 matches, and ran `pnpm db:migrate` from a simulated image against the live
Frankfurt pooler — it reaches `tenant/user … not found`, meaning the handshake verified,
where before it died on `self-signed certificate in certificate chain`. Two tests cover
this and are skipped unless `LIVE_SUPABASE=1`, because a local Postgres has none of the
behaviour that caused the bug. Storage and Auth still have not met a live project.

A real two-person shared room through the running API: the default export contained
Emil's ketchup memory, his own room note and his own PDF — not Elias's note or Elias's
PNG — with the shared room marked `included: own` and Elias present by display name but
without his email. The full-transcript request then included both, added the note about
other members' data, and wrote a second `export.created` marked `full`. The archive
downloads through the signed link, `unzip -t` reports no errors, and after an immediate
deletion the shared room still reads "Borttagen användare — Emils beslut om budgeten"
while Emil's personal room, events and export archives are gone and his old link 404s.

Still open, and stated rather than hidden: the archive is buffered once before upload
because `BlobStore.put` takes bytes (multipart is the fix), no email carries the link
yet, and there are no web screens — the copy is served from the API so it cannot drift
from what the invite promised.

### For Track 2 — two handoffs

1. **`app.event.client_id` is yours, and its target now exists.** `app.oauth_client` is
   real and its `client_id` is a stable key, so the foreign key in your item 2 has
   something to point at. `client_label` is the immutable provenance label;
   `client_grant.display_name` is the person's rename and is what the history feed
   should show.
2. **`sensitivity` → approval gate is yours, not mine.** Emil confirmed that
   `sensitive` must force approval. That is a change inside `requiresApproval`, which
   your item 6 already reorders, and two tracks editing one function is a conflict —
   so I left it alone. Note `local_only` is **already absent** from both public schemas
   (the MCP tool takes a boolean `sensitive`; REST accepts only `normal | sensitive`),
   so that half of the decision needs no code change. The `remember` tool description
   already promises that sensitive memories "always require approval", which is not yet
   true — worth closing in the same change.

### Known gap, not guessed around

No Supabase project or credentials are available in this environment. Everything is
built and verified against local Postgres 16 + pgvector, and the Supabase-specific
wiring stays behind config — pointing `DATABASE_URL` at a Supabase Postgres is the whole
change on the database side. The Auth and Storage adapters need a real project to verify
against; flagged rather than assumed working.
## anslutning — stable public hostname

- **anslutning** — named Cloudflare tunnel support added alongside the existing quick
  tunnel in `scripts/public-mcp.sh` (opt-in via `TUNNEL_HOSTNAME` + `TUNNEL_TOKEN`, or
  `TUNNEL_ID`+`TUNNEL_CREDENTIALS_FILE`; refuses to start rather than silently falling
  back to a random hostname if credentials are missing), plus a new
  `scripts/cloudflare-tunnel-setup.sh` that drives the Cloudflare API
  (`CLOUDFLARE_API_TOKEN`/`CLOUDFLARE_ACCOUNT_ID`) to create/reuse the tunnel, its
  ingress and the DNS record end to end. Then the goal moved: Emil decided the memory
  needs to be reachable from any device, always — a tunnel from a laptop or a Cloud
  Agent VM dies with the machine, so it cannot be the production answer.
  **Production is now a real Fly deploy** serving `mcp.photographic.space`, using the
  `Dockerfile`/`fly.toml` already in this repo: `fly.toml` updated so `PUBLIC_URL` is
  fixed at the real hostname from the first deploy (not `*.fly.dev`) and
  `auto_stop_machines = "off"` so it is never scaled to zero. Added
  `scripts/cloudflare-dns-record.sh`, a generic idempotent single-DNS-record
  create/update (whatever `fly certs setup` prints), for whoever completes the Fly
  side. `scripts/deploy.md` rewritten: Production (Fly) first, quick tunnel as the local
  default, named tunnel demoted to a development convenience — with the exact steps,
  secrets, a requirements-vs-config checklist, honest cost (~$11–12/mo for the
  configured machine, run continuously), and what still blocks a permanent endpoint (see
  Blockers above). Not executed: any `fly` or live Cloudflare API command — no Fly
  account access, and the DNS record deliberately was not created from this VM (nothing
  real to point it at yet, and the zone is still propagating). All three shell scripts
  syntax-checked and their control flow (idempotency, conflict refusal, credential
  guards, error-body surfacing) exercised against a local mock of the Cloudflare API,
  since the real `CLOUDFLARE_API_TOKEN` only reaches newly started agents. Typecheck
  clean; e2e 22 memory + 22 postgres green (Postgres installed fresh in this sandbox to
  run that suite).
## session-context — the session-start context package

- **session-context** — the session-start context package (scope §8, "spara allt,
  skicka lite" — build-plan decision 10). What a fresh Claude session gets in
  `initialize` was already personal core context + core memories (the profile) + a room
  overview; this adds the fourth piece, an extremely short **"recent"**, and writes down
  the budget instead of letting it be "whatever fits".
  `ContextBundle.recent: HistoryEntry[]` — up to `RECENT_ACTIVITY_LIMIT` (4) of the
  newest events across every room the actor can reach, collapsed to one line per memory
  so a save-then-delete in the same window shows up once as *deleted*, not as a stale
  `saved: <body>` line the deletion was supposed to remove from context. Rendered as its
  own `<room-content>` block (it is exactly as untrusted as a room brief) under
  `RECENT_TOKEN_BUDGET` (150 tokens), and — this is the actual design decision — it is
  spent purely out of whatever slack remains after the profile and room overview already
  fit, so it is the *first* thing dropped when the budget is tight, ahead of room
  headlines and the active room's brief, and it drops as a whole block rather than
  shortening line by line: a "recent" missing one of four things with no way to tell is
  worse than no "recent" at all.
  The read sits behind a seam (`recentActivityFor` in `packages/core/src/recent.ts`)
  rather than calling `HistoryPort` directly from both `MemoryBundle` and `PgBundle` —
  track 2 is rebuilding the event log this reads from (PR #3: `item.superseded`,
  `member.left`, author columns), and none of that should require touching the bundle
  assembly or the renderer when it lands.
  Two leaks caught by the existing e2e suite before this could ship, both fixed by an
  action allowlist (`RECENT_BODY_ALLOWED` — `saved`/`updated`/`restored` only, mirroring
  the "safe direction" `ACTION_OF` allowlist `HistoryPort` already uses): a deleted
  memory's body was resurfacing through its own earlier `item.created` event, and a
  proposed instruction still waiting in the Godkänn-kön was reaching context as if it
  were already in force — the exact thing the approval gate exists to prevent.
  Did not touch `apps/rest/src/wiring.ts`, domain migrations, OAuth/scope/`resolveByName`,
  or the public MCP tool schema. Only `packages/core` (type + budgets + the seam),
  `packages/agent` (rendering), the two `BundlePort` implementations, and
  `apps/rest/src/serialise.ts` (one new field on the existing `/v1/context` response).
  `scripts/context-package-demo.{md,mjs}` runs the seeded Emil account through both
  renders and prints the literal before/after; the ketchup fact arrives twice, once in
  the profile and once in "recent" (`sparade — Emil: Allergisk mot ketchup`), and a
  second e2e test asserts "recent" is as isolated as search and the room overview
  already are (never the room-mate's private room, only the room actually shared).
  Coverage: `packages/core/src/recent.test.ts` (6), `packages/agent/src/instructions.test.ts`
  (+9, `describe('the "recent" block', ...)`), `e2e/src/journey.test.ts` (+2, both
  harnesses). Typecheck clean; e2e 24 memory + 24 postgres (run sequentially — the
  shared local Postgres does not survive `pnpm -r test`'s parallelism across packages
  that each call `reset(pool)` or expect a stable schema, which is pre-existing and not
  new here).
## fraga-mitt-minne — one search across memory, rooms and the calendar

- **fraga-mitt-minne** — "Fråga mitt minne" (scope §7): one search, across private
  memory, every room the person can reach, and the calendar, answering "vad bestämde vi
  om Photographic igår", "vad pratade jag om förra måndagen", "när började vi diskutera
  det här", "hur har Buyersclubs strategi förändrats i år", "vad gjorde du med
  informationen jag gav dig igår".
  `askMemory()` in `packages/core/src/ask.ts` composes two ports that already enforce
  room isolation — `RetrievalPort.search` (items + document chunks, unchanged) and
  `HistoryPort.list` (the calendar) — into one ranked `AskHit[]`, rather than adding a
  third place that could get the choke point wrong. Nothing new queries a table
  directly. Deliberately did not touch document ingestion, chunking, or a new FTS
  index — chunk hits pass through exactly as `RetrievalPort.search` already returns
  them; a date-scoped ask specifically omits them, honestly, because a chunk carries no
  date yet (`SearchHit.createdAt` is `null` for a chunk, non-null for an item — the
  platform track's index is what will change that, on their schedule).
  `sort: 'oldest'` answers "when did this start" by reaching into history even with no
  explicit date range, because the first mention of something may since have been
  deleted or only survive as a later edit — the current item's `createdAt` alone cannot
  always answer that.
  Shipped as an *extension* of `search_memory`, not a ninth tool: `since`/`until`/`sort`
  are new optional parameters, and a plain query with none of them takes the exact code
  path and rendering (`renderSearch`) the tool has always used, unchanged — every
  existing test for it still passes untouched. Only a date-scoped or oldest-first call
  routes through `askMemory` and a new `renderAsk`. Mirrored the same way on
  `GET /v1/search` (now accepts `since`/`until`/`sort`, `q` now optional) and on a new
  web screen, `/fraga`, a fifth rail icon — a search box, four quick date chips (Idag /
  Igår / Den här veckan / I år), results linking back to the room they came from.
  Two leaks found and closed while building the calendar side, both by the same
  allowlist (`ASK_BODY_ALLOWED` in `ask.ts` — `saved`/`updated`/`restored` only, the
  same shape as `HistoryPort`'s own `ACTION_OF` allowlist and for the same reason): a
  *proposed* instruction still waiting in the Godkänn-kön must not read as decided, and
  a *deleted* memory's text must not resurface. The second one needed more than the
  allowlist alone — a memory saved and later deleted inside the same searched window
  still carried its old `saved` event, which is itself an allowed action, so
  `collapseToLatestPerItem` keeps only the newest event per memory within the fetched
  window before the allowlist ever runs. Caught by a unit test before it reached e2e.
  Did not touch `apps/rest/src/wiring.ts`, domain migrations, the event-log schema,
  OAuth/scope/`resolveByName`, or the public MCP tool schema. Touched: `packages/core`
  (the new type + `ask.ts` + `createdAt` threaded onto `SearchHit` in both
  `RetrievalPort` implementations — a memory-item concern, not a chunking one),
  `packages/agent`/`apps/mcp` (tool schema + dispatch + `renderAsk`), `apps/rest`
  (schema + route + serialiser), `apps/web` (new screen + api client + demo data),
  and one two-line fix in the platform track's own unused-so-far `@photographic/retrieval`
  package so it kept compiling against the widened `SearchHit` (`toSearchHit` now
  threads `createdAt` through — nothing about their ranking or indexing changed).
  Coverage: `packages/core/src/ask.test.ts` (16, the composition itself — date bounds,
  the oldest-first reach into history, per-arm score normalisation, room-id fan-out,
  both body leaks and the collapse that closes the second one), `apps/mcp/src/dispatch.test.ts`
  (+6, against real `MemoryServices` with a controllable clock — a date window, sort
  oldest, cross-room isolation, the confused-deputy boundary, the empty-request
  refusal, the deleted-body leak end to end), `apps/rest/src/app.test.ts` (+5, the same
  shapes over HTTP), `apps/web` (+10 across two files, demo and live, including that a
  result links to the right room). `e2e/src/journey.test.ts` (+2, both harnesses): one
  proving a single ask surfaces both a matching memory and the calendar event that
  recorded it, one proving that ask is exactly as blind to a room-mate's private room
  as search already is. Typecheck clean; e2e 26 memory + 26 postgres.
  **Honestly weak, not hidden:** ranking is still the pre-existing lexical stand-in on
  Postgres (real embeddings only rank in the in-memory reference implementation via
  `FakeLlm`), so a query has to share actual words with what was saved — "vad bestämde
  vi" will not find "Vi beslutade" on its own. "How has X changed" only sees
  `item.updated` events; `item.superseded` is not emitted yet (a track-2 gap already on
  record), so a clean correction chain does not exist to show. A calendar-scoped
  history scan is capped at 300 events per room before filtering — a very long-lived
  room's oldest mentions can fall outside that window, and `collapseToLatestPerItem`
  above only sees what was fetched, so a deletion that lands just after an `until`
  bound is not there to suppress the save that precedes it inside the window. And "what
  did you do with what I told you" for something later deleted says *that* it was
  deleted, never *what* — a deliberate privacy trade-off, not an oversight.

- **fraga-mitt-minne-search-quality** — closed the lexical-only gap the entry above
  called out, after measuring it rather than estimating it (full corpus and numbers:
  `internal/swedish-search-quality-measurement.md` in the project store). The one
  number that mattered: on genuine paraphrase — the actual shape of "ask something you
  don't remember phrasing" — every lexical and trigram strategy scored 0%, real
  embeddings scored 100%. Three changes, done in the order that measurement justified:
  1. **The `to_tsvector('simple', …)` landmine.** The frozen schema's own GIN index
     used no stemming at all — wiring it up exactly as specified would have scored 4%
     on realistic Swedish questions. Migration `0003_swedish_search.sql` replaces it
     with `'swedish'` config. `PgRetrieval` queries it with an OR'd tsquery built from
     the same stemmed lexemes `to_tsvector` would produce, not `plainto_tsquery`, which
     ANDs every term and was measured as the bigger source of misses than the language
     config (19% with AND, 74% with OR, same index, same stemming) — commented in
     place so it doesn't get "simplified" back.
  2. **The embedding gap in `PgRetrieval`/`PgIngest`.** It already computed a query
     embedding on every search and threw it away; the in-memory reference
     implementation already wrote and used one on every ingest write. Made the
     Postgres path match: `item.embedding` is written by a deferred `embed_item` job
     (registered in `postgres-services.ts`, retried automatically by the existing
     `PgJobs` attempts/backoff — nothing new needed there), never inline with the
     write, so a slow or failing embed call can never be the reason a memory fails to
     save — the row commits first, the embedding backfills after. `vector.ts` formats
     the pgvector literal by hand rather than adding a client dependency for one
     conversion. Both `PgRetrieval`'s vector arm and `MemoryRetrieval`'s existing
     inline one now degrade to lexical/trigram-only on a thrown `embed()` — a missing
     key or an outage narrows the search, it does not fail it. Two real bugs found
     while measuring the actual shipped result rather than trusting the design on
     paper: the vector arm had no similarity floor, so it returned *something*
     whenever anything in scope had an embedding regardless of relevance (this is what
     the `never leaks the personal room` e2e test caught); and the trigram arm's
     threshold (0.1) was low enough that ordinary Swedish sentences shared that much
     character overlap from common short words alone, and several such matches
     summed in RRF fusion were enough to outrank a single confident, correct vector
     match — raised to 0.2 after measuring the actual gap between genuine matches
     (0.33+) and cross-sentence noise (0.09–0.14) in the same corpus. With both fixed,
     the real shipped code (`createPostgresServices` + `PgRetrieval`, a real
     `OPENAI_API_KEY`) scores 100% top-3 on the full 27-question corpus, including
     every paraphrase case; the same code with no key configured (`FakeLlm`, the
     default) scores 81%, from the trigram and stemmed-FTS arms alone.
  3. **A shared Swedish stemmer, because a second one just appeared.** PR #3's
     automatic room-routing matcher hand-strips a few Swedish suffixes for the same
     reason ("ledningen" -> "Ledning") and its own author flagged it as something to
     replace once a search index existed, rather than grow in place. Did not touch
     that file — two independent branches, already two conflict rounds — but built
     `packages/core/src/swedish.ts` so there is one suffix list rather than a second
     one drifting apart from the first. Implements the suffix-removal steps (R1 region,
     step 1 and step 2) of the actual Swedish Snowball algorithm — the same one
     Postgres's own `'swedish'` dictionary is built from — checked directly against
     `to_tsvector('swedish', …)` output rather than assumed, including matching its
     real gaps (it does not unify every tense/participle pair either, e.g. "godkände"
     and "godkänt" stay distinct in both). `swedishTerms()` (tokenize + stem) now
     backs every in-process lexical arm that is actually mine to touch: document-chunk
     ranking in `PgRetrieval`, `MemoryRetrieval`'s reference-implementation ranking,
     and calendar/history text matching in `packages/core/src/ask.ts` — replacing
     substring-inclusion scoring with real stemmed-term matching in all three. Not
     wired into PR #3's matcher, and not asked to be yet; it is what that file should
     import when the two branches are no longer both in flight.
  Coverage: `packages/core/src/swedish.test.ts` (9, including line-by-line agreement
  with Postgres's real stemming behaviour), `packages/db/src/services/retrieval.test.ts`
  (new file, 8 — plain match, Swedish inflection via the real SQL path, room isolation,
  the embedding backfill job, re-embed on update, graceful degradation on a throwing
  `LlmPort`, the vector-floor regression, and one test gated behind `OPENAI_API_KEY`
  that is skipped rather than failed without one), `packages/services-memory/src/degrade.test.ts`
  (new file, 3, mirroring the same degrade guarantee on the reference implementation).
  Typecheck clean; e2e and every package suite green, run sequentially — the shared
  local Postgres does not survive `pnpm -r test`'s parallelism, unrelated to this
  change and already recorded above.

## Personal Compass

- **retrieval agent** — the **Personal Compass**: six fixed principles for how a model
  treats the person, delivered at `initialize` in a dedicated, never-dropped block
  (`renderCompass`, reserved alongside the data-boundary rules and the recent-block's
  own reservation the way "recent" is the first thing given up rather than the last).
  Design and the 13→6 curation written up in the Personal Compass doc for Emil before
  building — worth reading for the judgement calls, not just the mechanism.
  Compass items are ordinary `app.item` rows under a new `compass` kind, tagged with
  `structured.compassKey`, not a parallel settings table — full provenance, calendar
  visibility and 30-day trash reversal for free. A principle nobody has customised
  renders its built-in default with no row behind it at all, so a new account gets the
  whole compass on day one without a fabricated `created` event ever claiming Emil said
  something he did not.
  Changes go through the gate two independent ways: `update_compass` (ninth MCP tool)
  only ever calls `IngestPort.propose`, which never auto-writes regardless of any
  argument — there is no `explicit` parameter to set — and `remember` separately refuses
  `kind: 'compass'` outright before the gate would even run. `extractFacts`'s kind
  coverage in `@photographic/llm` deliberately excludes `compass` for the same reason:
  no path silently reaches it.
  A second compass proposal for an already-customised slot resolves by exact key lookup
  (`activeCompassItem`) rather than the fuzzy word-overlap match `propose` uses
  elsewhere, so approving it supersedes the old wording instead of sitting beside it.
  Read-only `Personlig kompass` screen off the personal-room footer (own judgement call:
  editing stays conversational for V1, reviewed through the existing Godkänn queue,
  rather than a six-box form).
  New migration `0015_personal_compass.sql` — adds `'compass'` to `app.item_kind`, a
  `structured` column on `app.proposal` (mirroring `app.item.structured`, to carry the
  principle key through approval), and a `compass` cache column on `app.profile`
  (mirroring the existing `sections` cache).
  Coverage: 5 new `apps/mcp` dispatch tests, 2 new `packages/db` Postgres integration
  tests exercising the real `structured->>'compassKey'` query and the supersede path,
  9 new `apps/web` tests, 5 new `e2e` journey tests — green on both `HARNESS=memory`
  and `HARNESS=postgres`.

  **Built off the foundation tip, then rebased onto `main` once eight PRs had merged
  there and PR #9 turned out to point at a stale branch.** Real conflicts, not
  mechanical ones, in every file the compass touches that a later PR also rewrote:
  `packages/db/src/services/ingest.ts` and `services-memory/src/ingest.ts` (Track 2's
  event log gave `write`/`propose`/`applyProposal` new shapes — `intent`, `motivation`,
  `sourceItemId`, author columns, routing) — resolved by taking the merged file whole
  and re-deriving the compass's four touch points on top (the `remember` guard, the
  exact-slot lookup replacing the fuzzy `neighbours` match, `structured` threaded
  through `write`/`queueProposal`), rather than trying to reconcile line-by-line diffs
  against a function that no longer existed in its old shape.
  `packages/agent/src/tools.ts` and `packages/core/src/policy.ts` — re-checked rather
  than reapplied: `requiresApproval` now takes `sensitivity` and checks `explicit` last,
  exactly the property this feature depends on, so `APPROVAL_REQUIRED_KINDS` gained
  `'compass'` as pure defence in depth on top of the merged function rather than a
  reordering of it — the real guarantee is still that `update_compass` never calls
  `requiresApproval` at all, only `propose`, which has no `explicit` argument to pass.
  `packages/agent/src/instructions.ts` — the session-context package's `recent` block
  landed as its own `assembleBlocks`/`renderRecent` split; the Compass slots in as a
  third reserved block (`compassBlock`, counted into the same `reserved` budget as the
  rules), ahead of `recent` in every sense that matters: `recent` is still spent from
  whatever slack remains and is the first thing dropped, the Compass is now the last.
  `apps/rest/src/scoped-routes.ts` — checked, not changed: the Compass adds no REST
  route (`update_compass` is MCP-only by design), so nothing needed a scope guard.
  Migration renumbered from a collision-prone `0003` to `0015` — `main` already carries
  migrations through `0014`, and two files sharing `0003` on `main` is a tolerated
  accident, not a pattern worth repeating.
  Full re-verification on the rebased tree: monorepo typecheck clean; every package's
  test suite green (`packages/agent` 68, `packages/db` 104 (2 skipped, gated behind
  `OPENAI_API_KEY`/`LIVE_SUPABASE`), `apps/mcp` 60, `apps/web` 75, `e2e` 62 on
  `HARNESS=memory` and 62 on `HARNESS=postgres` — run each via the package's own
  `test` script rather than a bare `npx vitest run`, which skips the local
  `fileParallelism: false` config and reproduces exactly the shared-Postgres race
  other tracks already found and recorded above).

## Telefonnummer som enda väg in — email out of signup and login

- **signup design agent** — a mobile number is now the only way into signup and login.
  No email field, no channel picker, no "or use an address instead", and no copy that
  reads as an offer of one. Email was a door that does not open: both channels default
  to the `log` sender, `RESEND_API_KEY` is not set and Emil has decided it will not be,
  so the field accepted an address, answered `200`, and left the person waiting for a
  code that was never on its way.

  **Nothing was removed from the domain.** `SignupChannel` still has `email`,
  `ResendEmailSender` still exists and is still tested end to end over a real socket,
  `createCodeSenderFromEnv`'s provider selection is untouched, and `verifyCode` still
  resolves a person by address for a code whose channel is `email`. What changed is
  what the interface offers. Re-offering email later means letting `requestCode` take an
  address again — one function, not a rebuild, which is what
  `packages/delivery/src/integration.test.ts` now exists to keep true: it drives
  `ChannelCodeSender` through the port instead of through sign-up and still asserts that
  the code arriving in the mail is the code that verifies.

  **The check that came before the change: no real account was registered by email.**
  Asked against the live Supabase project rather than reasoned about, because removing
  email from login would lock such a person out permanently and that is a far worse bug
  than the one being fixed. `app.person` held four rows at 13:56 and five when re-checked
  at the end of the work, every one of them with an address and no phone — and every one
  of them an `@photographic.test` proof account created the same day by the deploy track's
  own live verification runs (`deploy-proof-…`, `compass-proof-…`, `real-host-…`,
  `emil-demo-…`), confirmed against that agent's transcript. The count is rising purely
  from those runs. `app.credential` is empty,
  `select count(*) … where email not like '%@photographic.test'` is **0**,
  `emil.henriksson@me.com` has no account, and `.test` is a reserved TLD that cannot
  receive mail — so none of these is a person and none of them is locked out of anything.
  **Emil himself has no account yet**, which is the other half of why this was safe to
  ship: the first real one will be made with a number.

  **The hidden path was the real bug.** `POST /v1/signup/request` still accepted
  `{"email":…}` after the field came off the screen — a saved link, an old client or a
  leftover `curl` would have got a request id for a code delivered nowhere, the same dead
  end as the field but harder to find. It now answers `400` with
  `Koden kommer med SMS. Ange ditt mobilnummer.` and sends nothing, and it refuses even
  when a valid number rides along in the same body, because answering the number would
  tell the caller that the address worked. `requestCode` is reachable from exactly one
  handler, which is checked by grep in the PR and by two tests in
  `packages/connect/src/routes.test.ts`. No URL parameter prefills sign-up: `main.tsx`
  reads `/invite/<token>` and `?auth_request=` and nothing else.

  **The hidden path, confirmed against the running system rather than inferred.** Probed
  `https://mcp.photographic.space/v1/signup/request` twice, at 14:33 and 14:55, before
  this branch is deployed: `{"email":"…"}` answers `200` with a request id and
  `"channel":"email"`. The same body against this branch answers `400`.

  **A correction, recorded because it was first written down wrong.** This entry
  originally also claimed production stored `070-123 45 67` as `+0701234567` — the trunk
  zero kept where the country code belongs, a number valid nowhere, and a second account
  for the same person signing up from another tab. The bug was real, but it was **already
  fixed on `main` before this branch existed** (`132802f`, 13:55) and that fix is
  **already deployed**. This checkout was a pre-built snapshot at `4803dd0` and had not
  seen it, so the claim came from reading stale local code rather than from the running
  system, and the masked hint (`***4567` either way) could not tell the two apart.
  Settled empirically instead: five requests for `0701234567` exhaust the per-destination
  allowance and `+46 70 123 45 67` is then refused with `För många försök`, which only
  happens if production already resolves both spellings to one destination. It does.
  `phone.ts` still has to get the trunk zero right, but as the same rule the narrower fix
  established — not as a discovery, and not as a live bug.

  **Swedish numbers, read the way people write them.** `packages/connect/src/phone.ts`
  is a new dependency-free module — the one piece of `@photographic/connect` the browser
  bundle loads, via a `./phone` subpath export — so the field and the endpoint agree on
  what a valid number is instead of drifting into two suffix lists. `070-123 45 67`,
  `0701234567`, `+46 70 123 45 67` and `+46701234567` all normalise to `+46701234567`,
  as do `0046…`, a bare `46…`, a trunk zero after the country code (`+46 (0)70…`), en
  dashes, non-breaking spaces, dots and brackets. That normalisation is what makes the
  rate limit per person rather than per spelling, and what makes a returning person one
  account rather than four.

  The series are PTS's, from `nrplansammanstallning` 2026-05-18: 070, 072, 073, 076, 079,
  and 078 A where A is 0–2 or 4–9 from 1 October 2026. `074` (paging) and `0783` (railway)
  are refused because they cannot receive an SMS, and `0710` mobile broadband with it.
  078 is accepted two weeks before it opens on purpose: a number that does not exist yet
  fails at the SMS gateway, and rejecting one that does would lock its owner out.

  Seven distinct messages instead of "ogiltigt telefonnummer", because the honest cases
  are the common ones — a landline is told it is a landline rather than that it is one
  digit short, and someone who types an address is told the code comes by SMS. **The
  field is never rewritten as the person types.** Their own number, their own spacing;
  the check runs on submit.

  The masked hint on the code screen is now `070-••• 45 67` rather than `***4567` —
  enough to recognise your own number, not enough to read over a shoulder.

  Coverage: `packages/connect/src/phone.test.ts` (new, 12 — every accepted shape, every
  allocated series, the three 07 ranges that cannot receive an SMS, and that it never
  throws), `signup.test.ts` rewritten onto numbers with three new properties (SMS is the
  only channel used, a rewritten number is the same rate-limit destination, a returning
  person is recognised through a different spelling), `routes.test.ts` +2 (an address
  refused, and refused even beside a valid number), `apps/rest/src/app.test.ts` +2 at the
  HTTP boundary, `apps/onboarding/src/App.test.tsx` +6 (one field only, the four shapes,
  the input left alone, a landline explained, an address told about SMS, "Använd ett annat
  nummer"), `packages/delivery/src/integration.test.ts` +1 (sign-up cannot be made to send
  mail). Monorepo typecheck clean; every package suite green plus `e2e` 62 on
  `HARNESS=memory` and 62 on `HARNESS=postgres`; `apps/onboarding` builds, with the phone
  module in the bundle and no `node:crypto` pulled in behind it.

  Checked on a running screen, not only in tests: `apps/rest` serving the real
  `apps/onboarding` build at `/login` the way the image does, walked in a browser — an
  address, then a landline, then `073-456 78 90`, then `+46 73 456 78 90` reaching the same
  `073-••• 78 90`. Nothing was deployed; `main` still serves the old bundle and this
  branch is not on it.

  **Two things left deliberately alone.** Room invites still carry a `channel: 'email'`
  destination — an invitation is a link somebody shares, not a code that signs anyone in,
  and it is not part of signup or login. And `apps/web` was not touched at all: it is not
  served in production yet and the deploy track is fixing that separately, so nothing here
  changes SPA mounting or server routing.
