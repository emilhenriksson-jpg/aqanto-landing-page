/**
 * Rebuilding what a memory is, from the log alone.
 *
 * `AGENTS.md` non-negotiable 2 says `app.item` is a projection that a replay can rebuild,
 * and that claim is why the log is allowed to be the truth: if the two disagree, the log
 * wins, and the way to know they disagree is to derive one from the other. Until now
 * nothing did. `EventPort.replay` existed, was implemented on both backends, and had no
 * callers — so the promise was untested, which for an invariant is the same as unmade.
 *
 * This is that derivation, and it is deliberately narrow. It rebuilds the part of an item
 * that the trash, the calendar and retrieval all read — which room it is in, whether it is
 * active, deleted or superseded, and what it currently says — because that is the part the
 * write path can leave inconsistent. What it does not rebuild is stated in
 * `replayItemLifecycle`'s own comment rather than implied by silence.
 *
 * The point of having it is not disaster recovery. It is that `replayItemLifecycle` over
 * the log has to equal `SELECT ... FROM app.item`, and that equality is one assertion a
 * test can make about every lifecycle transition at once — including the ones that used to
 * append their event outside the transaction that changed the row.
 */

import type { ItemId, ItemStatus, MemoryEvent, RoomId, ShortId } from './domain.js';

/** What the log says about one memory, with nothing read from `app.item`. */
export interface ReplayedItem {
  itemId: ItemId;
  shortId: ShortId | null;
  roomId: RoomId;
  status: ItemStatus;
  /** The latest body the log carries. `null` once redacted by a purge. */
  body: string | null;
  /** True when the last lifecycle event was a deletion — which is what `app.trash` means. */
  inTrash: boolean;
}

/** Events that say something about an item's lifecycle, in the order they may arrive. */
const LIFECYCLE_EVENTS = new Set([
  'item.created',
  'item.shared',
  'item.updated',
  'item.superseded',
  'item.moved',
  'item.deleted',
  'item.restored',
  'item.purged',
]);

function itemIdOf(event: MemoryEvent): ItemId | null {
  const raw = event.payload['item_id'];
  return typeof raw === 'string' && raw.length > 0 ? (raw as ItemId) : null;
}

function stringOr(value: unknown, fallback: string | null): string | null {
  return typeof value === 'string' ? value : fallback;
}

/**
 * Replays a room's — or the whole log's — item lifecycle.
 *
 * Events must arrive in `seq` order, which is what `EventPort.replay` returns; the log is
 * append-only, so that order is total and stable.
 *
 * **What this rebuilds:** room, status, current body, trash membership. **What it does
 * not:** salience, use counts, embeddings and token estimates, which are derived from
 * behaviour or recomputed from the body rather than recorded as events, and the short id
 * for a memory whose `item.created` has been purged out of the log. Those are honest gaps
 * rather than a replay that quietly reports less than it claims — an embedding is
 * recomputable from the body, and a purged memory is supposed to be unrecoverable.
 */
export function replayItemLifecycle(events: readonly MemoryEvent[]): Map<ItemId, ReplayedItem> {
  const items = new Map<ItemId, ReplayedItem>();

  for (const event of events) {
    if (!LIFECYCLE_EVENTS.has(event.eventType)) continue;

    const itemId = itemIdOf(event);
    if (!itemId) continue;

    const existing = items.get(itemId);

    switch (event.eventType) {
      case 'item.created':
      case 'item.shared': {
        items.set(itemId, {
          itemId,
          shortId: (stringOr(event.payload['short_id'], null) as ShortId | null) ?? null,
          roomId: event.roomId,
          status: 'active',
          body: stringOr(event.payload['body'], null),
          inTrash: false,
        });
        break;
      }

      case 'item.updated': {
        if (existing) existing.body = stringOr(event.payload['body'], existing.body);
        break;
      }

      // The loser of a correction. `item.superseded` names the *loser* in `item_id`, so this
      // is the memory leaving the current state rather than the one replacing it.
      case 'item.superseded': {
        if (existing) existing.status = 'superseded';
        break;
      }

      case 'item.moved': {
        if (existing) existing.roomId = event.roomId;
        break;
      }

      case 'item.deleted': {
        if (existing) {
          existing.status = 'deleted';
          existing.inTrash = true;
        }
        break;
      }

      case 'item.restored': {
        if (existing) {
          existing.status = 'active';
          existing.inTrash = false;
        }
        break;
      }

      // Thirty days ran out, or the person emptied the trash early. The row is gone from
      // `app.item` too, so the replay must not report it as anything.
      case 'item.purged': {
        items.delete(itemId);
        break;
      }
    }
  }

  return items;
}

/** What the log says about one document. `app.document`'s trash columns are the projection. */
export interface ReplayedDocument {
  documentId: string;
  roomId: RoomId;
  filename: string;
  /** True when the last lifecycle event was a deletion — what the trash means. */
  inTrash: boolean;
}

const DOCUMENT_EVENTS = new Set([
  'document.uploaded',
  'document.deleted',
  'document.restored',
  'document.purged',
]);

/**
 * Replays a document's trash membership.
 *
 * Narrower than the item replay on purpose, and the difference is worth stating. A document's
 * *content* is a blob in object storage plus an extraction the log never carried, so the log
 * cannot rebuild what a document says. What it can rebuild is the part the trash and the room
 * listing depend on: which room it belongs to, what it is called, and whether it is currently
 * deleted. That is the part the write path can leave inconsistent, so that is the part worth
 * being able to check.
 *
 * The same shape as `replayItemLifecycle` because documents now go through the same
 * transactional lifecycle path, which is the whole reason one trash is possible.
 */
