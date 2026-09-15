/**
 * Lifecycle transitions to the trash and back, for a memory and for a document.
 *
 * These live here rather than as private methods on `PgIngest` because there are two
 * callers that must not have two implementations. `PgIngest.forget` is one. The other is
 * account deletion's "ta bort mina bidrag", which used to be a bulk
 * `UPDATE app.item SET status = 'deleted'` with no event, no undo token, no transaction
 * and no projection invalidation — while its own comment and its own test claimed it went
 * "through the ordinary trash". It did not, and `app.trash` is derived from the *log*, so
 * the material it removed was invisible in the trash and unrestorable by anyone. A
 * function both paths call is what makes "one way for a memory to leave the current state"
 * a property rather than a comment.
 *
 * Two rules hold for everything in this file.
 *
 * **One transaction per transition.** The status change, the event append and the durable
 * projection bookkeeping commit together or not at all. Anything less and a process death
 * between two statements leaves `app.item` saying one thing and the log saying another —
 * and since the trash reads the log, a deleted memory can vanish from the trash with no
 * route back. The log being the truth is the product's founding promise; it cannot be
 * true only when nothing goes wrong.
 *
 * **Both directions are idempotent.** Every transition is conditional in SQL on the state
 * it expects, and appends its event only if the condition matched. So a retry after a
 * timeout that actually committed is a no-op rather than a second `item.restored` in the
 * calendar, and `undo` cannot run twice.
 */

import { randomBytes } from 'node:crypto';

import type { Actor, Item, PersonId, RoomId, RoomKind } from '@photographic/core';
import { deriveMotivation, purgeDeadline } from '@photographic/core';

import { queryOne, type Db } from '../pool.js';
import { ITEM_COLUMNS, mapItem, type ItemRow } from '../rows.js';
import { appendEvent } from './events.js';
import { enqueueJob } from './jobs.js';
import { invalidateProjections } from './projection.js';

/**
 * Marks a room's derived state stale, in the caller's transaction.
 *
 * The same two writes plus the same rebuild job `PgIngest.markStale` does through the
 * ports, expressed as SQL so it can join a unit of work. The port version additionally
 * pokes `PgProjection`'s in-process headline cache, which is process state and cannot be
 * transactional; callers here do that after the commit.
 */
export async function markStaleWithin(db: Db, roomId: RoomId): Promise<void> {
  const room = await queryOne<{ kind: RoomKind; created_by: string }>(
    db,
    `SELECT kind, created_by FROM app.room WHERE id = $1`,
    [roomId],
  );
  const personId = room?.kind === 'personal' ? (room.created_by as PersonId) : undefined;

  await invalidateProjections(db, { roomId, ...(personId ? { personId } : {}) });
  await enqueueJob(db, {
    kind: 'rebuild_projections',
    payload: { roomId, personId: personId ?? null },
    dedupeKey: `rebuild:${roomId}`,
  });
}

export interface SoftDeleteResult {
  item: Item;
  undoToken: string;
  /** False when the memory was already in the trash, so nothing was appended. */
  applied: boolean;
}

/**
 * Moves one memory to the trash, inside the caller's transaction.
 *
 * `reason` is the person's own phrasing and is what makes the trash readable a week
 * later. `actor` is who did it, and for account deletion that is deliberately the
 * departing person rather than a system identity: the other members of a shared room are
 * entitled to see whose contributions left and why, and the tombstone that replaces the
 * person row happens afterwards, so the attribution is still there to record.
 */
