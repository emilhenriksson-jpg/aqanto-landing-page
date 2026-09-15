import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { StorageMeter } from './StorageMeter.js';

/** `GET /v1/storage`, as the API serialises it. */
function storage(fraction: number) {
  const limitBytes = 10 * 1024 * 1024 * 1024;
  const bytesUsed = Math.round(limitBytes * fraction);
  return Response.json({
    storage: {
      bytesUsed,
      limitBytes,
      objectCount: 4,
      usedLabel: `${(bytesUsed / 1024 ** 3).toFixed(1).replace('.', ',')} GB`,
      limitLabel: '10 GB',
      remainingLabel: `${((limitBytes - bytesUsed) / 1024 ** 3).toFixed(1).replace('.', ',')} GB`,
      fraction,
    },
  });
}

describe('StorageMeter', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  it('stays out of the way while there is plenty of room', async () => {
    // A storage bar for someone using a fraction of a percent is an anxiety generator
    // about a number that will not matter for years — and this product is asking people
    // to trust it with decades, which is the opposite feeling.
    vi.stubEnv('VITE_USE_DEMO', '0');
    vi.stubGlobal('fetch', vi.fn(async () => storage(0.008)));

    render(<StorageMeter />);

    await waitFor(() => {
      expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
    });
  });

  it('appears once a fifth of the limit is used', async () => {
    vi.stubEnv('VITE_USE_DEMO', '0');
    vi.stubGlobal('fetch', vi.fn(async () => storage(0.42)));

    render(<StorageMeter />);

    const bar = await screen.findByRole('progressbar');
    expect(bar).toHaveAttribute('aria-valuenow', '42');
    expect(bar).toHaveAttribute('aria-valuetext', expect.stringContaining('av 10 GB'));
  });

  it('turns into a warning with a way out when nearly full', async () => {
    vi.stubEnv('VITE_USE_DEMO', '0');
    vi.stubGlobal('fetch', vi.fn(async () => storage(0.96)));

    render(<StorageMeter />);

    await screen.findByRole('progressbar');
    // Says what is left and what to do about it, rather than only that it is nearly full.
    expect(screen.getByText(/kvar av 10 GB/)).toBeInTheDocument();
    expect(screen.getByText(/Ta bort något|mer plats/)).toBeInTheDocument();
  });

  it('asks for nothing in demo mode', () => {
    vi.stubEnv('VITE_USE_DEMO', '1');
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    render(<StorageMeter />);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
  });

  it('stays silent when the figure cannot be loaded', async () => {
    // A storage number failing is not worth an error on a screen someone opened to read
    // their own memories.
    vi.stubEnv('VITE_USE_DEMO', '0');
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 500 })));

    render(<StorageMeter />);

    await waitFor(() => {
      expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
    });
    expect(screen.queryByText(/Lagring/)).not.toBeInTheDocument();
  });
});
