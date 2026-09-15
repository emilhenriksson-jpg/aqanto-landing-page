/**
 * Rebuilding an item from the log.
 *
 * Every expectation here is a hand-written value rather than a second call to the function
 * under test. That is deliberate and it is the point of the file: `replayItemLifecycle` is
 * the check that `app.item` and `app.event` agree, so a test that computed its expectation
 * from the same code would prove only that the function is consistent with itself.
 */

import { describe, expect, it } from 'vitest';

import type { EventSeq, ItemId, MemoryEvent, RoomId, ShortId } from './domain.js';
import { divergencesFrom, replayItemLifecycle } from './replay.js';

const ITEM = '11111111-1111-4111-8111-111111111111' as ItemId;
const PERSONAL = '22222222-2222-4222-8222-222222222222' as RoomId;
const SHARED = '33333333-3333-4333-8333-333333333333' as RoomId;

let seq = 0;

function event(
  eventType: string,
  roomId: RoomId,
  payload: Record<string, unknown>,
): MemoryEvent {
  return {
    seq: (seq += 1) as EventSeq,
    id: `event-${seq}`,
    roomId,
    eventType,
    payload,
    actorPersonId: null,
    agentClient: null,
    clientId: null,
    sessionRef: null,
    approvedBy: null,
    occurredAt: new Date(2026, 8, 15, 12, seq),
    motivation: null,
    explicit: false,
    source: null,
  };
}

const created = () =>
  event('item.created', PERSONAL, {
    item_id: ITEM,
    short_id: 'p-7k2m',
    body: 'Allergisk mot ketchup',
  });

describe('replayItemLifecycle', () => {
  it('reads a saved memory out of its creation event', () => {
    const items = replayItemLifecycle([created()]);
    const item = items.get(ITEM);

    expect(item?.roomId).toBe(PERSONAL);
    expect(item?.status).toBe('active');
    expect(item?.body).toBe('Allergisk mot ketchup');
    expect(item?.shortId).toBe('p-7k2m' as ShortId);
    expect(item?.inTrash).toBe(false);
  });

  it('takes the newest body from the last update, not the first', () => {
    const items = replayItemLifecycle([
      created(),
      event('item.updated', PERSONAL, { item_id: ITEM, body: 'Allergisk mot ketchup och senap' }),
      event('item.updated', PERSONAL, { item_id: ITEM, body: 'Allergisk mot senap' }),
    ]);

    expect(items.get(ITEM)?.body).toBe('Allergisk mot senap');
  });

  it('follows a move into the room the event was appended to', () => {
    const items = replayItemLifecycle([
      created(),
      event('item.moved', SHARED, { item_id: ITEM, short_id: 'p-7k2m' }),
    ]);

    expect(items.get(ITEM)?.roomId).toBe(SHARED);
  });

  it('puts a deleted memory in the trash and takes a restored one back out', () => {
    const deleted = replayItemLifecycle([
      created(),
      event('item.deleted', PERSONAL, { item_id: ITEM }),
    ]);
    expect(deleted.get(ITEM)?.status).toBe('deleted');
    expect(deleted.get(ITEM)?.inTrash).toBe(true);

    const restored = replayItemLifecycle([
      created(),
      event('item.deleted', PERSONAL, { item_id: ITEM }),
      event('item.restored', PERSONAL, { item_id: ITEM }),
    ]);
    expect(restored.get(ITEM)?.status).toBe('active');
    expect(restored.get(ITEM)?.inTrash).toBe(false);
  });

  it('gives delete-undo-delete one answer', () => {
    // The sequence the trash view was rebuilt around, and the reason it derives from the log
    // rather than from five mutable columns that recorded the same thing twice.
    const items = replayItemLifecycle([
      created(),
      event('item.deleted', PERSONAL, { item_id: ITEM }),
      event('item.restored', PERSONAL, { item_id: ITEM }),
      event('item.deleted', PERSONAL, { item_id: ITEM }),
    ]);

    expect(items.get(ITEM)?.inTrash).toBe(true);
  });

  it('marks the loser of a correction superseded rather than deleted', () => {
    const items = replayItemLifecycle([
      created(),
      event('item.superseded', PERSONAL, { item_id: ITEM, superseded_by: 'other' }),
    ]);

    // Not in the trash: superseding is how something leaves the *current state*, and the old
    // value stays readable in the history rather than becoming recoverable for thirty days.
    expect(items.get(ITEM)?.status).toBe('superseded');
    expect(items.get(ITEM)?.inTrash).toBe(false);
  });

  it('forgets a purged memory entirely, because the row is gone too', () => {
    const items = replayItemLifecycle([
      created(),
      event('item.deleted', PERSONAL, { item_id: ITEM }),
      event('item.purged', PERSONAL, { item_id: ITEM }),
    ]);

    expect(items.has(ITEM)).toBe(false);
  });

  it('ignores events that are not about an item at all', () => {
    const items = replayItemLifecycle([
      created(),
      event('proposal.created', PERSONAL, { proposal_id: 'abc' }),
      event('export.created', PERSONAL, { included: 'own' }),
    ]);

    expect(items.size).toBe(1);
  });
});

