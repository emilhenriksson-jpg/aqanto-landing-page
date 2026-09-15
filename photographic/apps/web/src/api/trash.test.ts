import { afterEach, describe, expect, it, vi } from 'vitest';

import { listTrash, restoreTrash } from './trash.js';

/**
 * Contract check: trash list / restore hit GET /v1/trash and
 * POST /v1/trash/:shortId/restore — the same paths REST exposes.
 */
describe('listTrash / restoreTrash', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  it('lists via GET /v1/trash', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      Response.json({
        entries: [
          {
            shortId: 'p-old1',
            roomId: 'room-1',
            roomTitle: 'Ditt rum',
            kind: 'fact',
            body: 'Bor i Malmö',
            deletedAt: '2026-09-01T12:00:00.000Z',
            deletedByClient: 'claude-desktop',
            deleteReason: 'Flyttade',
            purgeAfter: '2026-10-01T12:00:00.000Z',
            daysRemaining: 28,
            type: 'memory',
            handle: 'p-old1',
          },
        ],
        retentionDays: 30,
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await listTrash();

    expect(result.retentionDays).toBe(30);
    const first = result.entries[0];
    expect(first?.type).toBe('memory');
    expect(first?.type === 'memory' ? first.shortId : null).toBe('p-old1');
    expect(fetchMock).toHaveBeenCalledOnce();
    const call = fetchMock.mock.calls[0]!;
    expect(String(call[0])).toBe('http://127.0.0.1:8787/v1/trash');
  });

  it('restores via POST /v1/trash/:handle/restore', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      Response.json({ type: 'memory', item: { shortId: 'p-old1', status: 'active' } }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await restoreTrash('p-old1', 'room-1');

    // Discriminated, so a caller cannot read `item` off a document restore by accident.
    expect(result.type).toBe('memory');
    expect(result.type === 'memory' ? result.item.status : null).toBe('active');
    expect(fetchMock).toHaveBeenCalledOnce();
    const call = fetchMock.mock.calls[0]!;
    expect(String(call[0])).toBe(
      'http://127.0.0.1:8787/v1/trash/p-old1/restore?roomId=room-1',
    );
    expect(call[1]).toMatchObject({ method: 'POST' });
  });
});