export async function softDeleteWithin(
  db: Db,
  input: { actor: Actor; item: Item; reason?: string; now: Date },
): Promise<SoftDeleteResult> {
  const { actor, item, now } = input;
  const undoToken = randomBytes(16).toString('base64url');
  const purgeAfter = purgeDeadline(now);
  const reason = input.reason?.trim() || null;

  // Conditional on the state this transition expects. A second soft delete of something
  // already in the trash would otherwise mint a new undo token, move the purge deadline
  // and write a second `item.deleted` — three ways for the log and the trash to disagree
  // about one memory.
  const updated = await db.query(
    `UPDATE app.item
     SET status = 'deleted', deleted_at = $1, deleted_by = $2, deleted_by_client = $3,
         purge_after = $4, delete_reason = $5, undo_token = $6
     WHERE id = $7 AND status <> 'deleted'`,
    [now, actor.personId, actor.agentClient, purgeAfter, reason, undoToken, item.id],
  );

  if (!updated.rowCount) {
    return { item, undoToken, applied: false };
  }

  const room = await roomOf(db, item.roomId);

  await appendEvent(db, {
    roomId: item.roomId,
    eventType: 'item.deleted',
    payload: { item_id: item.id, short_id: item.shortId, body: item.body },
    actorPersonId: actor.personId,
    agentClient: actor.agentClient,
    clientId: actor.clientId ?? null,
    sessionRef: actor.sessionId,
    explicit: true,
    motivation:
      reason ||
      deriveMotivation({ kind: 'deleted', roomTitle: room.title, roomKind: room.kind }),
  });

  await markStaleWithin(db, item.roomId);

  return {
    item: {
      ...item,
      status: 'deleted',
      deletedAt: now,
      deletedBy: actor.personId,
      deletedByClient: actor.agentClient,
      purgeAfter,
      deleteReason: reason,
    },
    undoToken,
    applied: true,
  };
}

export interface RestoreResult {
  item: Item;
  /** False when the memory was not in the trash, so nothing was appended. */
  applied: boolean;
}

/**
 * Takes one memory back out of the trash, inside the caller's transaction.
 *
 * Conditional on `status = 'deleted'` in SQL rather than on the `Item` the caller is
 * holding, because that object was read earlier and two clicks on "ta tillbaka" arrive
 * with the same stale copy. Whichever loses appends nothing.
 */
export async function restoreWithin(
  db: Db,
  input: { actor: Actor; item: Item },
): Promise<RestoreResult> {
  const { actor, item } = input;

  const updated = await db.query(
    `UPDATE app.item
     SET status = 'active', deleted_at = NULL, deleted_by = NULL, deleted_by_client = NULL,
         purge_after = NULL, delete_reason = NULL, undo_token = NULL
     WHERE id = $1 AND status = 'deleted'`,
    [item.id],
  );

  // Somebody else got there first. Report what the row actually says now rather than the
  // copy the caller was holding, which is the thing that was already out of date.
  if (!updated.rowCount) return { item: (await reread(db, item)) ?? item, applied: false };

  const room = await roomOf(db, item.roomId);

  await appendEvent(db, {
    roomId: item.roomId,
    eventType: 'item.restored',
    payload: { item_id: item.id, short_id: item.shortId, body: item.body },
    actorPersonId: actor.personId,
    agentClient: actor.agentClient,
    clientId: actor.clientId ?? null,
    sessionRef: actor.sessionId,
    explicit: true,
    motivation: deriveMotivation({
      kind: 'restored',
      roomTitle: room.title,
      roomKind: room.kind,
    }),
  });

  await markStaleWithin(db, item.roomId);

  return {
    item: {
      ...item,
      status: 'active',
      deletedAt: null,
      deletedBy: null,
      deletedByClient: null,
      purgeAfter: null,
      deleteReason: null,
    },
    applied: true,
  };
}

async function reread(db: Db, item: Item): Promise<Item | null> {
  const row = await queryOne<ItemRow>(db, `SELECT ${ITEM_COLUMNS} FROM app.item WHERE id = $1`, [
    item.id,
  ]);
  return row ? mapItem(row) : null;
}

// ---------------------------------------------------------------------------
// The same two transitions, for a document
// ---------------------------------------------------------------------------

