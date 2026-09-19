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

- 2026-09-19 — Quiet personal start: removed technical launch prompts; ChatGPT/Codex/Claude desktop open blank composers, while supported Cursor and ChatGPT mobile routes carry only a short greeting. Background instructions govern a fresh, name-grounded greeting and concrete context-contribution examples; empty profiles and read failures are distinct. Collapsed start help and explicit clipboard copying replace automatic clipboard writes. Protocol, budget and UI tests cover delivery and launch behavior. Automatic native assistant-first replies and per-chat connector activation remain unverified; see CHAT-START.md.

### 2026-09-19 — familiar, unhurried conversations

- Warmer default compass, with personalised principles preserved; fresh-context instructions now limit check-ins to one optional question, stop after short answers/topic changes, and put listening and the current request ahead of memory import. No invented moods, completed plans, names, or local times.
- Empty profile and failed reads are distinguished from an empty account. Recent-event timestamps explicitly describe saving, not the date a real-world plan happened. Proposal pauses, full-batch review, provenance, sensitive-transfer consent and the 1,400-token instruction budget remain in place (minimum floor computed from the current instructions).
- A calmer home greets the actual account, remembers only the last chosen AI on the device, prioritises supported mobile apps and keeps setup/receipts under help. Optional account/history failures cannot block launch. Native ChatGPT/Codex links use explicit mode without a project/prompt; no automatic clipboard writes.
- “Dina AI:er” shows local dates and times instead of UTC time-only receipts. Conversation acceptance cases and external-client limits are in `docs/conversation-experience.md`.
- Local validation: core 142, agent 82, connect 147, MCP 67 and web 139 tests passed; package typechecks passed. Chrome desktop/narrow-layout review passed, including help, navigation, local receipt dates and no console errors. External native model replies remain a manual acceptance check.

- 2026-09-19 — ChatGPT desktop launch now explicitly selects Chat mode instead of inheriting Codex and its current project. Codex also selects its own mode. Links carry only mode and generic start instructions. Regression coverage checks desktop button separation, absent project parameters and unchanged mobile handoff; installed ChatGPT route parsing confirms mode support. Native UI handoff remains unverified (see CHAT-START.md).

- 2026-09-19 — Context contributions: connected AIs compare available user context before onboarding questions; one private review groups new facts, with separate consent for sensitive/inferred/conflicting entries. Cross-client pause/resume, historical offer suppression, source provenance, retry-safe preparation and approvals, and stale-consent checks are implemented for memory and PostgreSQL. New `prepare_context` MCP tool and first-party bulk review UI. See CONTEXT-CONTRIBUTIONS.md for data flow, limits and validation.

- 2026-09-16 — Native app launch: ChatGPT desktop now uses the installed app's documented scheme; ChatGPT/Claude mobile use associated app routes, Android explicitly targets official packages. Device-aware resolver handles iPad desktop mode. Desktop-only chat actions are unavailable on phones, web is a separate choice, and no app click counts as context delivery. See CHAT-START.md for verification and device limitations.


- 2026-09-16: Added room-independent `/chatt` start with ChatGPT, Codex, Cursor and Claude launch descriptors, explicit first-time setup, clipboard fallback and delivery verification separate from opening an app. Personal room moved to `/personligt`; direct phone login returns to chat start. Every new conversation requests fresh context; calendar/open-thread samples are reserved with room overviews even for a full profile. Added real MCP SDK reuse and cross-client continuity/approval/isolation tests (memory and PostgreSQL). Desktop/mobile Chrome signup/start/setup verified locally. See `CHAT-START.md` for provider limitations and test scope. CI and deployment are verified before merging this work.

- 2026-09-16: Completed PR #36 entry/exit with database-backed hashed browser-session revocation (migration 0024), shared by REST and OAuth consent. Logout preserves separate OAuth grants and clears legacy browser storage. Network errors offer retry; safe return paths restore the intended product page after phone sign-in, including first signup. Local web/onboarding/session tests and Chrome desktop flow verified; PostgreSQL persistence/restart tests added for CI. Deployment awaits authenticated Fly CLI on this workstation.


- **web/rest/onboarding** — Logged-out product visits now lead to the existing calm start and
  phone sign-in flow; a same-origin sign-out route clears even a stale browser cookie, Konto
  exposes it, and a 401 returns the person to a clear session-expired start instead of a dead shell.

- **web** — Reframed rooms as compact introductions followed by a single calm memory shelf:
  shared memory types no longer fragment a topic into artificial panels, documents match the
  same shelf language, and the personal room reaches its contents without a viewport-sized hero.
  Calendar and search now use quiet reading rows rather than stacks of cards.

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

## retrieval/routing/profil — supersede-kedjor, delad svenska, kompassens default

Branch `cursor/retrieval-routing-compass-loose-ends-ed14`, PR #16. Owns migration
**0021** (`embedding_provenance`). Renumbered twice: claimed 0016, moved to 0020 when `main`
took 0016/0017, moved to 0021 when `main` took 0020 for the app-role grants. Checked against
`main` each time rather than counted. Two things learned the hard way and worth having
written down:

- **Idempotent DDL is what makes a renumber cheap.** The ledger keys on content hash now, so
  a rename is normally recognised without replaying — but `IF NOT EXISTS` is the difference
  between a rename that costs nothing and one that needs an operator. 0021 has it throughout;
  0001–0020 do not.
- **A row applied before the content-keyed ledger has no checksum, so the rename cannot be
  derived.** On a database in that state the runner refuses with *"körda men inte finns på
  disk"* and the way through is naming the pair:
  `MIGRATIONS_RENAMED=0020_embedding_provenance.sql=0021_embedding_provenance.sql` (comma-separate
  several). It moves that one row and writes its checksum, so the next rename needs nothing.
  **Not** `MIGRATIONS_ALLOW_ORPHANS=1`, which stands the protection down for every row for a
  whole boot. Production never saw 0020 under either name — this branch is unmerged — so it
  will simply apply 0021 fresh; the variable was only needed on this sandbox.

Nothing in 0021 touches
a table on another track's list beyond adding three columns to `app.item`.

### "Hur har X ändrats över tid" följer nu kedjan

The scope's own sentence — *historiken visar både den ursprungliga uppgiften och
korrigeringen* — was not true, and `item.superseded` being emitted was only half of what
it needed. A correction does not edit the old memory: `applyProposal` writes a **new**
item and supersedes the old one, so the previous value lives on a different row under a
different short id. `HistoryPort.provenance` walks one item, so it reported "never
changed" — right about the row, wrong about the fact.

- `HistoryPort.changes` walks `superseded_by` in both implementations: forward from any
  short id in a chain to its head (so the id a person remembers from *before* the
  correction resolves to the same chain), then back over everything the head replaced.
  Recursive CTE on Postgres, `UNION` not `UNION ALL` so a cycle terminates rather than
  hangs — `superseded_by` is application-written and a loop is a bug, not an
  impossibility.
- `memoryChanges` (`packages/core/src/changes.ts`) composes it with two ways of *finding*
  a chain, because a question arrives in either tense: `RetrievalPort.search` reaches it
  through what the memory says now, and `HistoryPort.list` reaches the same chain through
  the wording it no longer uses. The second arm is the one that matters —
  "när bodde jag i Stockholm" must work after the memory says Göteborg, and search
  cannot find a superseded item by design.
- One step per **value**, not per event. A correction appends two events describing the
  same transition (`item.created` for the memory that replaces, `item.superseded` for the
  one replaced), and `resolveDispute` appends only the second because the winner already
  existed. Consecutive steps arriving at the same body collapse, keeping the earlier
  provenance.
- Shipped as `search_memory { changes: true }` and `GET /v1/search?changes=1`, not a
  tenth tool — same reasoning as `since`/`until`: a plain query takes the exact path it
  always has.

**The leak, guarded twice and tested five times.** A chain's steps are by construction
text the person has replaced — the one kind of content the allowlists in `recent.ts` and
`ask.ts` exist to keep out of a model's context. Those allowlists cannot help here,
because showing exactly those bodies is the feature. So the rule is about the *head*: a
chain is only ever returned for a memory that is currently `active` and readable, refused
in the storage query **and** again in `memoryChanges`. The tests ask with the deleted
wording itself, which is the phrasing guaranteed to match text that is meant to be gone:
`packages/core/src/changes.test.ts`, `packages/db/src/services/changes.test.ts` against
real Postgres, `apps/mcp` through the tool, `apps/rest` over HTTP, and `e2e` on both
harnesses.

### Routningens rumsmatchning använder den delade svenska stemmern

`routing.ts` carried its own eleven-suffix list with a note from its own author saying to
replace it rather than grow it. That list is gone; `swedishStem` does the work. It matters
beyond tidiness: a room's own memories are ranked by search and matched by the router, and
two ideas of what "ledningen" reduces to means the router files a memory somewhere search
then ranks differently.

The old list had **no genitive in it at all**, so "leverantörens" never met a room's own
"leverantörer" — Snowball's step 1 has `ens`, and both sides now reach `leverantör`.
Tested as a case that previously scored 0.2 against a 0.34 threshold, i.e. went private.

**The privacy asymmetry is untouched and re-tested against the better matcher.** The
shortlist is still lexical and deterministic, `confirmPlacement` can still only veto and
never propose, uncertainty and an equal second place still resolve private, the token
`roomScope` filter still applies, and nothing here returns "no approval needed". Two
things stayed local on purpose: `dedupeHash` still folds accents and case for the
length/function-word filters (`FUNCTION_WORDS` is written accent-stripped), and the
explanation still quotes the person's own spelling rather than the matcher's stems.

### Kompassens sex default är en egenskap hos koden

`app.profile.compass` defaults to `'[]'`, so a profile cached before
`0015_personal_compass.sql` read back with no compass at all — whether the block reached a
model depended on when the account was created and whether anything had since rebuilt the
projection. The Postgres path papered over it by treating a short array as a cache miss
and rebuilding the projection from inside a getter, which worked and made the guarantee
depend on a write happening on a read path.

`compassEntriesFromCache` fills every unpersonalised slot from `COMPASS_PRINCIPLES` on
every read, in both implementations. A cached `default` entry is deliberately ignored: it
is a copy of code from the day the projection was built rather than a decision, and
rendering it is how an edit to a default text silently fails to reach an existing account.
Tested against an account created before the column existed, one created after, the mixed
case of one personalised principle and five defaults, and the stale-cached-default case.

### Sessionspaketet levererar det det räknar ut

Three things it paid for and discarded, all confirmed against the code before changing
anything (found by the third review; verified rather than taken on trust):

- **`sinceLastSeen` had zero consumers in the whole repo.** Both projections computed it
  and packed it to `SINCE_LAST_SEEN_TOKEN_BUDGET`; the renderer printed `title` and
  `brief` and dropped the third field. It was the only line in the package that sounds
  like a memory developing over time rather than a static dossier. It renders now, inside
  `wrapRoomContent` like every other piece of room content, and it is the first part of
  the active room to give way when space is tight — the brief outranks it because a model
  that named a room asked for its contents.
