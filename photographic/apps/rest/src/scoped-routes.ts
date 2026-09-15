/**
 * Which OAuth scope every authenticated route requires.
 *
 * Scopes were validated when a token was issued and then never checked again, so they
 * described what a client had asked for rather than limiting what it could do: a
 * "read-only" connection was read-only only because nothing tried to write. This table
 * is what makes them real.
 *
 * It is a table rather than a check inside each handler for one reason. The useful
 * question is not "is this route covered" — you can answer that by reading the handler —
 * it is "is any route *not* covered", and that is only answerable when every answer sits
 * in one place someone can read top to bottom. `scope.test.ts` asserts that every
 * authenticated route appears here, so adding a route without a scope fails a test
 * rather than shipping an unguarded endpoint.
 *
 * Paths are as mounted under `/v1`, so they omit the prefix.
 */

import {
  SCOPE_MEMORY_READ,
  SCOPE_MEMORY_WRITE,
  SCOPE_PROFILE_READ,
  SCOPE_ROOMS_READ,
} from '@photographic/auth';

/** `[method, path, ...requiredScopes]`. */
export type ScopedRoute = readonly [string, string, ...string[]];

export const SCOPED_ROUTES: readonly ScopedRoute[] = [
  // -------------------------------------------------------------------------
  // Reading the person
  // -------------------------------------------------------------------------

  // The session-start bundle. `profile.read` rather than `memory.read`: this is the
  // always-injected personal context, which is the one read a client cannot avoid
  // making, and a client may legitimately be trusted with it and nothing else.
  ['GET', '/context', SCOPE_PROFILE_READ],
  ['GET', '/profile', SCOPE_PROFILE_READ],

  // The person's own first name, or that there isn't one — about the account rather
  // than its contents, so the weakest read scope every client already has is the right
  // bar. *Setting* it is a different question and lives in `FIRST_PARTY_ONLY_ROUTES`.
  ['GET', '/account', SCOPE_PROFILE_READ],

  // -------------------------------------------------------------------------
  // Reading memory
  // -------------------------------------------------------------------------

  ['GET', '/search', SCOPE_MEMORY_READ],
  ['GET', '/memory/proposals', SCOPE_MEMORY_READ],
  ['GET', '/trash', SCOPE_MEMORY_READ],
  ['GET', '/history', SCOPE_MEMORY_READ],
  ['GET', '/history/:shortId', SCOPE_MEMORY_READ],
  // "How do you know that about me?" — a read of the log behind one memory.
  ['GET', '/memory/:shortId/provenance', SCOPE_MEMORY_READ],

  // Both sides of every unresolved disagreement. A read of memory content, and of the
  // most sensitive kind: two statements that cannot both be true.
  ['GET', '/memory/disputes', SCOPE_MEMORY_READ],

  // -------------------------------------------------------------------------
  // The calendar
  // -------------------------------------------------------------------------

  // The calendar is a view over the event log, and the log carries memory bodies. So
  // this is `memory.read` and not a weaker scope of its own: a client that cannot read
  // memories must not be able to read them a day at a time instead.
  ['GET', '/calendar/day', SCOPE_MEMORY_READ],
  ['GET', '/calendar/events/:seq', SCOPE_MEMORY_READ],

  // -------------------------------------------------------------------------
  // Rooms
  // -------------------------------------------------------------------------

  ['GET', '/rooms', SCOPE_ROOMS_READ],
  ['GET', '/rooms/:roomId', SCOPE_ROOMS_READ],
  ['GET', '/rooms/:roomId/items', SCOPE_ROOMS_READ, SCOPE_MEMORY_READ],
  ['GET', '/rooms/:roomId/documents', SCOPE_ROOMS_READ, SCOPE_MEMORY_READ],

  // Creating a room is a write to the person's memory structure, not a read of it.
  ['POST', '/rooms', SCOPE_MEMORY_WRITE],
  ['DELETE', '/rooms/:roomId', SCOPE_MEMORY_WRITE],
  ['PATCH', '/rooms/:roomId/description', SCOPE_MEMORY_WRITE],

  // Marking a room seen is bookkeeping about reading, so it rides with the read scope.
  // Requiring write here would make a read-only client unable to stop re-reporting the
  // same room as unread.
  ['POST', '/rooms/:roomId/seen', SCOPE_ROOMS_READ],

  // -------------------------------------------------------------------------
  // Writing memory
  // -------------------------------------------------------------------------

  ['POST', '/memory', SCOPE_MEMORY_WRITE],
  // Creating a proposal, not answering one. This is the queue's entrance and a model is
  // meant to use it; `POST /memory/proposals/:id` is the exit and is first-party only.
  ['POST', '/memory/proposals', SCOPE_MEMORY_WRITE],

  /**
   * Importing what another system remembers. Both were outside the scope model entirely.
   *
   * `scope.test.ts` exempted them as part of "the same first-run path" as sign-up, which was
   * false for both: `app.ts` puts `/v1/import` and `/v1/import/*` behind `authenticate`, and
   * the commit handler calls `ingest.propose` once per parsed candidate. So a token holding
   * exactly `DEFAULT_SCOPE` — the read-only connection a client gets when it asks for
   * nothing — was correctly refused on `POST /memory` and got a 201 here, with proposals
   * queued in somebody's Godkänn queue.
   *
   * Nothing was ever saved without approval, so the containment held. What a read-only
   * connection gained was the ability to fill the queue with text of its choosing, and this
   * file's own reasoning says why that matters: a queue people learn to clear without
   * reading is what makes every other safeguard here decorative.
   *
   * `preview` reads nothing and writes nothing, but it needs an actor and parses up to
   * 100 000 characters, so it carries the read scope rather than none.
   */
  ['POST', '/import', SCOPE_MEMORY_WRITE],
  ['POST', '/import/preview', SCOPE_MEMORY_READ],

  // Registering and polling a connect verification. Authenticated all along, and outside
  // the table for the same wrong reason as import. Both are about the caller's own session
  // rather than about memory, so the weakest scope every client holds is the right bar.
  ['POST', '/connect/verify', SCOPE_PROFILE_READ],
  ['POST', '/connect/status', SCOPE_PROFILE_READ],

  ['PATCH', '/memory/:shortId', SCOPE_MEMORY_WRITE],
  ['DELETE', '/memory/:shortId', SCOPE_MEMORY_WRITE],
  ['POST', '/memory/undo', SCOPE_MEMORY_WRITE],
  // `:handle` is a short id or a document uuid: one trash, so one route per verb.
  ['POST', '/trash/:handle/restore', SCOPE_MEMORY_WRITE],

  /**
   * Asking to share or move a memory. Both queue a proposal and neither can place anything.
   *
   * They stay on the scope side rather than joining `HUMAN_DECISION_ROUTES` on purpose: a
   * model asking "ska jag lägga det här i Buyersclub Ledning?" is the whole reason the
   * approval queue exists, and the queue is useless if automation cannot reach its
   * entrance. What moved is the *yes* — see `placementSchema`, which no longer accepts a
   * `confirmed` flag, so the answer is only ever given by the first-party route below.
   */
  ['POST', '/memory/:shortId/share', SCOPE_MEMORY_WRITE],
  ['POST', '/memory/:shortId/move', SCOPE_MEMORY_WRITE],

  // Emptying the trash early, ahead of the thirty days. The only route here that
  // destroys something unrecoverably, so it carries the write scope like any other
  // mutation — the extra protection it needs is a confirmation in the UI, not a scope
  // nothing else uses.
  ['DELETE', '/trash/:handle', SCOPE_MEMORY_WRITE],

  // -------------------------------------------------------------------------
  // Documents
  // -------------------------------------------------------------------------

  // Uploading is a write to memory, and a document is memory from the start. A
  // read-only connection cannot put a PDF in someone's room.
  ['POST', '/documents', SCOPE_MEMORY_WRITE],
  ['POST', '/rooms/:roomId/documents', SCOPE_MEMORY_WRITE],

  ['GET', '/documents/:documentId', SCOPE_MEMORY_READ],
  ['GET', '/documents/:documentId/chunks', SCOPE_MEMORY_READ],

  // Deleting a document is a write, and it goes to the trash rather than away — the same
  // rule memories follow, so a model that can write can also take something back out of a
  // room, and a person can undo it for thirty days.
  ['DELETE', '/documents/:documentId', SCOPE_MEMORY_WRITE],
  ['POST', '/documents/:documentId/restore', SCOPE_MEMORY_WRITE],

  // Kept as a narrower door onto the same trash: documents only, for a caller that wants
  // exactly that. `GET /trash` is the one a person's Papperskorg reads, and both derive from
  // the same lifecycle events, so they cannot disagree about what is recoverable.
  ['GET', '/documents/trash', SCOPE_MEMORY_READ],

  // The extraction and the original file. Same scope as any other read of the person's
  // memory: a document is not a second category of thing with its own permission.
  ['GET', '/documents/:documentId/text', SCOPE_MEMORY_READ],
  ['GET', '/documents/:documentId/file', SCOPE_MEMORY_READ],

  // How full the account is. About the account rather than its contents, so the weakest
  // read scope every client already has is the right bar — and a client that cannot see
  // this cannot tell a person why an upload was refused.
  ['GET', '/storage', SCOPE_PROFILE_READ],

  // -------------------------------------------------------------------------
  // Invites
  // -------------------------------------------------------------------------

  // Inviting someone is a disclosure decision about everything already in the room, so
  // it needs write and not merely room access.
  ['POST', '/rooms/:roomId/invites', SCOPE_MEMORY_WRITE],
  ['DELETE', '/invites/:inviteId', SCOPE_MEMORY_WRITE],

  // Who has been invited is part of knowing who can read the room, so it rides with
  // room access rather than with the write scope that sending an invite needs.
  ['GET', '/rooms/:roomId/invites', SCOPE_ROOMS_READ],

  // -------------------------------------------------------------------------
  // Membership
  // -------------------------------------------------------------------------

  // Leaving a room can take the author's own contributions with it, and removing
  // someone else changes who may read everything already written there. Both are
  // writes to the person's memory structure, like creating or deleting a room.
  ['POST', '/rooms/:roomId/leave', SCOPE_MEMORY_WRITE],
  ['DELETE', '/rooms/:roomId/members/:personId', SCOPE_MEMORY_WRITE],

  // -------------------------------------------------------------------------
  // Managing the connection itself
  // -------------------------------------------------------------------------

  // Listing connected clients is about the account rather than its contents, so the
  // weakest read scope every client has is the right bar.
  ['GET', '/clients', SCOPE_PROFILE_READ],

  /**
   * Renaming and disconnecting a client are deliberately *not* here.
   *
   * No OAuth scope should let one AI client rename or revoke another, which is exactly
   * what a scope-gated route would permit as soon as two clients hold the same scope.
   * These are first-party browser actions; `clientManagementOnly` restricts them to the
   * web session instead.
   */
] as const;

