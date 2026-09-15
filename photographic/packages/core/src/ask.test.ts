import { describe, expect, it } from 'vitest';

import { askMemory, type AskServices } from './ask.js';
import type {
  Actor,
  EventSeq,
  HistoryEntry,
  HistoryPort,
  PersonId,
  RetrievalPort,
  RoomId,
  RoomSummary,
  SearchHit,
  ShortId,
} from './index.js';

const actor: Actor = {
  personId: 'person-1' as PersonId,
  agentClient: 'claude-desktop',
  sessionId: null,
  roomScope: [],
};

const PERSONAL = 'room-personal' as RoomId;
const SHARED = 'room-shared' as RoomId;

function room(overrides: Partial<RoomSummary> = {}): RoomSummary {
  return {
    roomId: PERSONAL,
    slug: 'personligt',
    title: 'Personligt',
    kind: 'personal',
    role: 'owner',
    oneLine: '',
    memberCount: 1,
    unseenCount: 0,
    ...overrides,
  };
}

function hit(overrides: Partial<SearchHit> = {}): SearchHit {
  return {
    kind: 'item',
    id: 'item-1',
    roomId: PERSONAL,
    shortId: 'p-aaaa' as ShortId,
    text: 'Allergisk mot ketchup',
    score: 0.03,
    documentId: null,
    disputed: false,
    createdAt: new Date('2026-09-10T09:00:00Z'),
    ...overrides,
  };
}

function historyEntry(overrides: Partial<HistoryEntry> = {}): HistoryEntry {
  return {
    seq: 1 as EventSeq,
    action: 'saved',
    occurredAt: new Date('2026-09-14T09:00:00Z'),
    roomId: SHARED,
    roomTitle: 'Buyersclub Ledning',
    shortId: 'p-bbbb' as ShortId,
    body: 'Vi beslutade att skjuta förvärvet till Q3',
    itemKind: 'decision',
    agentClient: 'claude-desktop',
    actorName: 'Emil',
    wasApproved: false,
    redacted: false,
    ...overrides,
  };
}

function services(input: {
  search?: RetrievalPort['search'];
  list?: HistoryPort['list'];
  rooms?: RoomSummary[];
}): AskServices {
  return {
    retrieval: {
      search: input.search ?? (async () => []),
    },
    history: {
      list: input.list ?? (async () => []),
    },
    rooms: {
      listForPerson: async () => input.rooms ?? [room(), room({ roomId: SHARED, title: 'Buyersclub Ledning', kind: 'shared' })],
    },
  };
}