- **`headlinesFor` served a placeholder from a process-local cache and queued no
  rebuild.** The cache empties on every restart and only a write to the room refilled it,
  so a shared room nobody had written to since the last deploy reached every session as
  "Inget sparat än" — a statement about the room, and a false one. It now asks for a
  rebuild, deduped per room so twenty sessions in a minute are not twenty summariser
  calls, and still answers immediately because session start cannot wait on a model.
- **`render()` picked its own budget.** `GET /v1/context?budget=500` was validated,
  documented and ignored: the parameter reached `build` and `render` fell back to
  `BUNDLE_TOKEN_BUDGET`, so `tokenCount` described a string the caller never got. MCP
  rendered against the tighter `INSTRUCTIONS_TOKEN_BUDGET` without having assembled
  against it. `ContextBundle.budgetTokens` records the ceiling and rendering defaults to
  it.

Also bounded the catch-up read (`SINCE_LAST_SEEN_SCAN_LIMIT`), which scanned every event
since `last_seen_seq` on the session-start path for a list cut to a token budget anyway.

### Och sedan: från dossier till öppning

The plumbing above delivers what it computes. Judged as a person rather than as a budget,
the *contents* were still a description of somebody rather than a way into a conversation:
every block said something settled, so a model reading them could only recite. Three
changes, in the order they were worth doing.

**1. Vad personen lämnade hängande.** The one thing nothing marked. This is the third item
`docs/agent-instruction-layer.md` set aside as needing machinery an instruction cannot
create — *"'Ask how something went' needs the calendar. The model has to know that
something was said three weeks ago and hasn't been followed up on"* — so this is finishing
an idea the project already had.

`openThreadsFor` derives it from the log alone: no new write, no table, no model call, and
nothing anybody has to remember to set. A memory is open when its kind implies an outcome
(`decision` or `note` only — "Allergisk mot ketchup" is not waiting on anything, and
listing it teaches a model the block is noise), **nothing has happened to it since** (the
newest event is `saved` or `updated`; a delete, a supersede or a dispute *is* a follow-up),
it is at least a week old (something saved yesterday is this week's work, and asking about
it reads as not having been listening), and at most ninety days old (older than that is
the past, and raising it is what makes a model feel like it is reading a file on you).

Two lines, hard cap. A model handed six of these reads them out as a list, which is the
exact behaviour the block exists to avoid. And the preamble says *Photographic har inte
hört något sedan dess — det betyder inte att det är ogjort*, because the person may well
have finished the thing and not mentioned it: "har du hunnit med X?" is right either way,
"X är fortfarande öppet" is wrong half the time.

Ranked **above** `recent` in the slack both are spent from. Between "here are four things
that happened" and "this one thing has been waiting three weeks", the second is what a
person notices, so `recent` is what gives way. Asserted as a sweep across profile sizes
rather than pinned to one, because the size at which the budget runs out moves whenever a
rule is edited and a test that needs re-tuning for that is a test that gets deleted.

**2. `recent` reads as a thread rather than a changelog.** It rendered
`- 2026-09-14: sparade — Emil: Allergisk mot ketchup`, four lines of it. Nobody says "on
the fourteenth of September I mentioned"; they say "i fredags". So the time is relative
(`relativeSwedishDay`, deterministic and offline — this is a voice turn), the room comes
before the verb because where a thing happened is what orients a reader, and a plain save
drops the verb entirely since saving is what this product does. The verb survives only
where it carries information: changed, removed, replaced.

Deliberately **not** a summarised sentence. That needs the summariser on a job rather than
on the read path, plus somewhere to cache it, and shipping a summary before the thing being
summarised is the wrong order — the same argument this repo already made about week and
month rollups. The rendering change is what the complaint was actually about.

**3. `Håller på med just nu` stopped claiming a note and a decision are the same thing.**
That section is fed by both `decision` and `note`, and the heading asserted currency for
everything under it. It was the section most likely to make a model confidently wrong about
a person's life — and a wrong fact is annoying where a wrong claim about what somebody is
*doing* reads as not knowing them at all.

`RenderedItem` gained optional `kind` and `at`, set for `currentFocus` and nowhere else:
`- [beslut · igår] Förvärvet skjuts till Q3 (p-7k2m)`. A date on "Allergisk mot ketchup"
would be noise, and noise is exactly what stops a date meaning anything where it matters.
The heading is now *På gång — beslut och anteckningar, daterade. Det äldsta kan ha slutat
gälla; fråga hellre än att påstå*, which hands the judgement to the reader instead of making
a claim the data cannot support.

### `?budget=` vägrar det den inte kan hålla

Accepting a value it cannot meet is a small lie, and one only found by measuring the
response. The old minimum was 100; `MIN_HONOURABLE_BUDGET_TOKENS` measures the
never-dropped text — preamble, Compass, confirmation style, data boundary — and comes out
at **497**. Below that the schema now refuses with a 400 naming the minimum, rather than
answering with a string twice the size of the number asked for.

Measured from the text rather than written down, so it cannot drift when a rule or a
default principle is edited. **And the honest caveat, stated per response rather than
hidden:** 497 is the floor for the un-droppable *text*, while a particular person's package
also keeps at least one profile item and their whole room list, so a budget above the floor
can still be exceeded by their own content. `GET /v1/context` therefore returns
`budgetTokens` next to `tokenCount`, and `tokenCount` is measured from the string the
caller was handed — so the pair is checkable instead of the number being implied to have
been met.

### Sökkvalitet — ommätt mot tester som kan misslyckas

The 81%/100% figures had come from a measurement whose corpus and harness were scratch
files, deleted after use, which made two numbers an embedding decision rested on
unfalsifiable. The corpus is now committed (`search-quality.corpus.ts`, 25 memories and
27 questions across the five original categories) and measured through the real shipped
path — `createPostgresServices` + `PgRetrieval`, live Postgres with `pg_trgm`, `unaccent`
and `pgvector`, recall@3:

| | recall@3 | hard-paraphrase |
|---|---|---|
| No key (`FakeLlm`, default) | **24/27 = 89%** | 2/5 |
| Real key (`text-embedding-3-small`) | **27/27 = 100%** | 5/5 |

**The 100% reproduces exactly. The 81% does not — it measures 89%, and the difference is
the corpus rather than the code.** The original 25 memories and 27 questions no longer
exist, so this is a reconstruction of the same shape and mix; it corroborates the
direction and the categorical claim rather than reproducing the exact figure. Anyone
quoting 81% should quote 89% and say which corpus.

The number worth quoting is the second column, not the first: without a real model, three
of five questions that share no content word with their answer are not found at all. With
one, all five are. The aggregate hides this, because the other 22 questions are answerable
lexically — which is also why the test asserts the paraphrase split as its own bound in
both directions, including a *ceiling* on the no-key run. A corpus that lexical ranking
can answer cannot be used to argue for embeddings.

### Embeddings: vad som lämnar servern, när, och vad som inte gör det

Detta är meningen som ska kunna sägas högt till en kund, så den är skriven för att vara
sann och specifik snarare än lugnande.

**Vad som skickas.** När ett minne sparas skickas **minnets egen text** — inte hela
konversationen, inte namn, e-post, telefonnummer eller konto-id — till OpenAI för att
räknas om till en vektor (`text-embedding-3-small`, 1536 dimensioner). Samma sak händer
med **sökfrågans text** vid varje sökning. Vid backfill skickas texten i varje aktivt
minne som ännu inte har en vektor, en gång. Rumsbeskrivningar och dokumentsammanfattningar
skickas när de genereras. Inget `user`-fält följer med, så ingen person-id kopplas till
texten hos dem.

**Vad som inte skickas.** Dokumentens innehåll: `chunk.embedding` skrivs fortfarande
aldrig, så ingen uppladdad fil har passerat en modell. Raderade minnen: backfillen rör
bara `status = 'active'`. Med `PHOTOGRAPHIC_LLM` osatt lämnar ingenting servern alls —
`FakeLlm` räknar ut vektorerna i processen.

**Vad OpenAI gör med det.** De **tränar inte** på API-data; det kräver ett aktivt
medgivande som inte är givet. De **sparar** däremot API-trafik i **upp till 30 dagar** för
missbruksövervakning. Noll lagring ("zero data retention") är ett avtal som träffas med
OpenAI på organisationsnivå — det följer inte med en API-nyckel och kan inte slås på per
anrop. Så det korrekta att säga är: *ingen träning, men upp till 30 dagars lagring hos
OpenAI, tills ett ZDR-avtal finns.* Completion-anropen skickar `store: false`, vilket tar
bort OpenAIs egen lagring av själva utbytet — men inte de 30 dagarna.

**Vad Photographic sparar om det.** Migration 0021 lägger `embedding_model`,
`embedding_provider` och `embedded_at` på `app.item`, skrivet i samma sats som vektorn, så
det finns inget läge där ett minne har en vektor men ingen uppgift om vad som räknade ut
den. `GET /v1/memory/:id/provenance` svarar med det, och frågan "har min text skickats
någonstans?" har därmed ett svar per minne. `external: false` betyder att vektorn räknades
ut lokalt — ett riktigt svar, inte ett tomt.

### Backfill: modellen gäller även det som redan är sparat

`PgIngest` köar en embedding vid skrivning, så att slå på modellen förbättrade ingenting
retroaktivt. Det är skillnaden mellan "sökningen blev bättre för det jag sparar framöver"
och "mitt minne blev bättre".

- **Ingen markör.** Arbetslistan räknas fram ur datan varje körning: `status = 'active'`
  och (ingen vektor **eller** en vektor från en annan modell). En omstart mitt i fortsätter
  exakt där den slutade, eftersom "där den slutade" bara är "det som återstår". En markör
  skulle behöva sparas, hållas konsistent med rader som skrevs under körningen, och
  nollställas för hand varje gång modellen byttes — tre sätt att tappa arbete.
- **Kan inte dubbeldebitera.** En rad lämnar listan i samma sats som vektorn skrivs, och
  bara ett backfill-jobb kan ligga i kön samtidigt (`dedupe_key` + `FOR UPDATE SKIP
  LOCKED`). Det enda fall som betalar två gånger är en process som dör efter att
  leverantören svarat men före `UPDATE` — som mest en batch, och inte undvikbart utan
  två-fas-commit mot någon annans API.
- **En vektor från `FakeLlm` räknas som arbete kvar**, vilket är exakt vad första
  riktiga körningen är: allt som embeddades medan `PHOTOGRAPHIC_LLM` var osatt bär en hash
  utan semantiskt innehåll.