/**
 * A document's trash is the same promise as a memory's, so it is the same code shape.
 *
 * `PgDocuments.remove` and `.restore` arrived while the item lifecycle was still being made
 * transactional, so they were written the way `softDelete` used to be: `UPDATE app.document`
 * and then `appendEvent` as a separate statement. That is the failure the item path just
 * stopped having — a process death in between leaves the file gone from its room with
 * nothing in the log saying so, and the other members of a shared room see a document
 * disappear with no trace, which is precisely what appending the event was for.
 *
 * These are separate functions rather than one generic helper over both tables. The two
 * differ in more than a table name — a document has no undo token, no short id and a
 * storage charge that must outlive the delete so a restore cannot fail at the limit — and a
 * helper parameterised over those differences would be harder to read than two functions
 * that state them.
 */
export interface DocumentTransition {
  applied: boolean;
  roomId: RoomId;
  filename: string;
  purgeAfter: Date | null;
}

export async function trashDocumentWithin(
  db: Db,
  input: {
    actor: Actor;
    documentId: string;
    roomId: RoomId;
    filename: string;
    retentionDays: number;
    reason?: string;
  },
): Promise<DocumentTransition> {
  const { actor, documentId, roomId, filename } = input;

  const updated = await queryOne<{ purge_after: Date | null }>(
    db,
    `UPDATE app.document
     SET deleted_at = now(), deleted_by = $2, deleted_by_client = $3,
         purge_after = now() + ($4 || ' days')::interval
     WHERE id = $1 AND deleted_at IS NULL
     RETURNING purge_after`,
    [documentId, actor.personId, actor.agentClient, input.retentionDays],
  );

  if (!updated) return { applied: false, roomId, filename, purgeAfter: null };

  await appendEvent(db, {
    roomId,
    eventType: 'document.deleted',
    payload: {
      document_id: documentId,
      filename,
      purge_after: updated.purge_after?.toISOString() ?? null,
      ...(input.reason?.trim() ? { reason: input.reason.trim() } : {}),
    },
    actorPersonId: actor.personId,
    agentClient: actor.agentClient,
    clientId: actor.clientId ?? null,
    sessionRef: actor.sessionId,
    explicit: true,
    motivation:
      input.reason?.trim() ||
      `Dokumentet ligger i papperskorgen i ${input.retentionDays} dagar och går att ta tillbaka.`,
  });

  await markStaleWithin(db, roomId);

  return { applied: true, roomId, filename, purgeAfter: updated.purge_after };
}

export async function restoreDocumentWithin(
  db: Db,
  input: { actor: Actor; documentId: string; roomId: RoomId; filename: string },
): Promise<DocumentTransition> {
  const { actor, documentId, roomId, filename } = input;

  // Conditional on being in the trash, so two clicks on "ta tillbaka" append one
  // `document.restored` between them — the same reason `restoreWithin` is conditional.
  const updated = await db.query(
    `UPDATE app.document
     SET deleted_at = NULL, deleted_by = NULL, deleted_by_client = NULL, purge_after = NULL
     WHERE id = $1 AND deleted_at IS NOT NULL`,
    [documentId],
  );

  if (!updated.rowCount) return { applied: false, roomId, filename, purgeAfter: null };

  await appendEvent(db, {
    roomId,
    eventType: 'document.restored',
    payload: { document_id: documentId, filename },
    actorPersonId: actor.personId,
    agentClient: actor.agentClient,
    clientId: actor.clientId ?? null,
    sessionRef: actor.sessionId,
    explicit: true,
    motivation: 'Dokumentet är tillbaka i rummet.',
  });

  await markStaleWithin(db, roomId);

  return { applied: true, roomId, filename, purgeAfter: null };
}

/** Only the two fields the motivation needs, so this stays one cheap read. */
async function roomOf(db: Db, roomId: RoomId): Promise<{ title: string; kind: RoomKind }> {
  const row = await queryOne<{ title: string; kind: RoomKind }>(
    db,
    `SELECT title, kind FROM app.room WHERE id = $1`,
    [roomId],
  );
  return row ?? { title: '', kind: 'personal' };
}