/**
 * The decisions only a person may make.
 *
 * A class rather than a handful of routes, because that is what went wrong: the rule was
 * applied to three of these and not to the other two, and each omission looked defensible on
 * its own. Answering a proposal, settling a dispute, exporting a memory and deleting an
 * account are the same kind of act — a judgement the product promises a human makes — and
 * the only thing they need in common is that no OAuth scope can reach them. A scope cannot,
 * by construction: whatever scope would authorise one of these is held by every client that
 * holds it, so the first thing a compromised or over-scoped token would do is exactly this.
 *
 * `scope.test.ts` enumerates this list against the live route table and against a
 * fully-scoped token, so a new decision route added to `SCOPED_ROUTES` instead of here fails
 * a test rather than shipping.
 */
export const HUMAN_DECISION_ROUTES: readonly ScopedRoute[] = [
  /**
   * Answering a proposal, which is the yes the whole write path funnels into.
   *
   * The Godkänn queue exists so that a *person* decides what enters their memory, and
   * this route is where that decision is recorded. It used to require `memory.write`,
   * which every connected client holds — so a client could answer the proposals it had
   * just created, and the queue was advisory rather than a gate. Verified against the
   * live deploy: a model's own access token approved its own `update_compass` proposal
   * and the item landed.
   *
   * It is now also the *only* way a memory reaches a room it was not written into.
   * `share` and `move` used to accept a `confirmed` boolean that placed immediately, so a
   * caller supplied its own claim that a human had agreed; that field is gone, and this
   * route is what replaced it.
   *
   * Costs nothing legitimate: the web app answers proposals with the person's session
   * token (`apps/web/src/api/client.ts`), which is what `firstPartyOnly` requires, and
   * no MCP tool exposes approval at all.
   */
  ['POST', '/memory/proposals/:id'],

  /**
   * Settling a dispute, which is the same decision wearing different clothes.
   *
   * `trust-and-permissions.md` 2.2 says a contradiction between two members is resolved
   * "aldrig av en modell, och aldrig av ett MCP-anrop", and there is deliberately no MCP
   * tool for it. But the route only required `memory.write`, so the absence of a tool was
   * the whole defence — and a token talking to the REST API directly does not need a tool.
   * Resolving supersedes one of two people's statements about the same thing, on behalf of
   * whoever wrote the losing one. That is not something a scope can be trusted with.
   */
  ['POST', '/memory/disputes/resolve'],

  /**
   * Export and deletion.
   *
   * A scope that let a client export the person's entire memory would be held by every
   * client holding it — so connecting one read-only AI would hand a full copy of twelve
   * years to whatever else was connected. And "an AI deleted my account" is not a sentence
   * this product can ever produce.
   *
   * `GET /export/download/:token` is deliberately absent: it is mounted outside the
   * authenticated group and carries its own signed credential, because the archive is
   * emailed and the browser opening it may never have had a session.
   */
  ['POST', '/export'],
  ['GET', '/export'],
  ['GET', '/export/:exportId'],
  ['POST', '/export/:exportId/link'],
  ['GET', '/account/deletion'],
  ['POST', '/account/deletion'],
  ['DELETE', '/account/deletion'],

  /**
   * Whether the background work is keeping up.
   *
   * Counts and kinds, no memory content and no error strings. First-party rather than
   * scoped because there is no client that has any business asking how deep our queue is,
   * and because the answer is about the deployment rather than about the person.
   */
  ['GET', '/ops/queue'],
] as const;

/**
 * Routes only the person's own browser session may call.
 *
 * Same list-in-one-place reasoning as `SCOPED_ROUTES`, for the opposite rule: these are
 * guarded by *who* is calling rather than by what their token may do.
 *
 * Two groups. Managing the AI clients themselves, where no scope should let one client
 * rename or disconnect another — the first thing a compromised AI would do is revoke the
 * others. And `HUMAN_DECISION_ROUTES`, for the reasons stated there.
 */
export const FIRST_PARTY_ONLY_ROUTES: readonly ScopedRoute[] = [
  ['PATCH', '/clients/:clientId'],
  ['DELETE', '/clients/:clientId'],

  /**
   * Setting the person's own first name. Same reasoning as renaming a client: no OAuth
   * scope should let a connected AI decide what a person is called, because a scope that
   * permitted it would be held by every client holding it. There is no MCP tool for this
   * on either side of the door.
   */
  ['PATCH', '/account/name'],

  ...HUMAN_DECISION_ROUTES,
] as const;
