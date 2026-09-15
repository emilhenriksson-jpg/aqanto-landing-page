/**
 * `openThreadsFor` — what counts as a loose end.
 *
 * The rules are the whole feature: a block whose value depends on every line in it being
 * worth asking about is a block where one wrong line costs more than the block earns. So
 * each of the four conditions has its own test, in both directions where that is
 * meaningful.
 */

import { describe, expect, it } from 'vitest';

import type { AgentClient, EventSeq, HistoryEntry, ItemKind, RoomId, ShortId } from './domain.js';
import { openThreadsFor } from './open.js';
import type { Actor, HistoryPort } from './ports.js';
import { OPEN_THREAD_LIMIT, OPEN_THREAD_MAX_AGE_DAYS } from './policy.js';

const actor: Actor = {
  personId: 'emil' as never,
  agentClient: 'claude-desktop',
  sessionId: null,
  roomScope: [],
};

const NOW = new Date('2026-09-15T12:00:00Z');
const DAY = 24 * 60 * 60 * 1000;

function daysAgo(days: number): Date {
  return new Date(NOW.getTime() - days * DAY);
}

let seq = 0;

function entry(overrides: Partial<HistoryEntry> = {}): HistoryEntry {
  seq += 1;
  return {
    seq: seq as EventSeq,
    action: 'saved',
    occurredAt: daysAgo(21),
    roomId: 'ledning' as RoomId,
    roomTitle: 'Buyersclub Ledning',
    shortId: 'p-aaaa' as ShortId,
    body: 'Vi skulle höra av oss till Peab om köksofferten',
    itemKind: 'decision' as ItemKind,
    agentClient: 'claude-desktop' as AgentClient,
    actorName: 'Emil',
    wasApproved: false,
    redacted: false,
    ...overrides,
  };
}

/** `history.list` is newest-first, which `openThreadsFor` relies on. */
function history(entries: HistoryEntry[]): Pick<HistoryPort, 'list'> {
  return {
    list: async () => [...entries].sort((a, b) => b.seq - a.seq),
  };
}

describe('openThreadsFor', () => {
  it('finds a decision nothing has happened to since', async () => {
    const [open] = await openThreadsFor(history([entry()]), actor, NOW);

    expect(open!.shortId).toBe('p-aaaa');
    expect(open!.body).toContain('Peab');
    expect(open!.daysSince).toBe(21);
    expect(open!.kind).toBe('decision');
    expect(open!.roomTitle).toBe('Buyersclub Ledning');
  });

  it('ignores a durable fact, which is not waiting on anything', async () => {
    // The line that would wreck the block. "Allergisk mot ketchup" is never going to be
    // followed up on, and a model asked to raise it learns that this block means nothing.
    const open = await openThreadsFor(
      history([entry({ itemKind: 'fact', body: 'Allergisk mot ketchup' })]),
      actor,
      NOW,
    );

    expect(open).toEqual([]);
  });

  it('ignores an instruction and a compass principle for the same reason', async () => {
    const open = await openThreadsFor(
      history([
        entry({ itemKind: 'instruction', shortId: 'p-inst' as ShortId }),
        entry({ itemKind: 'compass', shortId: 'p-comp' as ShortId }),
        entry({ itemKind: 'preference', shortId: 'p-pref' as ShortId }),
        entry({ itemKind: 'identity', shortId: 'p-iden' as ShortId }),
        entry({ itemKind: 'never', shortId: 'p-nevr' as ShortId }),
      ]),
      actor,
      NOW,
    );

    expect(open).toEqual([]);
  });

  it('counts a note as open, because a note can be a loose end', async () => {
    const [open] = await openThreadsFor(history([entry({ itemKind: 'note' })]), actor, NOW);

    expect(open!.kind).toBe('note');
  });

  it('drops one that has been followed up on', async () => {
    // A deletion, a supersede or a dispute *is* a follow-up. The newest event decides.
    for (const action of ['deleted', 'superseded', 'restored', 'disputed'] as const) {
      const open = await openThreadsFor(
        history([
          entry({ occurredAt: daysAgo(21) }),
          entry({ action, occurredAt: daysAgo(2), itemKind: null }),
        ]),
        actor,
        NOW,
      );

      expect(open, action).toEqual([]);
    }
  });

  it('keeps one whose newest event is an edit, since an edit is still unresolved', async () => {
    // Editing the text of a decision does not resolve it, and the clock restarts from
    // the edit rather than the original save.
    const [open] = await openThreadsFor(
      history([
        entry({ occurredAt: daysAgo(40) }),
        entry({ action: 'updated', occurredAt: daysAgo(12), itemKind: null }),
      ]),
      actor,
      NOW,
    );

    expect(open!.daysSince).toBe(12);
  });

  it('ignores something saved days ago, which is this week rather than a loose end', async () => {
    // Asking "har du hunnit med X?" about yesterday reads as not having been listening.
    const open = await openThreadsFor(history([entry({ occurredAt: daysAgo(2) })]), actor, NOW);

    expect(open).toEqual([]);
  });

  it('ignores something old enough to be the past rather than a thread', async () => {
    const open = await openThreadsFor(
      history([entry({ occurredAt: daysAgo(OPEN_THREAD_MAX_AGE_DAYS + 30) })]),
      actor,
      NOW,
    );

    expect(open).toEqual([]);
  });

  it('puts the longest-ignored one first', async () => {
    const open = await openThreadsFor(
      history([
        entry({ shortId: 'p-newer' as ShortId, occurredAt: daysAgo(9) }),
        entry({ shortId: 'p-older' as ShortId, occurredAt: daysAgo(45) }),
        entry({ shortId: 'p-middle' as ShortId, occurredAt: daysAgo(20) }),
      ]),
      actor,
      NOW,
      3,
    );

    expect(open.map((thread) => thread.shortId)).toEqual(['p-older', 'p-middle', 'p-newer']);
  });

  it('stays at two, because three loose ends is a standup', async () => {
    const many = Array.from({ length: 8 }, (_, i) =>
      entry({ shortId: `p-${i}` as ShortId, occurredAt: daysAgo(10 + i) }),
    );

    expect(await openThreadsFor(history(many), actor, NOW)).toHaveLength(OPEN_THREAD_LIMIT);
  });

  it('excludes a memory whose kind is not in the window rather than guessing it', async () => {
    // Only `item.created` carries the kind, so a memory created before the scan window
    // arrives with `itemKind: null`. Excluded, not assumed: a wrong line here is worth
    // more than a missing one.
    const open = await openThreadsFor(
      history([entry({ action: 'updated', itemKind: null, occurredAt: daysAgo(20) })]),
      actor,
      NOW,
    );

    expect(open).toEqual([]);
  });

  it('says nothing about a purged memory', async () => {
    const open = await openThreadsFor(
      history([entry({ redacted: true, body: null })]),
      actor,
      NOW,
    );

    expect(open).toEqual([]);
  });

  it('asks the log for a bounded window rather than everything', async () => {
    let asked: { since?: Date; limit?: number } | undefined;
    await openThreadsFor(
      {
        list: async (_actor, input) => {
          asked = input;
          return [];
        },
      },
      actor,
      NOW,
    );

    expect(asked?.limit).toBeGreaterThan(0);
    // Far enough back to see something stop, no further: this looks for the absence of
    // activity, which is the one query that cannot be answered by the newest few rows.
    expect(asked?.since?.getTime()).toBe(NOW.getTime() - OPEN_THREAD_MAX_AGE_DAYS * DAY);
  });
});
