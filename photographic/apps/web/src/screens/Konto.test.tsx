import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { Konto } from './Konto.js';

const getDeletionState = vi.fn();

/**
 * `useRoomData` reads the demo flag from `api/config.js` directly, so a live test has to
 * flip it there as well as on the barrel it renders through.
 */
vi.mock('../api/config.js', async () => {
  const actual = await vi.importActual<typeof import('../api/config.js')>('../api/config.js');
  return { ...actual, isDemoMode: () => false };
});

vi.mock('../api/index.js', async () => {
  const actual = await vi.importActual<typeof import('../api/index.js')>('../api/index.js');
  return {
    ...actual,
    isDemoMode: () => false,
    getDeletionState: () => getDeletionState(),
  };
});

function renderKonto() {
  return render(
    <MemoryRouter initialEntries={['/konto']}>
      <Konto />
    </MemoryRouter>,
  );
}

afterEach(() => {
  vi.clearAllMocks();
});

describe('Konto', () => {
  it('is the caller export and deletion never had', async () => {
    getDeletionState.mockResolvedValue({ pending: null, freezeDays: 30, copy: {} });

    renderKonto();

    expect(await screen.findByRole('link', { name: /Ta med ditt minne/ })).toHaveAttribute(
      'href',
      '/konto/export',
    );
    expect(screen.getByRole('link', { name: /Radera konto/ })).toHaveAttribute(
      'href',
      '/konto/radera',
    );
  });

  it('tells a person their account is already on its way out', async () => {
    getDeletionState.mockResolvedValue({
      pending: { daysRemaining: 12, immediate: false },
      freezeDays: 30,
      copy: {},
    });

    renderKonto();

    expect(await screen.findByText(/Ditt konto raderas/)).toHaveTextContent('om 12 dagar');
  });
});
