import { afterEach, describe, expect, it, vi } from 'vitest';

import { forgetMemory, undoMemory } from './memory.js';

/**
 * Contract check: web soft-delete / undo must hit the same REST paths the
 * personal-room live path uses (DELETE /v1/memory/:shortId, POST /v1/memory/undo).
 */
describe('forgetMemory / undoMemory', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  it('soft-deletes via DELETE /v1/memory/:shortId with optional roomId', async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({
        item: { shortId: 'p-h58j', status: 'deleted' },
        undoToken: 'undo-token-1',
        daysRecoverable: 30,
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await forgetMemory('p-h58j', 'room-personal');

    expect(result.undoToken).toBe('undo-token-1');
    expect(result.daysRecoverable).toBe(30);
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe(
      'http://127.0.0.1:8787/v1/memory/p-h58j?roomId=room-personal',
    );
    expect(init).toMatchObject({ method: 'DELETE' });
  });

  it('restores via POST /v1/memory/undo with the undo token body', async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({ item: { shortId: 'p-h58j', status: 'active' } }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await undoMemory('undo-token-1');

    expect(result.item.status).toBe('active');
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe('http://127.0.0.1:8787/v1/memory/undo');
    expect(init).toMatchObject({ method: 'POST' });
    expect(JSON.parse(String(init?.body))).toEqual({ undoToken: 'undo-token-1' });
  });
});
