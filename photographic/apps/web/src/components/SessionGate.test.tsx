import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { SessionGate } from './SessionGate.js';

const getAccount = vi.fn();

vi.mock('../api/index.js', async () => {
  const actual = await vi.importActual<typeof import('../api/index.js')>('../api/index.js');
  return {
    ...actual,
    getAccount: () => getAccount(),
    isDemoMode: () => false,
  };
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  window.history.replaceState({}, '', '/');
});

describe('SessionGate', () => {
  it('sends a visitor with no browser session to the one public start page', async () => {
    const replace = vi.fn();
    window.history.replaceState({}, '', '/rum');
    vi.spyOn(window, 'location', 'get').mockReturnValue({ ...window.location, replace });
    getAccount.mockRejectedValue({ status: 401 });

    render(<SessionGate><p>Skyddat innehåll</p></SessionGate>);

    expect(await screen.findByText('Tar dig till inloggningen…')).toBeInTheDocument();
    await waitFor(() =>
      expect(replace).toHaveBeenCalledWith('/start?fran=%2Frum&orsak=utgangen'),
    );
    expect(screen.queryByText('Skyddat innehåll')).toBeNull();
  });
});
