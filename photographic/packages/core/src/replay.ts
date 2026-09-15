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