- **Synligt nog att veta om det är klart.** `embeddingBackfillProgress` räknar återstående
  mängd direkt, jobbet loggar en rad per batch med antal kvar, och
  `scripts/backfill-embeddings.mjs` skriver JSON-rader till noll. Skriptet **vägrar** köra
  med `FakeLlm`, eftersom det annars skulle markera varje minne som embeddat och få den
  riktiga backfillen att se färdig ut innan den kört.

**Kör den så här, när nyckeln finns på appen:**
`DATABASE_URL=… PHOTOGRAPHIC_LLM=openai OPENAI_API_KEY=… node scripts/backfill-embeddings.mjs`
(`--status` skriver bara läget och avslutar.)

### Leverantörsbytet är bevisat, inte påstått

`packages/db/src/embedding-backfill.test.ts` konstruerar en **andra leverantörsidentitet**
och skickar in den genom `createPostgresServices({ llm })` — inget annat i anropet ändras.
Skrivvägen, `embed_item`-jobbet, sökningen, backfillen och proveniensen följer alla med.
Om ett byte krävde en ändring under den söm skulle testet inte kompilera.

**Vad ett byte till en europeisk leverantör faktiskt kostar** (skrivet nu, inte när det
behövs): en ny `LlmPort`-implementation är ungefär `OpenAiLlm` med en annan bas-URL, plus
en rad i `createLlmFromEnv`. Det som *inte* är konfiguration är dimensionen:
`app.item.embedding` och `app.chunk.embedding` är `vector(1536)`, och Mistrals
`mistral-embed` — det närmaste EU-svaret — ger 1024. Det är en migration (ny kolumn eller
ändrad typ, nytt HNSW-index) plus en full omkörning av backfillen ovan, alltså en
kostnad som skalar med antalet minnen snarare än med kod. Backfillens arbetslista hanterar
redan precis det fallet: ett minne vars `embedding_model` inte är den nu konfigurerade
räknas som arbete kvar.

### Grönt

Monorepo typecheck rent. `packages/core` 142, `packages/agent` 79, `packages/db` 151
(2 skippade: `LIVE_SUPABASE` och en gammal nyckel-gate), `packages/llm` 9,
`packages/services-memory` 10, `apps/mcp` 65, `apps/rest` 161, `apps/web` 75,
`e2e` 66 på `HARNESS=memory` och 66 på `HARNESS=postgres`; övriga paket oförändrade och
gröna. Postgres 16 + pgvector installerades i den här sandlådan för att köra
Postgres-sviterna; migration 0021 applicerad. Rebasat på `main` två gånger (0016/0017,
sedan 0018–0020), med tre konflikter, alla additiva: `apps/rest/src/app.test.ts` och
`e2e/src/journey.test.ts` (båda grenarna la till ett `describe` på samma rad — båda
behållna) och `apps/rest/src/routes/history.ts`, där `main` oberoende hittade samma sak jag
gjorde — att rutten slängde `motivation`, `source` och `changed` — så deras formulering
behölls och mitt `embedding`-block lades till. Mina e2e-tester bytte från `itWhenWired` till
`it`, eftersom `main` medvetet tog bort den hjälpfunktionen: en harness som inte kan byggas
ska vara ett hårt fel, inte ett skip.

### Territorium

Rörde inte `wiring.ts`, `session.ts`, `migrate.ts`, någon `ingest.ts`, `account.ts`,
exportvägen eller webbskärmarna. Två ställen där det här korsar delad mark, båda små och
värda att veta om vid merge: `packages/db/src/postgres-services.ts` (en rad som ger
`PgProjection` en `enqueue`, plus registreringen av backfill-jobbet) och
`packages/core/src/ports.ts` (`HistoryPort.changes`, `LlmPort.embeddingIdentity`,
båda nya — inget befintligt anrop ändrat).

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

## Durability — export streaming, job leases, document life cycle

Findings 7, 9 and 10 of the second review, plus Astra's note that the export download link
was not single-use. All four verified against the code before anything was changed; all
four were real, and one of them was worse than reported.

**Where the review was right, in its own words.** `BufferingSink` (`exports.ts:107–115`)
collected every chunk in an array and handed `Buffer.concat` to `BlobStore.put` — two
copies of the whole archive — while `ZipWriter.assertWithinZipLimits` refused anything past
4 GB against a 10 GB product limit on a 2 GB machine. `app.job` was claimed with `locked_at`
and nothing else: no lease, no reaper, so a process that died after claiming held the row
for ever. `documents.ts` wrote bytes and charged the person's quota before the document
transaction with no compensation and no delete route. `export_download` counted `use_count`
and never capped it, on a seven-day TTL.

**Worse than reported, in two places.** First, the download path had the same memory bug as
the build — `resolveDownload` did `blobs.get(key)` in full and the route answered
`c.body(bytes)` — so even a successfully built 8 GB archive would have taken the machine
down on the way out. Astra caught this (`B7`); the second review's finding 7 named only the
build. Second, `purge_trash` and `expire_invites` had handlers registered in both
composition roots and **nothing anywhere ever enqueued them**. So invite expiry was not
"stopping after a crash" as finding 9 says — it had never run at all, and neither had the
trash purge outside the timer in `server.ts`. A handler with no producer reads as a built
feature, which is why it survived.

**Export.** `ZipWriter` writes zip64 where it is needed: a streamed entry (unknown length)
gets a 64-bit data descriptor, an entry of known length under 4 GB is written exactly as
before, and the zip64 end records appear only once the directory outgrows zip32 — so a
small archive is byte-identical to what shipped. `BlobStore` gained `createUpload` and
`getStream`. `S3BlobStore` does a real multipart upload (8 MiB parts, awaited, so
backpressure reaches the zip writer); `LocalBlobStore` streams to a temp file and renames;
`SupabaseStorageBlobStore` spools to disk and streams off it, because the Storage REST API
takes one request with a length. **Deploy note:** the Supabase path is capped at
`SUPABASE_EXPORT_SPOOL_MAX_BYTES` (2 GB default) and refuses with an instruction rather
than filling the machine's disk — for the full 10 GB, point `BLOB_S3_*` at Supabase's own
S3-compatible endpoint and `S3BlobStore` takes over with no ceiling but the product's. One
build at a time per process, and the download is piped from storage.

Verified at the real limit rather than near it: a 10 GB archive written to disk through the
streaming sink is read correctly by `python3 -m zipfile` — entry sizes right, and the entry
whose local header sits past 4 GB found through the zip64 records
(`PHOTOGRAPHIC_NEAR_LIMIT_GB=10 PHOTOGRAPHIC_NEAR_LIMIT_DISK=1`, 13 s). The default suite
crosses the 4 GB cliff through a discarding sink and asserts the heap grows by less than
64 MB. Against Postgres, a 3 GB export of six 512 MB documents runs end to end with heap
growth under 96 MB and the archive digest computed as it streams.

**Jobs.** A claim is now a lease: `locked_by` is a worker id (`host:pid:rand`),
`lease_expires_at` is a deadline, and a handler heartbeats while it works, so "this takes
eleven minutes" and "this process is gone" stop looking the same. Every sweep calls
`app.reclaim_expired_jobs` first, which counts the attempt — a job that kills its worker
every time therefore fails visibly instead of looping. Recurring maintenance is scheduled
(`scheduleRecurring`, each run enqueuing the next), which is what fixes invite expiry
never having run. Exports get the same lease plus a reaper that requeues a build whose
machine went away, deletes its half-written object, and fails it visibly once attempts run
out. `GET /v1/ops/queue` (first-party) and a once-a-minute log line report depth, oldest
waiting job, lapsed leases and failure counts — counts and kinds only, never error text,
which can carry fragments of somebody's memory.

**Documents.** `app.blob_upload` records the storage charge as it is made, so a crash
leaves something a reaper can act on; the upload path compensates for the failures it is
alive to see, and `reconcile_storage` handles the rest, including ledger rows orphaned
before any of this existed. A blob is deleted only when no document, ledger row or upload
in flight references those bytes — content addressing means one object can belong to
several people. Documents now have trash, restore and a thirty-day purge with events in the
room's history; `app.search_chunks` skips the trash. The storage charge is held until the
purge on purpose: releasing it at delete would let a restore fail at the limit.

**The download link is single-use** in the sense that survives a dropped connection.
`complete()` is called by the route after the last byte, so a transfer that broke leaves
the link usable inside a 15-minute window, and a completed one kills it. One hour rather
than seven days, five attempts maximum, and a spent link answers exactly like a link that
never existed. Reasoning and the cost — the download stays proxied through our process
rather than a signed Supabase URL, because a signed URL cannot be counted or revoked — in
`EXPORT.md`, decision 3, which also records that this reverses 0013's stated choice.

Migrations `0018` and `0019` — numbered off `main`'s applied `0016_app_role_grants` and
`0017_lifecycle_atomicity`, which landed while this branch was open. Renumbering is free
here because neither of mine has been applied anywhere but a throwaway database; the ledger
keys on filename, so a rename after a real apply would re-run the DDL.

New suites: `packages/db/src/services/jobs.test.ts` (10),
`exports.test.ts` (14), `documents-lifecycle.test.ts` (12),
`packages/documents/src/streaming.test.ts` (7, including the S3 multipart request sequence
against a fake signer), `packages/export/src/near-limit.test.ts` (2),
`apps/rest/src/durability.test.ts` (10), plus `e2e/src/documents.test.ts` +2 running on both
drivers. Monorepo typecheck clean; every
package suite green; `e2e` 64 on `HARNESS=memory` and 64 on `HARNESS=postgres`.

**Merged with `main` rather than rebased**, so the history stays honest about what was
written against which tree. Three conflicts, all mechanical: `jobs.ts` keeps the write
path's transactional `enqueueJob` alongside the lease and heartbeat here; `wiring.ts` hands
`createApp` both the readiness probe and the queue source; `STATUS.md` keeps both sections.
Two of my tests were written against interfaces `main` has since changed — the
client-supplied `confirmed` flag is gone (a memory into the person's own room needs no
approval anyway) and `AgentClient` no longer has a bare `'claude'`.

One interaction worth checking rather than assuming, because CI cannot see it: `0016`'s
least-privilege role does not exist in CI or in local development, so nothing in the
pipeline proves my new tables and functions are reachable by it. Migrated a throwaway
database with `photographic_app` present and asked the role directly — INSERT and DELETE on
`app.blob_upload`, SELECT on `app.job_stats` and `app.export_stats`, EXECUTE on
`app.reclaim_expired_jobs`, `app.blob_is_unreferenced` and `app.orphaned_storage_objects`
all granted, and the views and function actually readable as that role. `ALTER DEFAULT
PRIVILEGES` in `0016` covers later migrations, which is what makes that true.

