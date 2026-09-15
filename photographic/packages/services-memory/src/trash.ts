/**
 * The trash.
 *
 * Every other safeguard in this system is about stopping a model from writing something
 * wrong. This one is about surviving it having done so. A model that deletes the wrong
 * memory on a misread request is the failure that loses a person permanently, and no
 * amount of prompt care reduces that risk to zero.
 *
 * Which is also what pays for the rest of the design: because deletion is reversible
 * for thirty days, `forget_memory` can act on a clear request instead of asking twice,
 * and `remember` can lean towards saving. Remove the trash and both of those become
 * indefensible.
 *
 * Thirty days because it has to outlast a holiday.
 */

import type {
  Actor,
  Item,
  ItemId,
  PersonId,
  ProjectionPort,
  RoomId,
  ShortId,
  TrashEntry,
  TrashPort,
} from '@photographic/core';
import { NotFoundError, NotPermittedError } from '@photographic/core';
import { daysRemaining } from '@photographic/core';

import type { MemoryIngest } from './ingest.js';
import { MemoryStore } from './store.js';

export const DEFAULT_PURGE_LIMIT = 500;

export class MemoryTrash implements TrashPort {
  constructor(
    private readonly store: MemoryStore,
    private readonly ingest: MemoryIngest,
    private readonly projection: ProjectionPort,
  ) {}

  /**
   * What is in the trash, read out of the log.
   *
   * Membership is a question about events: an item whose most recent lifecycle event was
   * a deletion, and which has not been restored or purged since. It used to be
   * `status = 'deleted'` plus five columns recording who deleted it, from which client
   * and why — every one of which the log already knew. Two records of one fact is one
   * record and one thing that drifts from it, and you find out they disagree when a
   * person sees something in the trash they restored last week.
   *
   * The text and the deadline still come from the item, because the item is the memory's
   * current value and the deadline is a decision taken at deletion rather than a
   * derivation. Who, which client and why come from the event, where nothing can
   * overwrite them.
   */
  async list(
    actor: Actor,
    input: { roomId?: RoomId; limit?: number } = {},
  ): Promise<TrashEntry[]> {
    const scope = new Set(
      input.roomId
        ? this.store.canRead(actor.personId, input.roomId)
          ? [input.roomId]
          : []
        : this.store.accessibleRoomIds(actor.personId),
    );
    const now = this.store.now();

    const entries: TrashEntry[] = [];

    for (const item of this.store.items.values()) {
      if (!scope.has(item.roomId)) continue;
      if (item.purgeAfter === null) continue;

      const last = this.store.lastLifecycleEvent(item.id);
      if (last?.eventType !== 'item.deleted') continue;

      entries.push({
        shortId: item.shortId,
        roomId: item.roomId,
        roomTitle: this.store.rooms.get(item.roomId)?.title ?? '',
        kind: item.kind,
        body: item.body,
        deletedAt: last.occurredAt,
        deletedBy: last.actorPersonId,
        deletedByClient: last.agentClient,
        // The person's own phrasing, as it was recorded. "Flyttade från Stockholm" is an
        // answer a week later; "borttaget" against forty rows is a list to re-derive.
        deleteReason: last.motivation,
        purgeAfter: item.purgeAfter,
        // Pre-computed because every surface showing the trash needs it, and a model
        // asked "is it really gone?" should not have to do date arithmetic to answer.
        daysRemaining: daysRemaining(item.purgeAfter, now),
      });
    }

    return entries
      .sort((a, b) => b.deletedAt.getTime() - a.deletedAt.getTime())
      .slice(0, input.limit ?? 50);
  }

  /**
   * Restores by short id, keeping the id.
   *
   * Minting a new one would break the only handle a person has on a memory: "ta
   * tillbaka p-7k2m" has to still refer to p-7k2m afterwards, or the id is not a name
   * for anything.
   */
  async restore(actor: Actor, shortId: ShortId, roomId?: RoomId): Promise<Item> {
    const item = this.store.findByShortId(actor.personId, shortId, roomId);
    if (!item || !this.store.isInTrash(item.id)) {
      throw new NotFoundError('Det finns inget att återställa.');
    }
    if (!this.store.canWrite(actor.personId, item.roomId)) throw new NotPermittedError();

    return this.ingest.restore(actor, item);
  }

  /**
   * Hard-deletes everything past its deadline.
   *
   * Takes no actor, because expiry is not an action anyone performs. Redacting the text
   * from the event log is the part that makes the promise real: dropping the item row
   * while the same sentence sits in an append-only payload is not erasure, it is
   * hiding. The record that something was removed survives; the content does not.
   */
  async purgeExpired(limit = DEFAULT_PURGE_LIMIT): Promise<number> {
    const now = this.store.now();
    const due = [...this.store.items.values()]
      .filter((i) => i.status === 'deleted' && i.purgeAfter !== null && i.purgeAfter <= now)
      .sort((a, b) => a.purgeAfter!.getTime() - b.purgeAfter!.getTime())
      .slice(0, limit);

    if (due.length === 0) return 0;

    for (const item of due) {
      // Appended before the redaction sweep and deliberately carrying no body, so the
      // feed can say that something was removed without saying what it was.
      this.store.append({
        roomId: item.roomId,
        eventType: 'item.purged',
        payload: { item_id: item.id, short_id: item.shortId },
        actorPersonId: item.deletedBy,
        agentClient: item.deletedByClient,
        motivation: 'Trettio dagar gick. Texten är permanent raderad.',
      });
    }

    this.store.redactItemText(due.map((i) => i.id));
    await this.forget(due);

    return due.length;
  }

  /** For people who want it gone now rather than in thirty days. */
  async purgeNow(actor: Actor, shortId: ShortId, roomId?: RoomId): Promise<void> {
    const item = this.store.findByShortId(actor.personId, shortId, roomId);
    if (!item || !this.store.isInTrash(item.id)) {
      throw new NotFoundError('Det finns inget att radera.');
    }
    if (!this.store.canWrite(actor.personId, item.roomId)) throw new NotPermittedError();

    this.store.append({
      roomId: item.roomId,
      eventType: 'item.purged',
      payload: { item_id: item.id, short_id: item.shortId },
      actorPersonId: actor.personId,
      agentClient: actor.agentClient,
      clientId: actor.clientId ?? null,
      explicit: true,
      motivation: 'Permanent raderat på din begäran, före de trettio dagarna.',
    });

    this.store.redactItemText([item.id]);
    await this.forget([item]);
  }

  /**
   * Drops the rows, and the caches built from them.
   *
   * A cached profile is derived state, but it is derived state holding a verbatim copy
   * of the text. Leaving it would mean the next model to connect is handed something the
   * person was told no longer exists.
   */
  private async forget(items: Item[]): Promise<void> {
    const rooms = new Set<RoomId>();
    const persons = new Set<PersonId>();

    for (const item of items) {
      this.store.items.delete(item.id);
      this.store.embeddings.delete(item.id);
      rooms.add(item.roomId);

      const room = this.store.rooms.get(item.roomId);
      if (room?.kind === 'personal') persons.add(room.createdBy);
    }

    for (const [token, itemId] of [...this.store.undoTokens.entries()]) {
      if (!this.store.items.has(itemId as ItemId)) this.store.undoTokens.delete(token);
    }

    for (const roomId of rooms) {
      this.store.briefs.delete(roomId);
      await this.projection.invalidate({ roomId });
    }
    for (const personId of persons) {
      this.store.profiles.delete(personId);
      await this.projection.invalidate({ personId });
    }
  }
}
