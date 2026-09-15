import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FragaMittMinne } from './FragaMittMinne.js';

const askMemory = vi.fn();
const listRooms = vi.fn();

vi.mock('../api/index.js', async () => {
  const actual = await vi.importActual<typeof import('../api/index.js')>('../api/index.js');
  return {
    ...actual,
    isDemoMode: () => false,
    askMemory: (...args: unknown[]) => askMemory(...args),
    listRooms: (...args: unknown[]) => listRooms(...args),
  };
});

function renderScreen() {
  return render(
    <MemoryRouter initialEntries={['/fraga']}>
      <Routes>
        <Route path="/fraga" element={<FragaMittMinne />} />
        <Route path="/" element={<div>personligt rum</div>} />
        <Route path="/rum/:roomId" element={<div>delat rum</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('Fråga mitt minne — live', () => {
  beforeEach(() => {
    askMemory.mockReset();
    listRooms.mockReset();
    listRooms.mockResolvedValue({ rooms: [{ roomId: 'room-personal', kind: 'personal' }] });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('calls the search API with the typed question and shows what came back', async () => {
    askMemory.mockResolvedValue({
      hits: [
        {
          kind: 'memory',
          roomId: 'room-shared',
          roomTitle: 'Buyersclub Ledning',
          text: 'Vi beslutade att skjuta förvärvet till Q3',
          score: 1,
          occurredAt: '2026-09-14T09:00:00Z',
          shortId: 'p-aaaa',
          documentId: null,
          seq: null,
          action: null,
        },
      ],
    });

    const user = userEvent.setup();
    renderScreen();

    await user.type(screen.getByRole('searchbox', { name: 'Fråga mitt minne' }), 'förvärvet');
    await user.click(screen.getByRole('button', { name: 'Sök' }));

    await waitFor(() => {
      expect(askMemory).toHaveBeenCalledWith({ query: 'förvärvet' });
    });
    expect(screen.getByText('Buyersclub Ledning')).toBeInTheDocument();
    expect(screen.getByText('p-aaaa')).toBeInTheDocument();

    // The shared room's real id, not the demo one — the link still points somewhere real.
    const link = screen.getByText(/skjuta förvärvet till Q3/).closest('a');
    expect(link).toHaveAttribute('href', '/rum/room-shared');
  });

  it('sends a since bound when a quick date range is picked, with no query required', async () => {
    askMemory.mockResolvedValue({ hits: [] });

    const user = userEvent.setup();
    renderScreen();

    await user.click(screen.getByRole('button', { name: 'Idag' }));

    await waitFor(() => {
      expect(askMemory).toHaveBeenCalledWith(expect.objectContaining({ since: expect.any(String) }));
    });
    expect(askMemory.mock.calls[0]?.[0]).not.toHaveProperty('query');
  });

  it('renders a calendar hit with its date and action, not a short id, linked to the personal room', async () => {
    askMemory.mockResolvedValue({
      hits: [
        {
          kind: 'event',
          roomId: 'room-personal',
          roomTitle: 'Ditt rum',
          text: 'Allergisk mot ketchup',
          score: 1,
          occurredAt: new Date().toISOString(),
          shortId: 'p-bbbb',
          documentId: null,
          seq: 7,
          action: 'saved',
        },
      ],
    });

    const user = userEvent.setup();
    renderScreen();

    await user.click(screen.getByRole('button', { name: 'Idag' }));

    await waitFor(() => {
      expect(screen.getByText(/sparade/)).toBeInTheDocument();
    });
    // The personal room's real id (from listRooms) resolves to "/", not "/rum/room-personal".
    const link = screen.getByText('Allergisk mot ketchup').closest('a');
    expect(link).toHaveAttribute('href', '/');
  });

  it('shows a calm message when the request fails', async () => {
    askMemory.mockRejectedValue(new Error('boom'));

    const user = userEvent.setup();
    renderScreen();

    await user.type(screen.getByRole('searchbox', { name: 'Fråga mitt minne' }), 'förvärvet');
    await user.click(screen.getByRole('button', { name: 'Sök' }));

    await waitFor(() => {
      expect(screen.getByText(/Kunde inte hämta/)).toBeInTheDocument();
    });
  });
});