**Checked against a running process, not only in tests.** `tsx src/server.ts` against local
Postgres: the four recurring rows are seeded exactly once with future deadlines,
`GET /v1/ops/queue` answers 401 without a token and real numbers with a signed session. An
export requested over HTTP was built by the ten-second sweep, its link downloaded through
the streaming route, `unzip -t` clean, and the `x-photographic-sha256` header matched
`sha256sum` of the received file byte for byte — so the digest computed while streaming
describes what the person actually gets. A second request for the same link answered 404.
Re-driven after the merge on a real `SignedSessionIssuer` token rather than the old
forgeable shape, so this is a check of the merged tree and not of the tree I wrote.
Then the row was forced to `running` with a lapsed lease and a stray `pending_key`, as a
dead machine leaves it: the next sweep logged `exports_reclaimed`, deleted the stray object,
rebuilt the archive and returned it to `ready` at `attempts = 2`.

**Left deliberately.** Finding 8's proposal/deletion state machines were not touched: they
are the other agent's transactional lifecycle work in `ingest.ts` and `account.ts`, and two
of us rewriting those would conflict. Document delete does *not* go through `app.trash` —
that view is derived from item lifecycle events and belongs to that same track; documents
carry their own `deleted_at`/`purge_after` in the same shape, so merging them into one
trash surface later is additive. The `document.deleted` / `document.restored` /
`document.purged` events are in the log but not in the `app.activity` view, which is track
2's. No web screens: `DELETE /v1/documents/:id`, `/restore`, `/documents/trash` and
`/v1/ops/queue` are API only, and the screens track owns the rest.
## write-path — the approval gate and the log as the truth

Findings 2, 3, 5, 6 and 8 of `docs/review-second-opinion.md`, plus the `/v1/import` scope
hole and the dead `replay` from the English addendum. Branch
`cursor/write-path-approval-gate-and-log-atomicity-1aca`.

### Verified before changed, including one framing that needed adjudicating

A different reviewer had praised the approval ordering in `packages/core/src/policy.ts` as
the strongest security thinking in the repo, so the bypass was checked before anything was
touched. Both were right about different flags and **`policy.ts` was not weakened**:
`requiresApproval` genuinely tests `explicit` last and only against the 240-character rule.
The hole was `confirmed`, a different boolean on a different path — `share` and `move` —
where the caller supplied its own claim that a human had agreed.

Everything below was reproduced against the code before being changed. The one thing that
did **not** need changing is recorded under "What the review got wrong" at the end.

### The approval gate cannot be bypassed by a token any more

`confirmed` is gone from `IngestPort.share` / `move`, from `placementSchema` and from the
routes. It was an optional boolean any caller holding `memory.write` could set, and
`confirmed: true` placed or moved immediately instead of queueing a proposal — so a
connected model, or anyone with a stolen token, could copy private material into a shared
room with nobody approving it.

The database trigger did not catch this and could not have: it checks
`placement_explicit`, which `placeShare` sets to `true` itself. The trigger proves that
some code path claimed a placement was explicit; it has never been able to prove a human
agreed. That distinction is now written where the trigger is described.

`share` and `move` **stay** reachable with `memory.write`, deliberately. A model asking
"ska det här ligga i Buyersclub Ledning?" is the reason the queue exists, and a queue whose
entrance automation cannot reach is not a gate, it is a wall. What moved is the *answer*:
`POST /memory/proposals/:id` was already first-party and CSRF-protected, and it is now the
only path by which a memory reaches a room it was not written into.

`placementSchema` is `.strict()`, so a caller still sending `confirmed: true` gets a 400
rather than being quietly answered as though it had asked for something else.

### The right to delete is not the right to republish

`canRemoveMemory` returns `true` for an owner, and `resolvePlacement` called it while
raising the message *"Bara den som skrev uppgiften kan flytta eller dela den"*. The message
was the correct rule; the check was the wrong one, so an owner could relocate a member's
words into a room that member never chose.

Split into `canRepublishMemory` (author only, no exception for owners). Taking something
*out* of a room is visible to everyone reading it and reversible for thirty days, and that
is what owning a room buys. Putting it somewhere new hands the text to an audience that
could not see it before, and no trash takes a disclosure back. An owner who wants a
contribution gone still has `forget`.

### Human decisions are one class, not five routes patched one at a time

The real conclusion, and the reason this was worth generalising: the first-party rule had
been applied to three of five decisions the product reserves for a person, and each
omission looked defensible alone. `POST /memory/disputes/resolve` was on the wrong side of
it — despite `trust-and-permissions.md` 2.2 saying a dispute is settled "aldrig av en
modell, och aldrig av ett MCP-anrop" — and the absence of an MCP tool was the whole
enforcement. A token talking to REST does not need a tool.

`HUMAN_DECISION_ROUTES` now names the class (answer a proposal, settle a dispute, export,
delete an account) and `FIRST_PARTY_ONLY_ROUTES` is built from it. `scope.test.ts` checks
it three ways: every entry exists in the live route table, none of them also appears in
`SCOPED_ROUTES`, and each one refuses a token holding **every** supported scope. Two of
them are additionally asserted by name rather than by iterating the list, because a test
that loops a list disappears when someone shortens the list.

The tests are written against a stolen or over-scoped token rather than prompt injection,
which is the honest threat model here: there is no MCP tool for share, move or dispute
resolution, so a model that read a hostile PDF cannot reach any of them through its
declared surface.

### A read-only token could write through `POST /v1/import`

Reproduced: a token carrying exactly `DEFAULT_SCOPE` — which omits `memory.write` by
design — is correctly refused on `POST /v1/memory` and used to get 201 from `POST
/v1/import` with three proposals queued. Nothing was ever saved without approval, so the
containment held; what a read-only connection gained was the ability to fill somebody's
Godkänn queue with text of its choosing, which `policy.ts` itself calls the failure that
makes every other safeguard decorative.

Two things were wrong, not one. The route was missing from `SCOPED_ROUTES`, and adding it
there would not have helped: `connectRoutes` was mounted straight onto `app` while the
scope table is registered on the authenticated sub-app, so the guard would never have run.
The authenticated half of the connect flow is now mounted **inside** that group, so one
table covers every authenticated route. `POST /v1/connect/verify` and `/connect/status`
were in the same position and are covered too.

**The exemption list is the part worth reading.** It survived review because it carried a
plausible sentence — these routes "run before a token exists" — that nobody re-checked
against `app.ts`. An entry now names the mechanism that guards it, and the claim is
*asserted*: each exempt route is called with no `Authorization` header and must not answer
401. That test would have failed the day `/v1/import` was added. Two entries turned out to
be for a route that has never existed (`GET /v1/connect/verify`), which is a fair measure
of how much attention the list was getting; there is now a staleness assertion for the
exemptions as well as for the guards. `scope.test.ts` also mounts `connect` deps now —
without them the import routes were absent from the route table it reads, so nothing it
checked could have contradicted the exemption.

### Denied access to a room looks like a room that does not exist

`scopeFor()` returned an empty scope for an unreadable room and `day()` carried on to a
completely unscoped `SELECT title FROM app.room`. A protected room answered 200 with its
own title; a fictional id answered 200 with `null`. Room names are frequently the sensitive
part — "Vårdplan", "Uppsägningar" — and the difference between the two answers made the id
space enumerable.

Both now raise `NotFoundError` before anything reads a title, in both implementations. The
HTTP test uses two real people and asserts the status **and** the absence of the title
**and** that the two response bodies are byte-identical: either assertion alone passes for
the wrong reason.

Grading note, since the reviews disagreed: this is a real break of "nekad åtkomst ser ut som
obefintlig" but it needs the room's uuid, so the realistic exploiter is a former member or
someone with an id from a screenshot rather than a stranger. It sits below the `confirmed`
bypass, which needed only a valid token.

### Lifecycle transitions are one transaction each

`softDelete()` updated `app.item` and appended `item.deleted` separately; `restore()`
mirrored it; `undo()` cleared its token *before* restoring. `app.trash` derives membership
from the latest lifecycle event, not from `item.status`, so a failure between two statements
left a memory gone from its room, absent from every trash and unrecoverable — and an
interrupted undo burned the one token whose entire purpose is to be the way back.

All of it moved into `packages/db/src/services/lifecycle.ts`, one transaction per
transition, with the state change conditional in SQL. That conditional is what makes restore
and undo idempotent: a retry after a lost response appends nothing rather than writing a
second `item.restored`, and `undo` claims the token and the state in one `WHERE`.

Accepting a proposal was the same shape one level up — marked `accepted`, *then* applied, so
an interruption left an accepted queue entry with no memory and no retry, and two
simultaneous approvals could both pass the pending check. The status change is now the claim,
and the memory, its event, the `resulting_item` pointer and `proposal.accepted` commit with
it or roll back with it.

Account deletion became resumable steps rather than a dozen statements with no memory of how
far they got: a `progress` record written with each step's own SQL, and a lease rather than a
flag, so two sweeps cannot run one deletion and a sweep that died recovers without anyone
noticing. A worker that catches its own error hands the lease straight back, so a transient
object-storage failure does not leave a person half-deleted for the length of the lease.

### "Ta bort mina bidrag" was the worst of it, and it was not a race

`removeContributions()` was a bulk `UPDATE app.item SET status = 'deleted'` with
`purge_after` set and **no `item.deleted` event**, no undo token and no transaction — under
a comment quoting "ingen tyst massradering". No event means no row in `app.trash`, while
`purge_after` counted down anyway, so a departing person's contributions to shared rooms
disappeared with nothing in the other members' history, no way for an owner to restore what
they never saw leave, and a hard delete thirty days later. Every time the path ran.

Now one `softDeleteWithin` per contribution, each in its own transaction, **with the
departing person as the event's actor** — the other members are entitled to know whose
contributions left and that it was a choice, and this step runs before the tombstone so the
attribution is still there to record. A transaction per item rather than one around all of
them, because the loop only selects what is not already in the trash, which makes it
resumable and is what lets the deletion sweep retry it safely.

