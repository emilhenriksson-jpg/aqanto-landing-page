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
  ['POST', '/memory/proposals', SCOPE_MEMORY_WRITE],
  ['POST', '/memory/proposals/:id', SCOPE_MEMORY_WRITE],
  ['PATCH', '/memory/:shortId', SCOPE_MEMORY_WRITE],
  ['DELETE', '/memory/:shortId', SCOPE_MEMORY_WRITE],
  ['POST', '/memory/undo', SCOPE_MEMORY_WRITE],
  ['POST', '/trash/:shortId/restore', SCOPE_MEMORY_WRITE],

  // Sharing and moving change which room a memory lives in, which changes who can read
  // it. That is a write, and the one with the widest consequences on this list — a
  // read-only connection must not be able to move a private memory into a shared room.
  ['POST', '/memory/:shortId/share', SCOPE_MEMORY_WRITE],
  ['POST', '/memory/:shortId/move', SCOPE_MEMORY_WRITE],

  // Settling a disagreement supersedes one of the two statements, so it edits memory.
  ['POST', '/memory/disputes/resolve', SCOPE_MEMORY_WRITE],

  // Emptying the trash early, ahead of the thirty days. The only route here that
  // destroys something unrecoverably, so it carries the write scope like any other
  // mutation — the extra protection it needs is a confirmation in the UI, not a scope
  // nothing else uses.
  ['DELETE', '/trash/:shortId', SCOPE_MEMORY_WRITE],

  // -------------------------------------------------------------------------
  // Documents
  // -------------------------------------------------------------------------

  // Uploading is a write to memory, and a document is memory from the start. A
  // read-only connection cannot put a PDF in someone's room.
  ['POST', '/documents', SCOPE_MEMORY_WRITE],
  ['POST', '/rooms/:roomId/documents', SCOPE_MEMORY_WRITE],

  ['GET', '/documents/:documentId', SCOPE_MEMORY_READ],
  ['GET', '/documents/:documentId/chunks', SCOPE_MEMORY_READ],

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
 * Routes only the person's own browser session may call.
 *
 * Same list-in-one-place reasoning as above, for the opposite rule: these are guarded by
 * *who* is calling rather than by what their token may do.
 */
export const FIRST_PARTY_ONLY_ROUTES: readonly ScopedRoute[] = [
  ['PATCH', '/clients/:clientId'],
  ['DELETE', '/clients/:clientId'],

  /**
   * Export and deletion.
   *
   * No scope is the right key for the same reason it is for client management, only
   * more so. A scope that let a client export the person's entire memory would be held
   * by every client holding it — so connecting one read-only AI would hand a full copy
   * of twelve years to whatever else was connected. And "an AI deleted my account" is
   * not a sentence this product can ever produce.
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
] as const;