describe('askMemory', () => {
  it('returns nothing for an empty question — no query and no time window', async () => {
    const result = await askMemory(services({}), actor, {});
    expect(result).toEqual([]);
  });

  it('answers a plain query the same way search_memory always has', async () => {
    let seenQuery: string | undefined;
    const svc = services({
      search: async (_actor, input) => {
        seenQuery = input.query;
        return [hit()];
      },
    });

    const result = await askMemory(svc, actor, { query: 'ketchup' });

    expect(seenQuery).toBe('ketchup');
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ kind: 'memory', shortId: 'p-aaaa', roomTitle: 'Personligt' });
  });

  it('maps a chunk hit to kind "document", never inventing a date for it', async () => {
    const svc = services({
      search: async () => [
        hit({ kind: 'chunk', shortId: null, documentId: 'doc-1' as never, createdAt: null }),
      ],
    });

    const [ask] = await askMemory(svc, actor, { query: 'kontrakt' });

    expect(ask?.kind).toBe('document');
    expect(ask?.occurredAt).toBeNull();
  });

  it('folds in matching calendar events when a time window is given', async () => {
    const svc = services({
      search: async () => [],
      list: async () => [historyEntry()],
    });

    const result = await askMemory(svc, actor, {
      query: 'förvärvet',
      since: new Date('2026-09-13T00:00:00Z'),
    });

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ kind: 'event', seq: 1, roomTitle: 'Buyersclub Ledning' });
  });

  it('excludes calendar events outside the window even if the port returns them', async () => {
    // `HistoryPort.list` has no `until`; the bound is enforced here.
    const svc = services({
      list: async () => [historyEntry({ occurredAt: new Date('2026-09-20T00:00:00Z') })],
    });

    const result = await askMemory(svc, actor, {
      since: new Date('2026-09-01T00:00:00Z'),
      until: new Date('2026-09-15T00:00:00Z'),
    });

    expect(result).toEqual([]);
  });

  it('never repeats the text of something that was deleted, even though the event still shows', async () => {
    const svc = services({
      list: async () => [historyEntry({ action: 'deleted', body: 'Allergisk mot ketchup' })],
    });

    const result = await askMemory(svc, actor, { since: new Date('2026-09-01T00:00:00Z') });

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ kind: 'event', action: 'deleted', text: '' });
  });

  it('never repeats the text of a proposal still waiting in the Godkänn-kön', async () => {
    const svc = services({
      list: async () => [historyEntry({ action: 'proposed', body: 'Utmana alltid mina idéer' })],
    });

    const result = await askMemory(svc, actor, { since: new Date('2026-09-01T00:00:00Z') });

    expect(result[0]?.text).toBe('');
  });

  it('still finds a deleted memory by its text (for scoring) without leaking that text back out', async () => {
    const svc = services({
      list: async () => [historyEntry({ action: 'deleted', body: 'Allergisk mot ketchup' })],
    });

    const result = await askMemory(svc, actor, {
      query: 'ketchup',
      since: new Date('2026-09-01T00:00:00Z'),
    });

    // Matched (the deletion shows up at all), but the text that matched is not repeated.
    expect(result).toHaveLength(1);
    expect(result[0]?.text).toBe('');
  });

  it('collapses a memory saved and later deleted in the same window to one line — the deletion', async () => {
    const entries: HistoryEntry[] = [
      historyEntry({ seq: 2 as EventSeq, action: 'deleted', body: null, shortId: 'p-bbbb' as ShortId }),
      historyEntry({ seq: 1 as EventSeq, action: 'saved', body: 'Allergisk mot ketchup', shortId: 'p-bbbb' as ShortId }),
    ];
    const svc = services({ list: async () => entries });

    const result = await askMemory(svc, actor, { since: new Date('2026-09-01T00:00:00Z') });

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ action: 'deleted', text: '' });
  });

  it('excludes calendar events whose text does not match the query', async () => {
    const svc = services({
      list: async () => [historyEntry({ body: 'Något helt orelaterat' })],
    });

    const result = await askMemory(svc, actor, {
      query: 'förvärvet',
      since: new Date('2026-09-01T00:00:00Z'),
    });

    expect(result).toEqual([]);
  });

  it('excludes a memory saved outside the requested window even though the text matches', async () => {
    const svc = services({
      search: async () => [hit({ createdAt: new Date('2026-01-01T00:00:00Z') })],
    });

    const result = await askMemory(svc, actor, {
      query: 'ketchup',
      since: new Date('2026-09-01T00:00:00Z'),
    });

    expect(result).toEqual([]);
  });

  it('sorts "oldest" by when it happened, mixing memories and events on one timeline', async () => {
    const svc = services({
      search: async () => [hit({ text: 'förvärvet', createdAt: new Date('2026-09-12T00:00:00Z') })],
      list: async () => [historyEntry({ occurredAt: new Date('2026-09-05T00:00:00Z') })],
    });

    const result = await askMemory(svc, actor, { query: 'förvärvet', sort: 'oldest' });

    expect(result.map((r) => r.kind)).toEqual(['event', 'memory']);
  });

  it('reaches into the calendar for "oldest" even with no explicit time window', async () => {
    // "När började vi diskutera den här idén?" has no date in it at all, but still
    // needs the full history, because the first mention may since have been deleted.
    let calledHistory = false;
    const svc = services({
      list: async () => {
        calledHistory = true;
        return [];
      },
    });

    await askMemory(svc, actor, { query: 'idén', sort: 'oldest' });

    expect(calledHistory).toBe(true);
  });

  it('normalises relevance scores per arm before merging incomparable scales', async () => {
    // RRF fusion (the memory arm) and term-length overlap (the event arm) are
    // incomparable numbers by construction — one is ~0.03, the other is the length of
    // the matched word. With exactly one hit per arm, max-normalising each arm puts
    // both at 1 regardless of that gap.
    const svc = services({
      search: async () => [hit({ score: 0.03 })],
      list: async () => [historyEntry({ body: 'ketchup igen' })],
    });

    const result = await askMemory(svc, actor, {
      query: 'ketchup',
      since: new Date('2026-09-01T00:00:00Z'),
    });

    // Each arm had exactly one hit, so max-normalising puts both at the top of their
    // own arm — the assertion that matters is that neither score leaks through raw
    // and one does not always win just because RRF and term-overlap live on different
    // scales.
    expect(result.every((r) => r.score === 1)).toBe(true);
  });

  it('never asks the history port for a room outside what was requested', async () => {
    const seenRoomIds: Array<RoomId | undefined> = [];
    const svc = services({
      list: async (_actor, input) => {
        seenRoomIds.push(input?.roomId);
        return [];
      },
    });

    await askMemory(svc, actor, { since: new Date(), roomIds: [SHARED] });

    expect(seenRoomIds).toEqual([SHARED]);
  });

  it('asks for every accessible room when none is named — the isolation stays HistoryPort\u2019s job', async () => {
    const seenRoomIds: Array<RoomId | undefined> = [];
    const svc = services({
      list: async (_actor, input) => {
        seenRoomIds.push(input?.roomId);
        return [];
      },
    });

    await askMemory(svc, actor, { since: new Date() });

    // No roomId at all: `HistoryPort.list` resolves that to every room the actor can
    // reach on its own. This function must not narrow it, and must not widen it either.
    expect(seenRoomIds).toEqual([undefined]);
  });
});