Authorship now comes from `app.item.author_person_id` rather than from a join against
`item.created` actors — the column *is* that projection, added in 0003, and the old comment
saying it did not exist was stale. `countContributions` was counting a different set from
the one `removeContributions` removed (every item the person had touched any event about,
including other people's), so "kept" and "removed" were answers to different questions.

### A test that was passing while the behaviour was broken

`account.test.ts`'s "removes them instead when the person chose that" asserted
`item.status = 'deleted'`, `purge_after` set and a `delete_reason` — all three of which the
broken bulk update set correctly. Its own comment claimed the removal went "through the
ordinary trash… so an owner can restore within thirty days", and nothing in it asked. It is
now asserted through `TrashPort.list()` and `TrashPort.restore()`, in both directions, plus
a test that the room's owner can actually get the material back. Nothing in the new
`lifecycle.test.ts` reads `item.status` at all.

### `EventPort.replay` is live code now, and `AGENTS.md` says what it can rebuild

`replay` was implemented on both backends and had no callers, while non-negotiable 2
promised that `item`, `profile`, `brief` and embeddings are "projections that a replay can
rebuild". An untested invariant that the whole product rests on is the same as an unmade
one.

`replayItemLifecycle` in `packages/core/src/replay.ts` rebuilds each memory's room, status,
current body and trash membership from `app.event` alone, and `divergencesFrom` beside it
reports every place the log and `app.item` disagree. `lifecycle.test.ts` asserts an empty
divergence list after **every** transition it exercises, including after each injected
failure — which is one assertion covering the whole class of bug this branch is about.
`AGENTS.md` now states what a replay does and does not rebuild (salience, use counts and
embeddings are recomputed rather than replayed; a purged memory is deliberately gone) rather
than implying a full rebuild, and spells out the append-only exceptions that already existed.

### Coverage

New: `packages/db/src/services/lifecycle.test.ts` (14, Postgres, with injected failures
between statements), `packages/core/src/replay.test.ts` (14, every expectation hand-written
rather than computed from the function under test). Extended: `apps/rest/src/app.test.ts`
(+7 — the calendar with two real people, and the placement surface from the side a stolen
token is on), `apps/rest/src/scope.test.ts` (+13), `packages/db/src/services/account.test.ts`
(+6, rewritten off `item.status`).

Each new guarantee was checked by breaking it on purpose and watching the test fail: the
non-transactional soft delete, the unscoped calendar title, `/v1/import` out of the scope
table, and dispute resolution off the first-party list.

Migration **0016** (`lifecycle_atomicity`): widens the `proposal.intent` check to include
`move`, adds `account_deletion.progress` and `claimed_at`. Numbered from 0016 because `main`
carries migrations through 0015.

### `intent: 'move'`, which nobody had reported

A queued move carried `intent: 'share'`, so approving "flytta p-7k2m till Buyersclub
Ledning" ran the share path: the original stayed in the personal room and a *copy* appeared
in the shared one. Harmless while `confirmed: true` was the usual path and load-bearing the
moment the queue became the only path, so it is fixed here rather than filed.

### What the review got wrong

- **The `policy.ts` ordering was never the hole.** `requiresApproval` already tests
  `explicit` last. Unchanged.
- **`app.item` has an author column.** `account.ts`'s comment said it did not and derived
  authorship from the log; 0003 added `author_person_id`. The comment was stale, not the
  code.
- **Finding 3 is not critical.** It needs the room's uuid; see the grading note above.

### Files outside this task's area, for merge sequencing

- `apps/rest/src/app.ts` — the authenticated half of the connect flow moved into the
  authenticated group. Needed for the `/v1/import` scope fix to have any effect. Small and
  localised, but it is the file the deploy track is also editing for SPA mounting.
- `AGENTS.md` — non-negotiable 2 rewritten (the replay promise and the append-only
  exceptions).
- `packages/core/src/policy.ts`, `ports.ts`, `domain.ts`, `index.ts` and the new `replay.ts`
  — `AGENTS.md` calls `packages/core` frozen. Touched deliberately, because splitting
  `canRemoveMemory` and removing `confirmed` from the port are both contract changes the
  fix requires.
- `packages/db/src/services/projection.ts` and `jobs.ts` — each gained a free function so a
  transaction can do the same work (`invalidateProjections`, `enqueueJob`), plus
  `markHeadlineStale`. No behaviour change for existing callers.
- Did **not** touch `wiring.ts`, `session.ts`, `migrate.ts` or any web screen.

### Follow-up: `EventPort.replay` proves the whole chain, on both drivers

`replay` stopped being dead code in PR #18, but the agreement assertion lived in exactly one
Postgres test file and covered exactly one link of the claim. Two gaps closed, both while
waiting for PRs #22 and #23 to land ahead of the trash unification:

**The reference implementation had no agreement check at all.** `MemoryEvents.replay` was in
the same position `PgEvents.replay` had been: implemented, exported, uncalled. `AGENTS.md`
treats `services-memory` as what defines correct behaviour, and the harness comment is blunt
about the two backends having drifted more than once, so this invariant holding on Postgres
and not there would be a divergence in the one property neither is allowed to lose. It is
also the only version of the check that runs with no database at hand.

**`profile` and `brief` were never shown to be derivable.** Non-negotiable 2 names four
projections and the replay covered one. Those two are a step further out — rebuilt from
`app.item` by `rebuild_projections`, so the chain is log → item → profile/brief — and the
test now throws the cached rows away, rebuilds them and asserts the same rendered text comes
back. One of those assertions is worth more than a text comparison sounds: a rebuild that
read the item table without its lifecycle state would resurrect trashed text into the profile
every model is handed at session start, so that is asserted separately.

Embeddings are stated rather than replayed: they are a function of the body, and recording a
thousand floats per memory in an append-only table to avoid one API call would be the wrong
trade. Cleared and backfilled through the ordinary `embed_item` job instead.

**The fixture is the part that took the thought.** An agreement assertion over an empty or
trivial log passes, so both files build a history containing a correction that supersedes, an
edit, a delete, a restore, a move between rooms, an approval through the queue and one memory
left in the trash — and then assert *that history exists* before trusting the agreement. The
contradiction needs an explicit negation, because `FakeLlm.compare` only reports `contradicts`
when one side is negated; without that the fixture would silently never reach the supersede
path. Checked by disabling the `item.deleted` append on purpose: the divergence assertion
catches it, which is the exact shape the old `removeContributions` produced.

New: `packages/db/src/services/replay.test.ts` (7), `packages/services-memory/src/replay.test.ts`
(5). `AGENTS.md` non-negotiable 2 now names the two files as the evidence rather than
describing the intention — the same lesson as the scope-exemption list, which survived review
because it carried a reason nobody checked.

Nothing else touched: no harness change, deliberately. PR #23 was editing `e2e/src/harness.ts`
while this was written, and a divergence check belongs there only once documents are part of
the trash it derives from. #23 has since landed, so that is the unification's job — where the
check has to cover documents as well anyway, which is the reason it was worth waiting for
rather than writing twice.

## Nödinloggning — a way in that is not the log and not a supplier

**2026-09-15.** The sign-in code was written to the application log in plaintext, and
`REDACTED_KEYS` listed `destination` but not `code` — so anyone who could read `fly logs`
could request a code for any number and sign in as that person. It had survived every
review because it was also the owner's only way into his own account: SMS is blocked on a
46elks credential we do not have, and closing the log without a replacement would have
locked him out of his own memory. Both halves therefore land together.

**The replacement.** `scripts/break-glass-signin.ts`, run on the machine over
`fly ssh console`, signs a ten-minute single-use token for one existing phone number with
`BREAK_GLASS_SECRET` and prints a link. Nothing in the HTTP surface can mint one — no
route calls `mintBreakGlassToken`, and the only other callers are tests. `/nodlage` reads
the token out of the URL *fragment* and posts it to `/v1/signup/break-glass`, so the
credential never reaches a server log, a browser history entry or a `Referer`; the exchange
verifies the signature, spends the token, appends `session.break_glass_used`, and mints the
ordinary session from the same issuer sign-up uses. Expiry is inside the signed payload and
every expiry assertion goes through the verifier, so no test passes while expiry is unchecked.

**Strictly safer than what it replaces**, which is the only claim that matters: it needs a
shell on the running machine rather than the right to read logs, it names one account rather
than any number typed into a form, it cannot create accounts, it expires in ten minutes, and
both the mint and the use are rows in the append-only event log where reading a code left no
trace at all — and they are on the person's own `Historik` screen, reading "Nödinloggning
skapad på servern" and "Nödinloggning använd för att logga in". That needed two values in
`HistoryAction` in the frozen `packages/core` plus both copies of `ACTION_OF`; a record only
we can read would have let us say the account was audited while the person saw nothing.

  The one remaining limit: single use is a process-local set, so a restart inside the token's
  remaining minutes forgets it. The TTL bounds that window, and a table for it would be a
  schema change on the path that exists for the day the product is already broken.

**The log hole, in three barriers.** Production selects `RefusingCodeSender` instead of the
log sender, so a channel with no provider refuses at *send* rather than at boot — a mistyped
secret must not take everyone's memory down to protect new signups (PR #11's reasoning, kept
verbatim). `LogCodeSender` also withholds the code when told to, which covers a channel added
later and forgotten in the selection. And `code` is in `REDACTED_KEYS`, which covers the
accidental caller. Development is untouched and asserted: with `NODE_ENV` unset, `development`
or `test`, the code is still in the log line, because that is how `pnpm dev`, `mcp-smoke` and
the live e2e smoke sign anyone in.

  Coverage: `packages/connect/src/break-glass.test.ts` (new, 9 — a forged signature, an
  extended expiry, a repointed person id, six non-token shapes, and no secret configured),
  `apps/rest/src/logger.test.ts` (new, 5 — including a code logged by something other than the
  sender), `apps/rest/src/connect-flow.test.ts` +10 through `createWiring` on a real socket (the
  session is accepted by a first-party route, the token is spent, an expired one refused, a
  session token refused as a break-glass token, the use in the person's own feed, the page
  served, and nothing accepted at all without a secret), `e2e/src/journey.test.ts` +1 asserting
  both actions reach the feed on *both* drivers — `ACTION_OF` is duplicated and drift there
  would mean the sign-in is visible in one implementation and invisible in the other —
  `apps/web/src/data/load.test.ts` +2 on the Swedish wording, and
  `packages/delivery/src/select.test.ts` +3. Monorepo typecheck clean; every package suite
  green, including `packages/db` 104 against a real local Postgres and `e2e` 63 on Postgres and
  63 on `HARNESS=memory`.

  Driven against a running production-mode process rather than a harness: `NODE_ENV=production`
  with Postgres, `POST /v1/signup/request` answering 502 with no code anywhere in the log, the
  script minting from a separate process, the link signing in through a real browser, the replay
  refused, and both event rows present.

  The `fly ssh console` step has since been walked on the live host against a real account:
  the script normalised `072-987 65 43`, minted a link, the exchange set an `HttpOnly`
  session with a real `expiresAt`, and replaying the same token answered 401. Reading a
  code out of `fly logs` is no longer a fallback — the send-time refusal is live, so
  `POST /v1/signup/request` answers 502 with `code_delivery_refused` and no code. Until
  46elks is configured, `BREAK_GLASS_SECRET` is the only key to an account.
## godkann-synlighet + proveniens per minne — PR #17

Branch `cursor/godkann-synlighet-och-proveniens-per-minne-ad1f`. Owns the approval
queue's visibility and the per-memory provenance path. The third review's "Vad båda
missade": two promises the product makes and did not keep.

### Godkänn-kön berättar nu att den finns

`requiresApproval` routes every uncertain or sensitive write — and by construction every
write into a shared room — to a human decision. Nothing in the app said so. Six rail
items with no counter, and the only signal was a model saying "jag har frågat dig" in a
conversation the person can close. Proposals piled up unseen, the AI looked like it had
forgotten, and the conclusion a person reaches from that is that the product is broken.

