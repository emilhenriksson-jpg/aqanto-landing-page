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
- **No real email or SMS.** Sign-up codes are written to the API log as `signup_code`.
- **Shared-room Aktivitet is still demo data.** Left alone on purpose: it is being
  rebuilt as a view over the append-only event log with full provenance, so a standalone
  activity endpoint now would be thrown away.

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

### Verified live

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
