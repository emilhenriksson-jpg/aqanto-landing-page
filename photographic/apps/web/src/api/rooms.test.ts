import { afterEach, describe, expect, it, vi } from 'vitest';

import { getRoom, listRoomDocuments, listRoomItems } from './rooms.js';

describe('rooms API client', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  it('lists room items via GET /v1/rooms/:id/items', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      Response.json({
        items: [{ shortId: 'd-abcd', kind: 'decision', body: 'Skjuta till Q3' }],
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await listRoomItems('room-shared-1');

    expect(result.items).toEqual([
      { shortId: 'd-abcd', kind: 'decision', body: 'Skjuta till Q3' },
    ]);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(String(fetchMock.mock.calls[0]![0])).toBe(
      'http://127.0.0.1:8787/v1/rooms/room-shared-1/items',
    );
  });

  it('lists room documents via GET /v1/rooms/:id/documents', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      Response.json({
        documents: [{ id: 'doc-1', filename: 'Offert Peab kök.pdf' }],
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await listRoomDocuments('room-shared-1');

    expect(result.documents).toEqual([{ id: 'doc-1', filename: 'Offert Peab kök.pdf' }]);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(String(fetchMock.mock.calls[0]![0])).toBe(
      'http://127.0.0.1:8787/v1/rooms/room-shared-1/documents',
    );
  });

  it('loads a room via GET /v1/rooms/:id', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      Response.json({
        room: {
          id: 'room-1',
          kind: 'shared',
          slug: 'ledning',
          title: 'Ledning',
          description: null,
          createdAt: '2026-09-15T00:00:00.000Z',
          archivedAt: null,
        },
        brief: {
          roomId: 'room-1',
          rendered: 'Beslut',
          tokenCount: 2,
          stale: false,
          builtAt: '2026-09-15T00:00:00.000Z',
        },
        members: [],
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await getRoom('room-1');
    expect(result.room.title).toBe('Ledning');
    expect(String(fetchMock.mock.calls[0]![0])).toBe('http://127.0.0.1:8787/v1/rooms/room-1');
  });
});