- `usePendingApprovals` is one module-level store read by the rail and by every screen
  that mentions the queue: one fetch per page load, and the count drops in the same
  instant a card is answered rather than a navigation later. `null` is "we do not know"
  and is deliberately not `[]` — signed out, offline and a bad minute from the API all
  land there, and reporting an empty queue on a failed read is the exact failure this
  undoes.
- A violet count on `Godkänn`, in the rail and the mobile tab bar, and only above zero.
- `PendingApprovals` on the personal room, `Rum`, and room-scoped inside a shared room.
  It names what is waiting, who would be able to read it, and says the missing sentence:
  **"Tills du svarar är det inte sparat, och ingen modell kan läsa det."** No dismiss —
  dismissing it would rebuild the invisible queue it exists to end.
- `.hero--personal:has(+ .waiting)` gives up hero height while something is waiting, so
  the notice is in the first viewport rather than one scroll below it. Measured: on a
  402×874 phone the whole card including its button clears the tab bar.
- The card on `Godkänn` says what accepting will do. `load.ts` was mapping `roomId` and
  `intent` away, so a request to share with three colleagues rendered as "Claude vill
  spara". Now "ChatGPT vill dela i Buyersclub Ledning", with the room's readership named
  — or counted, when the members have no names, which is today's normal case.
- A failed approval no longer looks like one that worked. The card was removed locally
  and the error swallowed by an empty `catch`; it now stays and says so.

### "Hur vet du det om mig?" går att ställa om ett minne

`MemoryRow.tsx` had body text, a short id and "Ta bort". The provenance endpoint existed
and the calendar answered per *event*, so the product's signature question could only be
asked about a day.

- Every memory row, personal and shared, carries "Hur vet du det?" and answers in place:
  where it came from, **why it was saved** (next to each other on purpose), when, who
  wrote it in, which room, whether you approved it, whether it has said something else
  before — and, once PR #16 is deployed, whether the text was sent to a model.
- `embedding` is only stated when the server recorded it. Absent means an older server
  and `null` means no vector; neither is a "nej", and printing one would be the single
  lie this panel cannot afford.
- `apps/rest/src/routes/history.ts` was computing `motivation`, `source` and `changed`
  and dropping all three. **This is the same edit PR #16 makes**; the rebase conflict is
  one hunk and the resolution is to take #16's, which is a strict superset.
- `PgHistory.provenance` filtered on nothing but the item id: no room filter, and
  `payload ->> 'item_id'`, which cannot use `event_payload_idx` (`jsonb_path_ops`) and so
  scanned every event on the platform. Now bounded to the asker's readable rooms and
  matched with `@>`. Tolerable when nothing linked to it; not with a link on every row.

### Verified against real data, not fixtures

