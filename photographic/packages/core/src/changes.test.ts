/**
 * `memoryChanges` — the composition, not the storage. Both `HistoryPort.changes`
 * implementations are exercised against real data in `packages/db` and `e2e`; what is
 * worth pinning without a database is the part that decides *which* chains a question
 * reaches and *which* it must refuse.
 *
 * The refusal is the reason this file exists. A chain's steps are, by construction, text
 * the person has replaced — the one kind of content the allowlists in `recent.ts` and
 * `ask.ts` exist to keep out of a model's context. Those allowlists cannot help here,
 * because showing exactly those bodies is the feature. So the rule is about the head of
 * the chain instead, and it is the rule a third regression would break.
 */

import { describe, expect, it } from 'vitest';

import type {
  EventSeq,
  HistoryEntry,
  MemoryChange,
  MemoryChangeStep,
  RoomId,
  SearchHit,
  ShortId,
} from './domain.js';
import { memoryChanges, type ChangesServices } from './changes.js';
import type { Actor } from './ports.js';

const actor: Actor = {
  personId: 'emil' as never,
  agentClient: 'claude-desktop',
  sessionId: null,
  roomScope: [],
};

const personal = 'personal' as RoomId;
const ledning = 'ledning' as RoomId;

function hit(overrides: Partial<SearchHit> = {}): SearchHit {
  return {
    kind: 'item',
    id: 'item-1',
    roomId: personal,
    shortId: 'p-aaaa' as ShortId,
    text: 'Bor i Göteborg',
    score: 1,
    documentId: null,
    disputed: false,
    createdAt: new Date('2026-03-01T10:00:00Z'),
    ...overrides,
  };
}

function entry(overrides: Partial<HistoryEntry> = {}): HistoryEntry {
  return {
    seq: 1 as EventSeq,
    action: 'superseded',
    occurredAt: new Date('2026-02-01T10:00:00Z'),
    roomId: personal,
    roomTitle: 'Emil',
    shortId: 'p-old1' as ShortId,
    body: 'Bor i Stockholm',
    itemKind: 'fact',
    agentClient: 'claude-desktop',
    actorName: 'Emil',
    wasApproved: true,
    redacted: false,
    ...overrides,
  };
}

function step(overrides: Partial<MemoryChangeStep> = {}): MemoryChangeStep {
  return {
    seq: 1 as EventSeq,
    at: new Date('2026-01-01T10:00:00Z'),
    body: 'Bor i Stockholm',
    previousBody: null,
    shortId: 'p-old1' as ShortId,
    action: 'saved',
    agentClient: 'claude-desktop',
    actorName: 'Emil',
    source: { kind: 'conversation', label: 'Samtal med Claude', ref: 'sess-1', uri: null },
    motivation: 'Handlar om dig, och sparas därför bara privat.',
    ...overrides,
  };
}

function chain(overrides: Partial<MemoryChange> = {}): MemoryChange {
  const steps = overrides.steps ?? [
    step(),
    step({
      seq: 2 as EventSeq,
      at: new Date('2026-02-01T10:00:00Z'),
      body: 'Bor i Göteborg',
      previousBody: 'Bor i Stockholm',
      shortId: 'p-aaaa' as ShortId,
      action: 'superseded',
    }),
  ];

  return {
    shortId: 'p-aaaa' as ShortId,
    roomId: personal,
    roomTitle: 'Emil',
    currentBody: 'Bor i Göteborg',
    itemKind: 'fact',
    steps,
    firstSavedAt: steps[0]!.at,
    lastChangedAt: steps.at(-1)!.at,
    changeCount: steps.length - 1,
    ...overrides,
  };
}

function services(options: {
  hits?: SearchHit[];
  entries?: HistoryEntry[];
  chains?: MemoryChange[];
  onChanges?: (shortIds: ShortId[]) => void;
}): ChangesServices {
  return {
    retrieval: { search: async () => options.hits ?? [] },
    history: {
      list: async () => options.entries ?? [],
      changes: async (_actor, shortIds) => {
        options.onChanges?.(shortIds);
        return options.chains ?? [];
      },
    },
  };
}