export function replayDocumentLifecycle(
  events: readonly MemoryEvent[],
): Map<string, ReplayedDocument> {
  const documents = new Map<string, ReplayedDocument>();

  for (const event of events) {
    if (!DOCUMENT_EVENTS.has(event.eventType)) continue;

    const raw = event.payload['document_id'];
    if (typeof raw !== 'string' || raw.length === 0) continue;

    const existing = documents.get(raw);

    switch (event.eventType) {
      case 'document.uploaded': {
        documents.set(raw, {
          documentId: raw,
          roomId: event.roomId,
          filename: stringOr(event.payload['filename'], '') ?? '',
          inTrash: false,
        });
        break;
      }

      case 'document.deleted': {
        if (existing) existing.inTrash = true;
        break;
      }

      case 'document.restored': {
        if (existing) existing.inTrash = false;
        break;
      }

      // Thirty days ran out, or somebody emptied the trash early. The row is gone from
      // `app.document` as well, so the replay must not report it as anything.
      case 'document.purged': {
        documents.delete(raw);
        break;
      }
    }
  }

  return documents;
}

/** One place the log and a projection disagree. */
export interface Divergence {
  itemId: ItemId;
  field: 'presence' | 'roomId' | 'status' | 'body';
  fromLog: string | null;
  fromProjection: string | null;
}

/**
 * Compares the replay against the projection and reports every disagreement.
 *
 * Written to be run in a test rather than in production, because "the log and `app.item`
 * agree" is a property to prove once per code path and not a check to pay for on every
 * request. It reports *all* divergences rather than throwing on the first, since the useful
 * output when a transaction boundary is wrong is which transitions drifted, not one.
 *
 * `body` is compared only when the log still carries one: a redacted event legitimately has
 * no text, and the point of redaction is that the row does not either.
 */
export function divergencesFrom(
  log: Map<ItemId, ReplayedItem>,
  projection: readonly {
    itemId: ItemId;
    roomId: RoomId;
    status: ItemStatus;
    body: string;
  }[],
): Divergence[] {
  const out: Divergence[] = [];
  const seen = new Set<ItemId>();

  for (const row of projection) {
    seen.add(row.itemId);
    const replayed = log.get(row.itemId);

    if (!replayed) {
      // A row the log cannot account for. This is the shape the old `removeContributions`
      // produced: a deleted item with no `item.deleted` anywhere in the log.
      out.push({
        itemId: row.itemId,
        field: 'presence',
        fromLog: null,
        fromProjection: row.status,
      });
      continue;
    }

    if (replayed.roomId !== row.roomId) {
      out.push({
        itemId: row.itemId,
        field: 'roomId',
        fromLog: replayed.roomId,
        fromProjection: row.roomId,
      });
    }
    if (replayed.status !== row.status) {
      out.push({
        itemId: row.itemId,
        field: 'status',
        fromLog: replayed.status,
        fromProjection: row.status,
      });
    }
    if (replayed.body !== null && replayed.body !== row.body) {
      out.push({
        itemId: row.itemId,
        field: 'body',
        fromLog: replayed.body,
        fromProjection: row.body,
      });
    }
  }

  for (const [itemId, replayed] of log) {
    if (seen.has(itemId)) continue;
    // The log knows about a memory the projection does not. A state change that committed
    // its event and lost its row looks like this.
    out.push({
      itemId,
      field: 'presence',
      fromLog: replayed.status,
      fromProjection: null,
    });
  }

  return out;
}

/** One place the log and `app.document`'s trash columns disagree. */
export interface DocumentDivergence {
  documentId: string;
  field: 'presence' | 'roomId' | 'inTrash';
  fromLog: string | null;
  fromProjection: string | null;
}

/**
 * The same comparison for documents, over the part of a document the log can answer for.
 *
 * `inTrash` is the field that matters: it is what one trash surface is derived from, and it is
 * the one a non-transactional delete could set without recording. A document whose row says
 * deleted and whose log says nothing is the shape that made a memory unrestorable, and there
 * is no reason it would be kinder to a file.
 */
export function documentDivergencesFrom(
  log: Map<string, ReplayedDocument>,
  projection: readonly { documentId: string; roomId: RoomId; inTrash: boolean }[],
): DocumentDivergence[] {
  const out: DocumentDivergence[] = [];
  const seen = new Set<string>();

  for (const row of projection) {
    seen.add(row.documentId);
    const replayed = log.get(row.documentId);

    if (!replayed) {
      out.push({
        documentId: row.documentId,
        field: 'presence',
        fromLog: null,
        fromProjection: row.inTrash ? 'deleted' : 'live',
      });
      continue;
    }

    if (replayed.roomId !== row.roomId) {
      out.push({
        documentId: row.documentId,
        field: 'roomId',
        fromLog: replayed.roomId,
        fromProjection: row.roomId,
      });
    }
    if (replayed.inTrash !== row.inTrash) {
      out.push({
        documentId: row.documentId,
        field: 'inTrash',
        fromLog: String(replayed.inTrash),
        fromProjection: String(row.inTrash),
      });
    }
  }

  for (const [documentId, replayed] of log) {
    if (seen.has(documentId)) continue;
    out.push({
      documentId,
      field: 'presence',
      fromLog: replayed.inTrash ? 'deleted' : 'live',
      fromProjection: null,
    });
  }

  return out;
}