Local Postgres, an account created through the phone sign-up flow, Claude connected over
real DCR + PKCE + OAuth and writing through MCP: four memories saved silently, four
decisions queued (an instruction, a sensitive fact, a shared-room write, and a genuine
`share`), two colleagues joined by invite. Then the merged tree (this branch + PR #16)
run with `PHOTOGRAPHIC_LLM=openai` and the embedding backfill, so the model line is a
real OpenAI answer rather than a fixture.

Suites: `apps/web` 92, `apps/rest` 112, `packages/db` 107 (+2 skipped), monorepo
typecheck clean.

### For whoever owns navigation

The app keeps its scroll position across routes, so any link from far down a long screen
lands mid-page with the heading off screen. Worked around inside this one link rather
than fixed in the router, which is not this branch's to touch.

### Known gap, not fixed here

Nothing in sign-up ever asks a person their name, so `app.person.display_name` is null
for every phone account and a shared room's members cannot be listed by name. "Kan läsas
av Anna och Jacob" therefore degrades to "Kan läsas av alla 3 i Buyersclub Ledning" in
production today. All-or-nothing on purpose: a list quietly missing the two members who
never entered a name would understate who can read it.
## observabilitet — larm som når en människa, och en bevisad återställning

- **`@photographic/ops`** (nytt paket). Fem kontroller en gång per minut i processen, och
  ett meddelande när en av dem *ändrar sig* — inte ett mätvärde till: reservläget
  (minnesimplementation eller lokal disk i produktion), migrationsliggaren mot det schema
  den påstår, jobbkön, exporter som hängt, och upprepade misslyckade utskick. Kanaler är
  webhook (Slack/Discord/ntfy) och SMS över samma 46elks-konto som inloggningskoderna;
  SMS bara för `critical`, en timmes cooldown, och ett meddelande när det löser sig.
  `HEARTBEAT_URL` pingas på varje frisk körning och medvetet *inte* när en kritisk
  kontroll faller — den enda larmvägen som fungerar när maskinen är borta. Variablerna
  står i `scripts/deploy.md`.
- **Migrationskontrollen litar inte på liggaren.** Varje rad prövas mot något migrationen
  faktiskt skapade (`MIGRATION_ARTIFACTS`), för att `migrate.ts` stämplar alla filer som
  körda när liggaren är tom och `app.person` finns — reproducerat: schemat stannade på
  0004, liggaren fick elva rader, noll filer kördes, och eftersom köraren bara läser
  liggaren rättas det aldrig. Ett test failar om en ny migration saknar artefakt.
- **Återställning körd, inte antagen.** 2 202 minnen, 2 892 händelser, 401 förslag och 80
  dokument (20,9 MB) skrivna genom produktens egna tjänster, säkerhetskopierade och
  återställda till ett scratch-mål: `pg_dump -Fc` 0,4 s → 2,1 MB, `pg_restore` 6,8 s,
  varje tabell och varje dokument identiskt (`pnpm --filter @photographic/ops
  verify-restore`, som hämtar och hashar om varje dokument, inte bara räknar rader).
  Samma läsvägar gav samma svar mot originalet och mot kopian.
- **Två fällor mätta.** `pg_restore --data-only` mot ett migrerat schema återställer
  *ingenting* — tabellerna laddas i bokstavsordning, så varje barntabell faller på sin
  främmande nyckel innan `person` och `room` finns. Och Supabases säkerhetskopior
  innehåller inte Storage, bara metadata om objekten, så dokumenten behöver en egen kopia.

### dokumentarkivet — den halva Supabase inte säkerhetskopierar

Supabases egen dokumentation säger att deras säkerhetskopior **inte** innehåller objekt som
lagras via Storage-API:t; databasen innehåller bara metadata om dem. Alltså: minnen,
händelser, rum och förslag kommer tillbaka från en daglig kopia, och de uppladdade
originalen kommer inte tillbaka alls. Det var den enda delen av en persons minne som inte
gick att återställa, och asymmetrin syns inte utifrån.

- **`backup-documents`** går igenom `app.document` i stället för att lista bucketen, så den
  kan inte hoppa över en fil produkten fortfarande refererar. Varje objekt prövas mot sin
  egen nyckel på vägen (nyckeln *är* innehållets sha256); ett objekt som inte stämmer
  rapporteras och kopieras medvetet **inte** — att arkivera det under originalets namn
  skulle göra ett upptäckbart fel permanent. Inkrementell: andra körningen kopierar noll.
- **`assertOffSite`** vägrar de två konfigurationer som ser ut som en säkerhetskopia och
  inte är det: en bucket i samma Supabase-projekt (raderas med projektet) och en katalog på
  Fly-maskinen (byts vid varje deploy).
- **Schemat ligger i `.github/workflows/document-archive.yml`**, alltså utanför både
  Supabase-projektet och Fly-maskinen. Nattligt inkrementellt, veckovis omhashning av hela
  arkivet. Tre oberoende sätt att märka att det slutat: GitHub mejlar vid misslyckad
  schemalagd körning, jobbet pingar `BACKUP_HEARTBEAT_URL` bara vid en ren körning, och
  API:t läser själv manifestets ålder.
- **`document_backup`** är den sjunde kontrollen: ingen kopia alls, en kopia som slutat
  röra sig, ett färskt manifest över ett arkiv som saknar objekt, och ett original som
  försvunnit ur Storage — med besked om det går att hämta tillbaka eller inte.
- **`restore-documents`** skriver tillbaka genom produktens egen `BlobStore`, alltså genom
  Storage-API:t som återskapar metadatan i `storage.objects`, och avslutar med att verifiera
  varje rad mot lagringen.
- **Övat:** 80 dokument (20,9 MB) kopierade i 0,6 s, hela bucketen raderad, allt återställt i
  0,4 s, verifiering 80/80 utan saknade eller skadade, `avtal-78.txt` serverad igen av
  produkten med samma sha256 som före raderingen, och jämförelsen mot produktionsavtrycket
  `identical: true`.
- **`scripts/restore-database.sh`** gör den uppmätta fällan onåbar i stället för varnad för:
  `pg_restore --data-only` mot ett migrerat schema återställer *ingenting*. Skriptet väljer
  flaggorna, vägrar ett mål som redan har minnen utan `--into-existing`, vägrar produktion
  utan uttryckligt medgivande, och avslutar med fel om resultatet är tomt eller om liggaren
  påstår migreringar som schemat saknar (verifierat: avslutskod 66, 70 och 71).
## Export, radering och tre front-end-luckor från granskningarna

- **web** — Export och kontoradering hade **ingen anropare**. Båda var byggda, testade och
  `firstPartyOnly`-grindade utan att någon skärm kunde trycka på dem, så de två löftena som
  gör en minnesprodukt värd att lita på — att man kan ta med sig sitt minne och att man kan
  lämna på riktigt — gällde API:et men inte produkten. De ligger nu bakom en `Konto`-plats i
  railen:

  - `/konto/export` (`Ta med ditt minne`) säger **vad arkivet innehåller innan man begär
    det**: hela det privata rummet, personens egna bidrag i delade rum men *inte* de andras
    anteckningar, rummens metadata, dokumenten i original, plus `README.md` och
    `manifest.json` med sha256 per fil. Räckvidden är ett beslut (`EXPORT.md` beslut 1), inte
    en detalj, så den står på skärmen. Jobbet köas, skärmen pollar var femte sekund medan
    bakgrundssvepet bygger arkivet, och nedladdningslänken mintas när personen ber om den.
    Inga påhittade nollor medan jobbet inte har körts — "0 händelser" läses som ett tomt
    minne, vilket är det enda en export aldrig får antyda.
  - `/konto/radera` (`Radera konto`) **hämtar samtyckestexten från API:et** i stället för att
    skriva om den, så det en person läser innan hen raderar inte kan glida från det inbjudan
    lovade. Inget är förvalt, i båda valen. Bekräftelsen säger rakt ut det man annars antar
    fel: **papperskorgens 30 dagar gäller enskilda minnen, inte ett raderat konto.** Den
    omedelbara vägen kräver den skrivna frasen som servern validerar
    (`IMMEDIATE_CONFIRMATION`), och kvittot säger hur många anslutna AI:er som kopplades bort.

- **web** — Papperskorg, Historik och Kompass **var redan nåbara** via fotlänkarna på
  startskärmen (`App.tsx` beskriver det som ett medvetet val). En tidigare granskning hade
  fel om det, och ingen andra navigation byggdes. Vad som saknades var skyddsnätet **i det
  ögonblick det betyder något**: en borttagen rad säger nu "Ligger i papperskorgen i 30
  dagar" och länkar dit, i stället för att den kunskapen ska hittas en vecka senare.

- **web** — Delade rummens aktivitetsflöde läste `DEMO_ACTIVITY[room.id]` **utan
  flaggkontroll**. Fixturerna nycklas på slug och ett riktigt `room.id` är en UUID, så
  uppslaget missade alltid: varje verkligt rum rapporterade "Ingen aktivitet ännu" för alltid.
  Flödet läser nu rummets egen historik ur event-loggen (`GET /v1/history?room=…&limit=12`),
  och ett tomt flöde betyder en tom logg. Ett trasigt anrop kostar inte rummet.

- **web/onboarding** — Det fanns **två inbjudningsskärmar**. Alla genererade länkar pekar på
  `/invite/:token` i auth-appen, som registrerar personen och accepterar inbjudan; kopian på
  `/i/:token` i produktappen satte bara React-state och gick med i ingenting. Kopian är
  borttagen (skärm, route, `api/invites.ts`, mappare, fixturer och CSS), `/i/:token` är en
  302 till den riktiga, och den kvarvarande skärmen bär nu **vem, vad och vad som stannar
  kvar ovanför knappen**: vem som bjuder in, att rummet är delat, att man får ett eget privat
  rum, och att det man skriver i rummet stannar där även om man lämnar det. Mätt: allt det
  plus `Gå med` och hela `SHARED_ROOM_CONSENT` ligger inom första vyn på 320×640 och uppåt.

- **onboarding** — `/start` är en publik sida för apex-värdnamnet, som idag servar
  ingenting. Plain svenska, en väg in för den som redan har konto (`Logga in`), och
  ingenting som inte är byggt: ingen röst, inga sammanfattningar, och den säger uttryckligen
  att nya konton inte är öppna för alla och att svenska mobilnummer är enda vägen in.
  **Routningen av apex är inte gjord här** — den ägs av deploy-spåret. Det som behövs:
  `A`/`AAAA` för `photographic.space` mot Fly, plus antingen en redirect till
  `https://mcp.photographic.space/start` eller en värdbaserad regel som låter apex `/` servera
  auth-appens shell i stället för produktappens.

- **web** — Layouten är **mätt, inte ögonmätt**, på 320×640, 360×640, 390×664, 414×736 och
  744×420 (kort landskap), över alla 13 inloggade skärmar plus `/start` och inbjudan: sidled
  scroll, element utanför skärmen, avkapade tabbaretiketter, innehåll under den fasta
  tabbaren, träffytor under 40px och sektioner utan luft. Två riktiga fel hittades och är
  lagade: `.ask-form__input` saknade `min-width: 0`, så `Sök` på `/fraga` låg 53px (320px) och
  13px (360px) utanför skärmen och gav sidled scroll; och `Dokument` på startskärmen låg
  tätt intill sista minneskortet eftersom `.sections` är en flex-kolumn med egen gap och
  syskonreglerna därför inte gällde. Kalenderns mobillayout rördes inte — den är mätt och
  korrekt sedan tidigare. Efter fixarna: 75 kombinationer, noll problem.

  Verifierat i en riktig webbläsare mot ett riktigt konto (telefonsignup, kod ur loggen,
  `VITE_USE_DEMO=0`, Postgres): 17 kontroller, inklusive att en export verkligen byggs och
  laddas ner som en zip med 19 händelser och 7 minnen ur just det kontots logg, att
  papperskorgen visar det minne kontot självt tog bort, och att aktivitetsflödet visar
  rummets egna händelser. Ingen radering slutfördes.

  Kvar att veta: en telefonsignup sätter inget `display_name`, så en riktig inbjudan säger
  "Du är inbjuden till ett delat rum" i stället för "Emil bjuder in dig". Skärmen hanterar
  båda; att sätta namnet någonstans i flödet är ett produktbeslut, inte en bugg här.

  Raderingsvägen är dessutom körd hela vägen **på ett engångskonto, aldrig Emils**: begäran
  från skärmen → kvitto → `GET /v1/account/deletion` visar en pågående radering med
  `executeAfter` 30 dagar fram och `contributions: keep` → `Avbryt raderingen` → `pending`
  är `null` igen. Skärmbild av det pågående läget finns i `media/`.

  En sak att veta för nästa körning: `pnpm test` med `DATABASE_URL` satt **nollställer den
  delade lokala databasen** (flera sviter i `packages/db` och `apps/rest` gör det), så ett
  verifieringskonto överlever inte en full testkörning. Skriptet som återskapar kontot ligger
  utanför repot; ordningen är signup → minnen → delat rum → godkännanden → en borttagning →
  inbjudan, och den behövs igen om någon vill upprepa verifieringen.

### Två linterfynd i samma pass

- **`[object Object]` i briefen, i båda implementationerna.** `String(payload['filename'] ??
  'ett dokument')` gav `[object Object]` för varje `document.uploaded`-payload vars filnamn
  inte var en sträng, och raden var identisk i `packages/db/src/services/projection.ts` och
  `packages/services-memory/src/projection.ts`. Samma bugg två gånger är vad två kopior
  producerar, så meningen bor nu på **ett** ställe: `briefEventLine` i
  `packages/projection` (som var ett tomt skal med `export {}`), med sex tester varav ett
  itererar över payloads som inte går att läsa. Ingenting tvingas till sträng längre — det
  som inte är en sträng blir "ett dokument". Både `packages/db` och
  `packages/services-memory` beror nu på `@photographic/projection`; det är två paket utanför
  `apps/web`, och skälet är just att fixen annars hade blivit en tredje kopia.

  Bevisat mot Postgres med **två riktiga medlemmar**: A laddade upp `offert-kok.txt` i ett
  delat rum, B (registrerad via inbjudningslänken, alltså också ett bevis på att den
  kvarvarande inbjudningsskärmens väg fungerar) läste `GET /v1/context?room=…` och fick
  `- Någon laddade upp offert-kok.txt`, utan `[object Object]` någonstans i kontextpaketet.
  ("Någon" därför att telefonsignup inte sätter `display_name` — samma sak som noteras ovan.)

- **Villkorligt anropad hook.** `SharedRoom` returnerade `<Navigate>` före `useRoomData`, så
  hooken anropades bara på vissa renders. Det failar inte högt; det failar som state som
  matchas på anropsordning mot en tidigare render med en hook till. Omdirigeringarna ligger nu
  i ett yttre skal och laddningen i `SharedRoomLoader`, samma mönster som
  `DocumentsSection` redan använder. Den andra förekomsten låg i produktappens
  `InvitePreview`, som är borttagen.

- **Lintern körd mot branchen** i en separat worktree med [#19](https://github.com/emilhenriksson-jpg/aqanto-landing-page/pull/19):s
  konfiguration ovanpå, i stället för att vänta på CI. Noll fynd i mina filer efter fixarna.
  Två saker att veta för den som mergar: `no-floating-promises` är konfigurerad så att `void
  promise` **inte** räcker, så klickhanterarna i de nya skärmarna avslutar med `.catch` som
  faktiskt visar felet för personen; och min projektionsfix gör två `no-base-to-string`-
  suppressions i `eslint-suppressions.json` obsoleta, så `pnpm lint:prune` ska köras när #19
  och den här branchen möts. De två återstående fynden i `apps/rest/src/server.ts` är #19:s
  egna — dess diff lagar dem, den här rör dem inte.

## one-trash — memories and documents in one papperskorg

Follow-up to the write-path work and to PR #23's document life cycle, done once both were on
`main`. Branch `cursor/one-trash-for-memories-and-documents-1aca`.

The reason is not tidiness. A person who deleted something goes looking in one place, and a
thirty-day promise that behaves differently for a document than for a memory is a promise with
a footnote. Documents arrived with their own `deleted_at`/`purge_after`, their own listing
endpoint and no screen at all — which was the right call while the item lifecycle was still
being made transactional, and the wrong one once it had landed.

### Two halves, and only the first needed no contract change

**Documents now go through the same transactional lifecycle path.** `PgDocuments.remove` and
`.restore` had the shape `softDelete` used to have: `UPDATE app.document`, then `appendEvent`
as a separate statement. Same consequence — a failure in between leaves the file gone from its
room with nothing in the log saying so, and the room's other members watch a document disappear
untraceably. Both now go through `trashDocumentWithin` / `restoreDocumentWithin`: one
transaction, conditional in SQL, so a retry appends nothing rather than moving the purge
deadline. Two functions rather than one generic helper over both tables, because a document has
no undo token, no short id and a storage charge that must outlive the delete.

**`app.trash` is one view over both lifecycle event streams** (migration 0021). Both halves are
derived from the most recent lifecycle event rather than one from the log and one from a column,
which is what gives delete-undo-delete one answer for a file as it already had for a memory.
That ordering was the actual prerequisite: the union is only honest because `document.deleted`
is now written inside the transaction that updates the row.

### The discriminator, introduced here rather than guessed at earlier

`TrashEntry` is a discriminated union — `type: 'memory' | 'document'` — and not a widened record
with half its fields nullable, so a screen cannot render a document as though it had a body.
`type` and not `kind`, because `kind` already means `ItemKind` on the memory half.

The two are addressed differently and always have been: a memory by the short id a person can
say out loud, a document by its uuid. `TrashHandle` carries that, `trashHandleOf` reads one out
of a path segment, and because the two id shapes cannot collide **one route serves both** —
`POST /v1/trash/:handle/restore` and `DELETE /v1/trash/:handle`. The wire format carries both
`type` and `handle`, so the `Papperskorg` screen restores what it is looking at without knowing
which shape addresses which kind of thing.

`GET /v1/documents/trash` and the document delete/restore routes are kept as a narrower door
onto the same trash rather than removed — deleting another track's three-day-old API is not a
call to make quietly, and both derive from the same events, so they cannot disagree.

Purge stayed one shape with a document-only blob step inside it. `app.purge_expired_items` is
the only code permitted to redact `app.event` and, being a SQL function, cannot delete a blob —
so a document's bytes go from TypeScript after its row does. That asymmetry is real rather than
untidy, and it is written down in `TrashPort` and in `PgTrash` so the next person does not
"simplify" it into either a second purge path or orphaned bytes.

### Two drifts the shared e2e suite caught, which is why it runs on both drivers

- **`MemoryDocuments.remove` did not put the person's reason on the event.** `PgDocuments` did.
  Since the trash reads its reason from the log, the same delete showed a reason on Postgres
  and `null` on the reference implementation. Caught by `e2e/src/trash.test.ts` on the second
  driver, not by any unit test.
- **The short-id pattern had a second copy.** `trashHandleOf` was written against four
  characters, which is what short ids were when the rule was last written down; they widened to
  six in the meantime, so it refused every id minted since. Rather than fix the copy,
  `SHORT_ID_PATTERN` now lives in `packages/core` beside `generateShortId`, and both the REST
  schema and the handle parser read it.

### One divergence check, on the seam, for both kinds

`Harness.divergences()` rebuilds every memory *and* every document from `app.event` and reports
each place the log and the tables disagree. It is asserted at the end of `journey.test.ts` and
`calendar.test.ts` — by which point those files have driven saves, approvals, corrections,
deletions, restores, moves, shares and disputes through whichever backend is selected, so it is
one assertion over all of it. This is where the check belonged all along, which is why it was
worth waiting for #23 rather than writing it twice.

`replayDocumentLifecycle` and `documentDivergencesFrom` are narrower than the item versions and
say so in place: a document's content is a blob plus an extraction the log never carried, so
what the log can rebuild is room, filename and trash membership — exactly what the trash
derives from.

### A finding worth its own line: the acceptance suite is `any`-typed

`TrashPort.restore` changed shape. Every typed consumer in the repo reported it at compile time.
The two call sites in `e2e/src/journey.test.ts` did not — they failed at runtime, in the suite
whose job is to notice that kind of thing early — because `harness` is declared `any` there and
in `calendar.test.ts`.

The existing comment estimated "two dozen" narrowing errors as the cost of fixing it. Measured:
**31 in `journey.test.ts` and 70 in `calendar.test.ts`**. Both comments now carry the real
number and the reason it is worth doing separately rather than inside a change that has to stay
reviewable. Left as it is deliberately; `documents.test.ts` and the new `trash.test.ts` are
typed, so the unified surface itself is covered by typed suites.

### Coverage

New: `e2e/src/trash.test.ts` (8, both drivers — one list, filename versus body, interleaved
ordering, restore by handle, delete-undo-delete, early purge to the bytes, the thirty-day sweep,
and room isolation on the new query), `packages/db/src/services/documents-lifecycle-atomicity.test.ts`
(6, failures injected between statements). Extended: `apps/rest/src/app.test.ts` (+2 — a deleted
document beside a deleted memory over HTTP, and an unparseable handle answering like a missing
one), `journey.test.ts` and `calendar.test.ts` (+1 each, the divergence assertion).

The fault injector is one copy now (`packages/db/src/testing/fail-once.ts`) rather than the same
twenty lines in two files, and writing it without type assertions made two suppressed
`no-unnecessary-type-assertion` errors unnecessary — pruned from `eslint-suppressions.json`
rather than joined by a third.

Green: monorepo typecheck and lint clean; every package suite; `e2e` 74 on both `HARNESS=memory`
and Postgres. Each new guarantee was checked by breaking it on purpose — the non-transactional
document delete, and the unified view.

### Notes for whoever is next

- **Migration 0021** replaces a view and creates no new relation, so its `ops` artifact is the
  view's new `entry_type` column rather than `to_regclass('app.trash')`, which 0004 already
  claims and which is true either way.
- **`app.css` was checked** for the shared-closing-brace problem reported after today's merges:
  braces balance, no rule opens inside another rule, nothing unclosed. Either #26's merge
  already fixed it or it never reached this branch. No change made.
- **Local setup, not a code issue:** migration 0020 creates `photographic_app` with no password,
  so a full sequential `pnpm test` on a fresh database fails `wiring.merge.test.ts` and
  `connect-flow.test.ts` with `password authentication failed`. `ALTER ROLE photographic_app
  PASSWORD 'photographic_app'` matches what `scripts/run-suites.mjs` derives. Worth a line in
  the local setup docs by whoever owns them.
  refused, and both event rows present. Fly credentials were not available in that environment,
  so `fly ssh console` itself is the one step nobody has executed — the shape it needs is a
  separate process on the machine with `DATABASE_URL` and `BREAK_GLASS_SECRET`, which is what
  was tested.

## förnamn — a name so a shared room can name people instead of counting them

Phone-only sign-up never asks anyone their name, which meant a shared room could only say
"3 medlemmar", provenance could never say "Jacob skrev det", and an invite read as being
from nobody. Adds a first name, asked once at the right moment, and threads it through the
three surfaces that already had a fallback word instead of a name.

**Storage: a memory like any other, not a settings field.** `name` is a new `app.item`
kind (`0023_first_name.sql`), mirroring how `0015` stored the Personal Compass — full
provenance, history and 30-day trash for the item that says what a person is called, not
a second source of truth beside it. At most one is ever active: `IngestPort.setFirstName`
finds whatever `name` item is active in the personal room, writes the new one, and
explicitly supersedes the old one (the same shape a same-author correction already takes
in `applyProposal`) — one transaction, so the item and the `app.person.display_name` cache
update together or not at all. `display_name` stays the read cache every existing surface
already joins against (provenance, invites, room membership, the history feed), so making
those three surfaces name people instead of falling back needed **zero changes to any of
their SQL** — populating the cache was the whole fix.

**No MCP tool, and refused everywhere a model could reach it.** Unlike the Compass, a name
has no propose path at all: `remember` and `propose` both refuse `kind: 'name'` outright,
in both `PgIngest` and `MemoryIngest`, so `POST /v1/import` and `POST /v1/memory/proposals`
cannot be used to slip one into some other room and skip the singleton-supersede logic.
`packages/llm`'s fact-extraction kind coverage excludes it the same way it already excludes
`compass`, so a model can never infer a name from something said in passing. The one write
path, `PATCH /v1/account/name`, is first-party only (`FIRST_PARTY_ONLY_ROUTES`) — same
reasoning as renaming a connected client: no scope should let an AI decide what a person is
called, because a scope that permitted it would be held by every client holding it.

**Asked once, and only once, never a wall.** `apps/onboarding` shows "Vad heter du?" right
after the code verifies, gated on `VerifyCodeResponse.created` so a returning person is
never asked again — skipping it once means setting it later, from the account screen, is
the only remaining door. Both "Hoppa över" and an empty submit skip without calling the
API at all. `apps/web` gained that account screen (`/konto`, footer link off the personal
room, matching Kompass/Historik/Papperskorg) — one field, prefilled, and a plain "Sparat
som …" or "Inget förnamn angett än." rather than ever showing a blank.

**The fallback, made consistent rather than invented.** "Någon" already existed as the
product's word for an unknown person (`historyWho`, invite `invitedByName`, dispute
`authorName`) — this reuses it rather than adding a second word. `apps/web`'s shared-room
member list used to *drop* a nameless member from `memberNames` entirely (undercounting
who was actually there); it now maps every member to a name or "Någon", never to nothing.

**Named, not counted.** `SharedRoom.tsx`'s "Delad med N personer" is now "Delad med
{namn}" (`joinNames`, Swedish "och" before the last name), reading `memberNames` as *the
other* members — computed from a new `isSelf` flag the REST room-members response adds
from the request's own actor, so the client never has to guess its own identity. Avatars
in the room header shrank by one for the same reason: they show who else is here, not you
plus who else is here. `InvitePreview.tsx` already had `invitedByName`/"Någon" wired up
from before this change; it now actually receives a name once the inviter has one.

**Deliberately not touched.** The personal profile injected into a session, retrieval and
search, and the MCP tool surface — a first name is not something the product decided a
model needs handed to it, and nothing here adds it. `RoomSummaryDto`/the "Alla" room grid
still shows counts only; naming lives on the room a person has actually opened, and
widening the summary contract for it was more than the ask.

Coverage: `apps/rest/src/app.test.ts` (+6, the whole path over HTTP — unset on a fresh
account, set and reaching provenance/invites/membership, supersede, refused for a
connected client, refused as an ordinary memory kind), `packages/db/src/postgres-services.test.ts`
(+2, against real Postgres — supersede plus the `display_name` cache, and the `remember`/
`propose` refusals), `apps/web` (`Account.test.tsx` new + `App.test.tsx`/`load.test.ts`
updated for member naming), `apps/onboarding/src/App.test.tsx` (+6, the prompt itself:
first-sign-in only, skip, empty-submit-is-skip, saves and continues, a save failure that
does not block the way forward). Monorepo typecheck clean; `pnpm lint` clean (one stale
suppression from a cast this removed, pruned rather than left behind); full `pnpm test`
green — unit 703, e2e-memory 62, db 285 (2 skipped, pre-existing and unrelated), e2e-postgres 62.

Verified by hand against a real Postgres-backed process, not only in tests, at desktop
and mobile widths, with two real phone-signup accounts: Jacob sets his name at first
sign-in ("Vad heter du?", skippable, never a wall); Anna signs up separately, skips it,
and confirms `/konto` reads "Inget förnamn angett än." rather than blank or "undefined";
Jacob invites Anna into a shared room and the invite landing names him ("Jacob bjöd in
dig till"); Anna's view of the room says "Delad med Jacob"; Jacob's view — the case that
actually occurs, a pre-existing member with no name set — says "Delad med Någon", not a
count, not blank, not a stray comma. Re-signing in as Jacob a second time confirmed the
prompt never returns for an account that already has a name. One inconsistency found and
fixed on the way: `apps/onboarding`'s own invite landing said "Du är inbjuden till" for a
nameless inviter, a different sentence from the "Någon" fallback everywhere else — now
the same word, same sentence shape either way.

Screenshots (project store, `media/`): `fornamn-fragas-vid-forsta-inloggning.png`,
`kontoskarm-fornamn-satt.png`, `ditt-rum-mobil.png`, `inbjudan-fran-jacob-desktop.png`,
`inbjudan-fran-jacob-mobil.png`, `kontoskarm-inget-namn-satt.png`,
`delat-rum-namnger-medlem-utan-namn.png`, `delat-rum-namnger-medlem-utan-namn-mobil.png`.

Migration renumbered three times while this was in flight (0018 → 0020 → 0021 → 0022) as
sibling branches kept landing on `main` in the same range; re-checked against `main`
immediately before marking the PR ready rather than trusting the number picked at the
start. Not yet
reconciled with PR #22, which independently built its own `apps/web/src/screens/Konto.tsx`
and `apps/web/src/api/account.ts` — real overlap for whoever merges second, flagged rather
than resolved here since merges are the deploy agent's call.

**Reconciled on merge.** One screen at `/konto` now carries the name field, export and
deletion; `account.ts` is the union of both sides; this branch's separate `Account.tsx` is
gone. The two PRs also disagreed on where the account link lives — #22 put it in the rail,
this branch at the personal-room footer, explicitly off the rail. **The rail won**, because
it was already deployed and verified in a browser. Worth recording that the footer is the
convention `Konto.tsx` itself documents for secondary destinations, and #22's own comment
concedes the rail is tight at 320px, so the footer variant is the one to revisit if anyone
wants to — it is a one-line change and `Account.test.tsx` says so.
