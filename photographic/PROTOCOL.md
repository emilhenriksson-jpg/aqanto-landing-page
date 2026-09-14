# How an AI connects, and why

The question is whether MCP is the right way in. Short answer: yes as the backbone, no
as the only way, and the gap between those two is where most of the felt quality of the
product lives.

## What MCP is actually good at

Nothing else available is both bidirectional and per-user authenticated. That
combination is the whole requirement:

- **Two-way.** A read-only feed would make Photographic a nicer profile page. The
  product only works if a model can also save — "lägg det i Buyersclub Ledning" has to
  work from inside the conversation, not from a separate app.
- **Per-person identity.** OAuth at connect time means the same endpoint serves
  everyone, permissions resolve per request, and revoking access is revoking a token.
- **Vendor-neutral.** Claude, ChatGPT connectors, Cursor, VS Code and Codex all speak
  it. Betting on one vendor's plugin format would mean rebuilding for the next one.
- **It carries instructions.** `InitializeResult.instructions` puts our text in
  system-prompt position before the person types. That is the closest thing to a
  guarantee of "full context immediately" that exists in a protocol.

So MCP stays the core. The tool surface in `packages/agent` is defined once and every
other channel is a rendering of it.

## Where MCP alone is not enough

Three gaps, and they are not small.

**It needs setting up.** Cursor and VS Code are one click, Claude Code is one command,
and then it drops off a cliff: Claude needs a connector added from web or desktop,
ChatGPT needs Developer mode. That is fine for the first few thousand users and it is
not fine as the only door.

**Instructions are advisory.** Some clients drop the `instructions` string. When that
happens, context only arrives if the model chooses to call `get_context` — which is
usually does, and "usually" is not the promise we want to make. This is why every
session records how the profile arrived and the client health screen shows it honestly
rather than claiming universal support.

**It is simply absent in places people use.** ChatGPT's voice mode cannot call
connectors. Mobile apps are partial. A person talking to their phone in the car is
exactly the case the product is for, and MCP does not reach it.

## The other surfaces, ranked by friction

These are additive. None of them replaces MCP; each closes one of the gaps above.

### Email and SMS in — zero install

Every person gets an address like `emil@in.photographic.me`. Forward a PDF, send a
voice note, text a thought. It lands in the right room and becomes a proposal to
approve.

This has the lowest friction of anything in the product, because the person already has
the app open — it is their mail client. It handles capture, not injection, and it is the
only channel that works for someone who has installed nothing at all. It should exist
before any of the cleverer ideas.

### Browser extension — the only real injection into consumer chat

This is what the competition actually does. Supermemory injects retrieved memories into
the ChatGPT and Claude composer before the message is sent, with a manual button and an
optional auto-search on typing. Mem0's OpenMemory extension did the same across ChatGPT,
Claude, Perplexity, Grok and Gemini, though that repository is now archived.

It is the only way to get context into ChatGPT web without Developer mode, and the only
way to reach Gemini and Grok at all. It also gives us capture from those surfaces.

The honest cost: it depends on other people's DOM. Selectors break on redesign, and a
silently broken extension is worse than no extension because the person believes they
are covered. So it reports delivery the same way every other channel does, and when it
cannot find the composer it says so rather than failing quietly.

Worth building, second after email. Not worth pretending it is robust.

### Share sheet and shortcut — one tap from anywhere

An iOS/Android share target and a Shortcut. Highlight text anywhere, share to
Photographic, pick a room. Cheap to build on top of the same API, and it covers the
"I saw something and want to keep it" case that email handles clumsily on a phone.

### Paste the profile — the floor

A copy button that puts the rendered profile on the clipboard, for Custom Instructions
or a Claude Project. Static, goes stale, requires the person to redo it. It exists
because it works absolutely everywhere, including ChatGPT voice mode, and because a
product that says "sorry, not supported" has lost that person.

## What we deliberately do not build

- **Our own chat.** The premise is that the person keeps using ChatGPT, Claude or
  whatever comes next. A Photographic chat would compete with the thing it is supposed
  to serve, and every hour spent on it is an hour not spent on the integration surface
  that is the actual product.
- **A proprietary SDK as the primary interface.** An SDK is a convenience over an HTTP
  API, never the contract. The contract is the API and MCP.
- **Per-client hacks beyond the two that matter.** Chasing every new chat UI with
  bespoke DOM injection is an unbounded maintenance commitment. Two surfaces, plus MCP,
  plus a documented API.

## Decision table

| Channel | Read | Write | Injection guarantee | Install cost |
|---|---|---|---|---|
| MCP | yes | yes | instructions, where honoured | one click to a few steps |
| Email / SMS in | no | yes | n/a | none |
| Browser extension | yes | yes | reliable while selectors hold | one click |
| Share sheet | no | yes | n/a | app install |
| Paste profile | yes | no | total, until it goes stale | none |
| HTTP API | yes | yes | caller's problem | for developers |

---

# Functionality worth having, and what the competition already learned

The brief was not to build for the sake of building. So: what the category has
converged on, what it gets wrong, and what is worth taking.

## Taken, because it works

**One-click import of existing memories.** Both Supermemory and Mem0 let a person pull
in their existing ChatGPT saved memories, and it is the single best answer to the cold
start problem. An empty memory layer has no value on day one, which is exactly when the
person decides whether to keep it. Importing forty facts they already accumulated turns
the first session from a chore into a payoff.

Ours differs in one way that matters: imported facts arrive as proposals, in bulk, with
an approve-all button. Silently absorbing someone else's extracted memories is how you
inherit their mistakes.

**Automatic capture with a visible record.** The competition captures prompts
automatically. That is right — asking permission for every fact is the thing that makes
people stop using memory tools. But it is only acceptable with the other half, which
most of them treat as a settings page: a history of everything that was saved without
asking, attributed to the model that did it, reversible in one line.

**Retrieval on typing rather than on request.** Debounced search as the person types,
so context is present before they finish the sentence. Worth copying for the extension.

## Taken, because nobody does it well

**"How do you know that about me?"** The common complaint about AI memory is not that it
forgets, it is that it knows something unaccountable and there is no way to ask why. Any
connected model can answer this for us, from `list_history` with an id: which model
saved it, when, from which room, whether it was approved. It costs almost nothing and it
is the difference between a memory people trust and one they tolerate.

**A trash with a deadline.** Competitors delete on request. A model deleting the wrong
memory is the failure that ends the relationship, and 30 recoverable days is what lets
the model act on "glöm det" without asking twice. The friction removed at the point of
deletion is paid for here.

**Honest per-client delivery reporting.** Everyone in this category claims to work
everywhere. None of them tells you that ChatGPT voice mode cannot reach a connector. A
green light per client, and an amber one when context arrived only because the model
happened to ask, is more convincing than a longer list of logos.

## Left alone

- **Memory graph visualisations.** They demo beautifully and nobody opens them twice.
- **Automatic extraction without approval for instructions.** Several tools infer
  behavioural rules from conversation. That is how a memory layer starts quietly
  degrading every chat a person has.
- **Team and organisation tiers.** The person is the root object. Rooms already do what
  a team needs, and adding a tenant above the person would undo the one structural
  decision this product is built on.
- **Scoring or ranking people's memories for them.** Salience is internal, for packing
  the profile into its budget. Showing it invites argument about a number that does not
  mean anything to the person.