describe('memoryChanges', () => {
  it('returns the chain: what it used to be, what replaced it, when, and from where', async () => {
    const [result] = await memoryChanges(services({ hits: [hit()], chains: [chain()] }), actor, {
      query: 'bor',
    });

    expect(result!.currentBody).toBe('Bor i Göteborg');
    expect(result!.changeCount).toBe(1);
    // Oldest first: a chain is read forwards, because the question is how it changed.
    expect(result!.steps.map((s) => s.body)).toEqual(['Bor i Stockholm', 'Bor i Göteborg']);
    expect(result!.steps[1]!.previousBody).toBe('Bor i Stockholm');
    expect(result!.steps[1]!.at).toEqual(new Date('2026-02-01T10:00:00Z'));
    expect(result!.steps[0]!.source?.label).toBe('Samtal med Claude');
  });

  it('reaches a chain through the wording it no longer uses', async () => {
    // The arm that makes this answer the question as people ask it. Somebody asking how
    // their address changed says "Stockholm" — the value that is gone. Search cannot
    // find it: a superseded item is excluded from search by design, and the current item
    // does not contain the word.
    const seen: ShortId[][] = [];
    const result = await memoryChanges(
      services({
        hits: [],
        entries: [entry({ body: 'Bor i Stockholm' })],
        chains: [chain()],
        onChanges: (ids) => seen.push(ids),
      }),
      actor,
      { query: 'Stockholm' },
    );

    // The superseded memory's own short id is what matched, and the port resolved it to
    // the chain whose head is a different memory entirely.
    expect(seen[0]).toContain('p-old1');
    expect(result[0]!.shortId).toBe('p-aaaa');
  });

  it('matches the old wording through Swedish inflection, not by substring', async () => {
    const seen: ShortId[][] = [];
    await memoryChanges(
      services({
        entries: [entry({ body: 'Marknadsföringsbudgeten höjs i mars' })],
        chains: [chain()],
        onChanges: (ids) => seen.push(ids),
      }),
      actor,
      { query: 'marknadsföringsbudget' },
    );

    expect(seen[0]).toContain('p-old1');
  });

  it('does not treat a proposal as something that happened', async () => {
    // Same reason `ask.ts` excludes it: a proposal waiting in the Godkänn-kön is not a
    // value the memory ever held, and matching it would let queued text pull a chain.
    const seen: ShortId[][] = [];
    await memoryChanges(
      services({
        entries: [entry({ action: 'proposed', body: 'Bor i Malmö', shortId: 'p-prop' as ShortId })],
        chains: [],
        onChanges: (ids) => seen.push(ids),
      }),
      actor,
      { query: 'Malmö' },
    );

    expect(seen).toEqual([]);
  });

  it('asks nothing when the question has neither a query nor a window', async () => {
    let asked = false;
    const result = await memoryChanges(
      services({ onChanges: () => { asked = true; }, chains: [chain()] }),
      actor,
      {},
    );

    expect(result).toEqual([]);
    expect(asked).toBe(false);
  });

  it('shows a chain in full even when only one step falls inside the window', async () => {
    // "Vad ändrades den här veckan" is answered by the change *and* by what it changed
    // from. Cutting the chain at the window boundary would leave "it changed" with no
    // way to see to what.
    const [result] = await memoryChanges(services({ hits: [hit()], chains: [chain()] }), actor, {
      query: 'bor',
      since: new Date('2026-01-20T00:00:00Z'),
    });

    expect(result!.steps).toHaveLength(2);
    expect(result!.steps[0]!.at).toEqual(new Date('2026-01-01T10:00:00Z'));
  });

  it('drops a chain whose changes all fall outside the window', async () => {
    const result = await memoryChanges(services({ hits: [hit()], chains: [chain()] }), actor, {
      query: 'bor',
      since: new Date('2026-06-01T00:00:00Z'),
    });

    expect(result).toEqual([]);
  });

  it('says a memory is unchanged rather than hiding it', async () => {
    const unchanged = chain({ steps: [step()], currentBody: 'Bor i Stockholm' });

    const [result] = await memoryChanges(
      services({ hits: [hit()], chains: [unchanged] }),
      actor,
      { query: 'bor' },
    );

    expect(result!.changeCount).toBe(0);
    expect(result!.firstSavedAt).toEqual(result!.lastChangedAt);
  });

  it('puts the most recently changed memory first', async () => {
    const older = chain({
      shortId: 'p-bbbb' as ShortId,
      currentBody: 'Jobbar på Buyersclub',
      lastChangedAt: new Date('2026-01-05T10:00:00Z'),
    });

    const result = await memoryChanges(
      services({ hits: [hit()], chains: [older, chain()] }),
      actor,
      { query: 'bor' },
    );

    expect(result.map((c) => c.shortId)).toEqual(['p-aaaa', 'p-bbbb']);
  });

  it('keeps a room filter that the port was not given', async () => {
    const elsewhere = chain({ roomId: ledning, roomTitle: 'Buyersclub Ledning' });

    const result = await memoryChanges(
      services({ hits: [hit()], chains: [elsewhere] }),
      actor,
      { query: 'bor', roomIds: [personal] },
    );

    expect(result).toEqual([]);
  });

  /**
   * The regression this feature could introduce, stated as a test.
   *
   * It has been closed twice already — in `recent.ts`, where a deleted memory's own
   * earlier `item.created` event brought its body back, and in `ask.ts`, where a save
   * and a delete inside the same searched window both matched and the `saved` line won.
   * Neither fix helps here: both were allowlists over *actions*, and this feature exists
   * to show precisely the bodies those allowlists refuse.
   *
   * So the rule is about the head instead. `HistoryPort.changes` will not return a chain
   * whose head is not `active`, and this refuses it again — two locks, because one was
   * demonstrably not enough the last two times.
   */
  describe('a memory the person has since deleted', () => {
    it('has no chain, not a shortened one', async () => {
      // What a port that regressed would hand back: the chain assembled, the head gone.
      // `currentBody` is the tell, and it is typed non-null so that this is a shape
      // violation rather than an empty string quietly rendering.
      const leaked = chain({ currentBody: '' });

      const result = await memoryChanges(
        services({ hits: [hit()], chains: [leaked] }),
        actor,
        { query: 'bor' },
      );

      expect(result).toEqual([]);
    });

    it('cannot have its superseded body pulled back by searching for that body', async () => {
      // The exact shape of both previous leaks: the question is asked *with the old
      // wording*, which is the one phrasing guaranteed to match text that is meant to be
      // gone. The history arm finds the superseded event, the chain resolves — and the
      // head is in the trash, so nothing comes back and "Bor i Stockholm" does not
      // appear anywhere in the answer.
      const result = await memoryChanges(
        services({
          hits: [],
          entries: [entry({ body: 'Bor i Stockholm' })],
          chains: [chain({ currentBody: '' })],
        }),
        actor,
        { query: 'Stockholm' },
      );

      expect(result).toEqual([]);
      expect(JSON.stringify(result)).not.toContain('Stockholm');
    });

    it('does not hide the chains of memories that still exist alongside it', async () => {
      // The refusal is per chain. A deleted memory must not take a live one with it, or
      // the safe behaviour becomes an outage.
      const alive = chain({ shortId: 'p-cccc' as ShortId, currentBody: 'Bor i Göteborg' });
      const deleted = chain({ shortId: 'p-dddd' as ShortId, currentBody: '' });

      const result = await memoryChanges(
        services({ hits: [hit()], chains: [deleted, alive] }),
        actor,
        { query: 'bor' },
      );

      expect(result.map((c) => c.shortId)).toEqual(['p-cccc']);
    });
  });
});
