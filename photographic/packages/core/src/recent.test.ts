import { describe, expect, it } from 'vitest';

import type { Actor, HistoryEntry, HistoryPort, PersonId } from './index.js';
import { RECENT_ACTIVITY_LIMIT } from './policy.js';
import { recentActivityFor } from './recent.js';

const actor: Actor = {
  personId: 'person-1' as PersonId,
  agentClient: 'claude-desktop',
  sessionId: null,
  roomScope: [],
};

function fakeHistory(entries: HistoryEntry[]): Pick<HistoryPort, 'list'> {
  return {
    list: async (_actor, input) => entries.slice(0, input?.limit),
  };
}

describe('recentActivityFor', () => {
  it('asks the history port for a bounded window, wider than the final count', async () => {
    let seenLimit: number | undefined;
    const history: Pick<HistoryPort, 'list'> = {
      list: async (_actor, input) => {
        seenLimit = input?.limit;
        return [];
      },
    };

    await recentActivityFor(history, actor);

    // Wider than `RECENT_ACTIVITY_LIMIT` on purpose, to leave room for the collapse
    // below -- but still a small, fixed number, not "as much as exists".
    expect(seenLimit).toBeGreaterThan(RECENT_ACTIVITY_LIMIT);
    expect(seenLimit).toBeLessThanOrEqual(RECENT_ACTIVITY_LIMIT * 10);
  });

  it('relies on HistoryPort.list for room isolation and the event-type allowlist', async () => {
    // The seam adds no filtering of its own beyond the collapse below. Room isolation
    // and which event types are visible at all live in `HistoryPort`, not here, so
    // there is exactly one place that can get either wrong.
    const entries = [
      { seq: 2, shortId: 'p-aaaa' } as HistoryEntry,
      { seq: 1, shortId: 'p-bbbb' } as HistoryEntry,
    ];

    const result = await recentActivityFor(fakeHistory(entries), actor, 5);

    expect(result).toEqual(entries);
  });

  it('accepts a caller-supplied limit smaller than the default', async () => {
    let seenLimit: number | undefined;
    const history: Pick<HistoryPort, 'list'> = {
      list: async (_actor, input) => {
        seenLimit = input?.limit;
        return [];
      },
    };

    await recentActivityFor(history, actor, 1);

    expect(seenLimit).toBeGreaterThan(1);
  });

  it('keeps only the newest event per memory, so a deleted one shows up once', async () => {
    // A memory saved and then deleted inside the same short window must not surface
    // both lines -- and specifically must not surface the earlier `saved` line, whose
    // body a later deletion was supposed to remove from context.
    const entries: HistoryEntry[] = [
      { seq: 3, shortId: 'p-aaaa', action: 'deleted', body: null } as HistoryEntry,
      { seq: 2, shortId: 'p-aaaa', action: 'saved', body: 'Allergisk mot ketchup' } as HistoryEntry,
      { seq: 1, shortId: 'p-bbbb', action: 'saved', body: 'Något annat' } as HistoryEntry,
    ];

    const result = await recentActivityFor(fakeHistory(entries), actor, 5);

    expect(result).toEqual([entries[0], entries[2]]);
  });

  it('keeps entries with no short id (a room created, a member joining) as their own line', async () => {
    const entries: HistoryEntry[] = [
      { seq: 2, shortId: null, action: 'room_created' } as HistoryEntry,
      { seq: 1, shortId: null, action: 'member_joined' } as HistoryEntry,
    ];

    const result = await recentActivityFor(fakeHistory(entries), actor, 5);

    expect(result).toEqual(entries);
  });

  it('stops once the limit is reached even with plenty more history available', async () => {
    const entries: HistoryEntry[] = Array.from({ length: 30 }, (_, i) => ({
      seq: 30 - i,
      shortId: `p-${i}`,
      action: 'saved',
    }) as HistoryEntry);

    const result = await recentActivityFor(fakeHistory(entries), actor, RECENT_ACTIVITY_LIMIT);

    expect(result).toHaveLength(RECENT_ACTIVITY_LIMIT);
    expect(result).toEqual(entries.slice(0, RECENT_ACTIVITY_LIMIT));
  });
});
