# Photographic — architecture

A person-first memory layer for AI. One permanent personal room per person, unlimited
shared rooms, read by whichever model the person happens to be talking to.

## The problem this architecture is actually solving

Not "store memories and search them". That part is commodity — Mem0, Supermemory, Zep
and a dozen others do it well.

The hard problem is **delivery at session start**. A person opens any connected model
and expects it to already know who they are. That is push, not pull, and MCP is built
for pull: the model decides whether to call `recall()`, and a model that remembers you
two times out of three is worse than one that never claimed to.

So the core primitive is not search. It is:

```
context_bundle(actor, activeRoom?, budgetTokens) -> deterministic, cached, versioned text
```

Everything else — items, documents, chunks, retrieval — exists to feed it.

### What the bundle contains, and why not more

Two parts, at two depths, because "know everything immediately" does not fit in a
context window and "search when you need it" does not happen:

- **The personal room, whole.** Identity, facts, preferences and standing instructions,
  under a hard ceiling, never searched.
- **Every other room, one line each.** Its name, whether other people write in it, and
  a headline saying what it is *for* — not what it contains.

The second part is the one that is easy to leave out and expensive to. A model that was
never told a room exists does not go looking for it: it answers from the profile, sounds
certain, and is wrong about work that lives somewhere it never saw. Room names are cheap.

The headline is therefore its own projection rather than the first line of a brief. A
brief is what a room contains, which changes daily; a headline is what a room is, which
rarely changes and is what a model needs in order to decide whether to spend a tool call
opening it. The owner's own description wins and is never regenerated; otherwise it is
summarised in the same job that rebuilds the brief, because session start is a voice turn
and cannot wait on the model.

Under budget pressure, things give way in the order of what losing them costs: headlines
first, then the active room's brief, then profile items by salience. The rules and the
list of room names never give way — a model missing a rule acts against the person's
standing wishes, and a model missing a room does not know there is anything to ask about.

## Delivery channels, ranked by determinism

| # | Mechanism | Determinism | Available in |
|---|---|---|---|
| 1 | Our own client owns the system prompt | Guaranteed | `apps/voice`, `apps/web` |
| 2 | `SessionStart` hook injecting `additionalContext` | Deterministic | Claude Code, Codex |
| 3 | MCP `instructions` in `InitializeResult`, personalised via the OAuth subject | Partial — several clients currently drop it for HTTP transport | Claude, Cursor |
| 4 | Nudge appended to every tool response | Best effort | Everywhere |
| 5 | Person pastes the rendered profile into the vendor's own memory | Manual | ChatGPT incl. voice |

We cannot force channel 3 to work everywhere, so we **measure** it: `client_session`
records whether the profile was delivered and how, and the web app shows a green or red
light per client. Transparency is the only honest promise available, and it turns the
weakness into the reason to trust the product.

Note the asymmetry that shapes the roadmap: Claude supports custom remote MCP
connectors on Free/Pro/Max and they work on mobile, while ChatGPT's MCP support is web
only and its voice mode reportedly cannot call connectors at all. That is why the
guaranteed surface has to be our own voice client, with MCP as the reach surface.

## Shape

```
apps/voice ─┐
apps/web   ─┤
apps/mcp   ─┼──► apps/rest (HTTP + OAuth 2.1) ──► packages/* ──► Postgres + pgvector
agent-plugin┘
```

One deployable. A modular monolith with hard internal boundaries, not microservices.
At tens of thousands of users the bottleneck is never throughput — 50k people with 200
facts each is 10M rows, which is nothing. The bottleneck is data-model mistakes you
cannot migrate out of, and operational complexity you cannot staff.

All vendor-specific code is quarantined in `apps/mcp`, `apps/voice` and the plugin
package. **MCP is an adapter, never the core.** If MCP disappears we replace a
directory, not the data model.

## The three things that cannot be fixed later

**Identity.** `person` is the root object. There is no tenant table and never will be.
External providers attach as `credential` rows; the person id is never an external
subject. This also gives us a stable shard key if we ever need one.

**Permission resolution.** One function, `app.accessible_room_ids(person_id)`, used by
every read path, with row-level security underneath as a second line of defence. Two
places deciding access is how you leak.

**Provenance.** `app.event` is append-only and carries actor, client, session and
approval. It is the one thing that cannot be backfilled.

## Why an event log

`event` is the source of truth; `item`, `profile`, `brief` and embeddings are
projections. This is not full CQRS — it is one table and a rebuild step — but it buys
the optionality that makes the rest of the roadmap cheap:

- The profile format will change repeatedly. Replay instead of migrate.
- Changing embedding model becomes a background job.
- Adding a knowledge graph in year two becomes a projection, not a rewrite.

## Write policy

"Never let models fill my memory with wrong conclusions" and "let every model save
small facts automatically" cannot share one rule, so writes are tiered:

- **auto** — small, concrete, non-contradicting fact. Written immediately, visible in
  the feed, one click to undo.
- **needs_approval** — contradicts existing state, or is an `instruction`. Instructions
  always need approval because they change every model's behaviour at once. A wrong
  fact is annoying; a wrong instruction degrades every chat the person has.
- **duplicate** — already known. Bumps salience instead of adding a row. Necessary
  because ChatGPT and Claude will each independently try to save the same fact.

## Why the personal profile has a hard ceiling

It is injected whole, every session, never retrieved by search — because a model that
forgets your allergy one time in three is worse than one that never knew it.

That forces a ceiling (`PROFILE_TOKEN_BUDGET`), which forces an eviction policy, which
is the actual hard engineering problem in this category. Append-only personal memory is
magical for three months and unusable after eighteen. Dedupe on write, supersede on
change, demote by salience.

## Conversational CRUD needs handles

Every item carries a short speakable id (`p-7k2m`) which is rendered into the bundle, so
a model can call `forget('p-7k2m')` instead of matching free text. Deletion is always
soft and always undoable. A model deleting the wrong memory loses the user.

## Scale path

- **to ~50k people** — one Postgres instance, vertical scale, do nothing else.
- **50k–500k** — read replicas; partition `chunk` by hash of `room_id`; brief building
  on dedicated workers.
- **beyond** — shard person-scoped data by `person_id` and room-scoped data by
  `room_id`, joined through `membership`. Keys are already laid out for this.

Postgres is also the job queue. No Redis, no Kafka, no separate vector database, no
graph database, no Kubernetes.

## Deliberately not built

Knowledge graph. Automatic extraction without approval. Gmail/Drive connectors. Mobile
app. Realtime collaborative editing. Self-hosting. SSO and SOC 2. End-to-end
encryption — it is genuinely incompatible with server-side briefs and embeddings, so
rooms carry a `sensitivity` column from day one and the decision stays open.
