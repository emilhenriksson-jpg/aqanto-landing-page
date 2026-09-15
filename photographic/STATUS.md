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
