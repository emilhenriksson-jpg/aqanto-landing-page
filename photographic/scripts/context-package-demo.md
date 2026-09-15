# The session-start context package — before/after

What a fresh AI session receives in `instructions` at MCP `initialize` (and in
`get_context` / `GET /v1/context`, which render the same `ContextBundle` through the
same `renderInstructions`): personal core context, the relevant core memories, the room
overview, and now an extremely short **"recent"** — the four pieces `scope-permanent-memory.md`
§8 ("spara allt, skicka lite") asks for. Everything else stays behind a tool call.

This is the proof that it actually reaches the model, not just that the code compiles.

## Reproduce

```bash
cd photographic
export DATABASE_URL=postgres://photographic:photographic@127.0.0.1:5432/photographic
pnpm db:reset && pnpm db:seed
npx tsx scripts/context-package-demo.mjs
```

(`scripts/context-package-demo.mjs` builds Emil's real `ContextBundle` against Postgres
and renders it twice — once with `recent` zeroed out, once as it actually comes back —
so the diff below is the literal effect of this change, not a description of it.)

## Before (profile + room overview — what every session already got)

```
Du är kopplad till Photographic, personens egna minne. Det här är vad du vet om
personen redan innan de skrivit något. Använd det utan att påpeka att du har det.

---

Om personen
- Emil, 34, bor i Stockholm (p-k4hn)

Fakta
- Allergisk mot ketchup (p-45x7)

Så vill personen att du arbetar — följ detta
- Utmana alltid mina idéer, var inte för positiv (p-jnn4)

---

Personens rum. Det personliga rummet står i sin helhet
ovan; av de övriga har du bara raden nedan. Hänger svaret på vad som finns i ett rum,
anropa get_context med rummets namn först. Säg namnen exakt som de står.
<room-content room="rumslista">
- Emil (personligt): profilen ovan är det här rummet
- Buyersclub Ledning (bara du): Beslut och riktning för Buyersclub-förvärvet
</room-content>

---
[rules — unchanged, omitted here]
```

487 estimated tokens.

## After (+ "recent")

Same text, with one new block inserted between the room overview and the rules:

```
Det senaste som hände, utan att du behöver fråga (bara några rader — list_history ger mer):
<room-content room="senaste">
- 2026-09-15: sparade — Buyersclub Ledning: Vi beslutade att skjuta förvärvet till Q3
- 2026-09-15: skapade rummet — Buyersclub Ledning
- 2026-09-15: sparade — Emil: Utmana alltid mina idéer, var inte för positiv
- 2026-09-15: sparade — Emil: Allergisk mot ketchup
</room-content>
```

600 estimated tokens — 113 more for four lines a model no longer has to ask for, and
well inside the 1400-token instructions budget (see "Budget" below).

## What this confirms

- **The seeded fact arrives, twice, through two independent paths.** "Allergisk mot
  ketchup" is in `Fakta` (the personal core context, as it already was) *and* in
  "recent" (`sparade — Emil: Allergisk mot ketchup`) — the same proof point
  `WAKEUP.md` already records for the profile alone ("en `initialize` vars instructions
  bär Emils seedade ketchup-allergi"), now extended to the new block.
- **Room isolation holds.** `bundle.recent` only ever contains rooms `accessibleRoomIds`
  already allows (`e2e/src/journey.test.ts`: `"keeps 'recent' as isolated as everything
  else — never Emil's private room"`), because it reads through the same `HistoryPort`
  the room overview and search already trust — no second permission check to get wrong.
- **A deleted or merely-proposed memory's text never resurfaces here.** Deleting
  something, or proposing an instruction that is still waiting in the Godkänn-kön, shows
  up as an action and a room, never as the body — see
  `packages/agent/src/instructions.test.ts` ("never repeats the content of something
  that was just deleted" / "...a proposal still waiting in the Godkänn-kön").

## The budget

| Block | Budget | What gives way when it's exceeded |
|---|---|---|
| Profile (personal core context + core memories) | `PROFILE_TOKEN_BUDGET` = 1500 tokens at the projection, squeezed further by `renderInstructions` if needed | Lowest-salience sections drop first, down to a floor of one item — see `RETENTION_ORDER` |
| Room overview | `ROOM_LIST_TOKEN_BUDGET` = 220 tokens | Headlines drop before room names; room names themselves only ever get an overflow line, never disappear |
| **Recent** | `RECENT_TOKEN_BUDGET` = 150 tokens, `RECENT_ACTIVITY_LIMIT` = 4 entries fetched | The whole block, dropped entirely rather than shortened line by line — see below |
| Rules (confirmation style, data boundary, language) | fixed, ~250 tokens | Never dropped |
| **Total** | `INSTRUCTIONS_TOKEN_BUDGET` = 1400 tokens | — |

"Recent" is deliberately the first thing sacrificed, ahead of room headlines and the
active room's brief: it is spent purely out of whatever slack remains once the rest of
the package already fits on its own, and if there is no slack it disappears whole. A
"recent" that mentions two of the last four things that happened, with no way to tell
that two are missing, is worse than no "recent" at all — the same reasoning
`packages/agent/src/instructions.ts` already applies to the room list ("says how many
rooms it left out rather than silently shortening the list"), pushed one step further:
here there isn't even a count of what's missing, so the honest move is to say nothing.

See `packages/agent/src/instructions.test.ts` → `describe('the "recent" block', ...)`
for the behaviour asserted in code, and `packages/core/src/recent.ts` for where the read
comes from and why it sits behind a seam rather than calling `HistoryPort` directly at
each bundle site.
