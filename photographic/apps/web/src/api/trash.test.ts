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
          },
        ],
        retentionDays: 30,
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await listTrash();

    expect(result.retentionDays).toBe(30);
    expect(result.entries[0]?.shortId).toBe('p-old1');
    expect(fetchMock).toHaveBeenCalledOnce();
    const call = fetchMock.mock.calls[0]!;
    expect(String(call[0])).toBe('http://127.0.0.1:8787/v1/trash');
  });

  it('restores via POST /v1/trash/:shortId/restore', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      Response.json({ item: { shortId: 'p-old1', status: 'active' } }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await restoreTrash('p-old1', 'room-1');

    expect(result.item.status).toBe('active');
    expect(fetchMock).toHaveBeenCalledOnce();
    const call = fetchMock.mock.calls[0]!;
    expect(String(call[0])).toBe(
      'http://127.0.0.1:8787/v1/trash/p-old1/restore?roomId=room-1',
    );
    expect(call[1]).toMatchObject({ method: 'POST' });
  });
});