describe('divergencesFrom', () => {
  const log = () => replayItemLifecycle([created()]);

  it('reports nothing when the log and the projection agree', () => {
    expect(
      divergencesFrom(log(), [
        { itemId: ITEM, roomId: PERSONAL, status: 'active', body: 'Allergisk mot ketchup' },
      ]),
    ).toEqual([]);
  });

  it('catches a projection row the log cannot account for', () => {
    // The exact shape the old bulk "ta bort mina bidrag" produced: a deleted item with no
    // `item.deleted` anywhere in the log, so no trash entry and nothing to restore.
    const orphan = '44444444-4444-4444-8444-444444444444' as ItemId;

    expect(
      divergencesFrom(log(), [
        { itemId: ITEM, roomId: PERSONAL, status: 'active', body: 'Allergisk mot ketchup' },
        { itemId: orphan, roomId: SHARED, status: 'deleted', body: 'Emils beslut' },
      ]),
    ).toEqual([{ itemId: orphan, field: 'presence', fromLog: null, fromProjection: 'deleted' }]);
  });

  it('catches a status the log does not agree with', () => {
    // A soft delete whose `item.deleted` never committed, which is what an event appended
    // outside its transaction leaves behind.
    expect(
      divergencesFrom(log(), [
        { itemId: ITEM, roomId: PERSONAL, status: 'deleted', body: 'Allergisk mot ketchup' },
      ]),
    ).toEqual([{ itemId: ITEM, field: 'status', fromLog: 'active', fromProjection: 'deleted' }]);
  });

  it('catches a room the log does not agree with', () => {
    expect(
      divergencesFrom(log(), [
        { itemId: ITEM, roomId: SHARED, status: 'active', body: 'Allergisk mot ketchup' },
      ]),
    ).toEqual([{ itemId: ITEM, field: 'roomId', fromLog: PERSONAL, fromProjection: SHARED }]);
  });

  it('catches a memory the log knows about and the projection lost', () => {
    expect(divergencesFrom(log(), [])).toEqual([
      { itemId: ITEM, field: 'presence', fromLog: 'active', fromProjection: null },
    ]);
  });

  it('says nothing about the body of a redacted event', () => {
    // A purge redacts the text out of the log, and the row it described is gone. What is left
    // is an event with no body, and a replay must not report that as a disagreement.
    const redacted = replayItemLifecycle([
      event('item.created', PERSONAL, { item_id: ITEM, short_id: 'p-7k2m', redacted: true }),
    ]);

    expect(
      divergencesFrom(redacted, [
        { itemId: ITEM, roomId: PERSONAL, status: 'active', body: '' },
      ]),
    ).toEqual([]);
  });
});
