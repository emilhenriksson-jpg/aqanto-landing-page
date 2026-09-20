import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { useConnectionCheck } from './useConnectionCheck.js';

afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

it('retries a failed check with the same baseline so a delivery during an outage is not lost', async () => {
  vi.stubEnv('VITE_USE_DEMO', '0');
  const handle = { clientId: 'chatgpt', startedAtMs: 100, baseline: {} };
  let fail = true;
  const request = vi.fn(async (url: string, _init?: RequestInit) => {
    if (url.endsWith('/verify')) return Response.json({ handle });
    if (fail) throw new Error('offline');
    return Response.json({ status: 'connected' });
  });
  vi.stubGlobal('fetch', request);
  const check = renderHook(() => useConnectionCheck('chatgpt'));
  act(() => check.result.current.start('setup'));
  await waitFor(() => expect(check.result.current.state).toBe('error'));
  fail = false;
  act(() => check.result.current.retry());
  await waitFor(() => expect(check.result.current.state).toBe('connected'));
  expect(request.mock.calls.filter(([url]) => url.endsWith('/verify'))).toHaveLength(1);
  const statusCalls = request.mock.calls.filter(([url]) => url.endsWith('/status'));
  for (const [, init] of statusCalls) expect(JSON.parse(init!.body as string)).toEqual({ handle });
});

it('does not start polling if the page was left before the baseline arrived', async () => {
  vi.stubEnv('VITE_USE_DEMO', '0');
  let resolve: (response: Response) => void = () => {};
  const request = vi.fn(() => new Promise<Response>(done => { resolve = done; }));
  vi.stubGlobal('fetch', request);
  const check = renderHook(() => useConnectionCheck('cursor'));
  act(() => check.result.current.start('setup'));
  check.unmount();
  await act(async () => { resolve(Response.json({ handle: {clientId: 'cursor'} })); });
  window.dispatchEvent(new Event('focus'));
  expect(request).toHaveBeenCalledTimes(1);
});
