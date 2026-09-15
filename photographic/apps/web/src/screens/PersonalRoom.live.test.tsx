import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { loadRoom } from '../data/demo.js';
import { PersonalRoom } from './PersonalRoom.js';

const forgetMemory = vi.fn();
const undoMemory = vi.fn();

vi.mock('../api/index.js', async () => {
  const actual = await vi.importActual<typeof import('../api/index.js')>('../api/index.js');
  return {
    ...actual,
    isDemoMode: () => false,
    forgetMemory: (...args: unknown[]) => forgetMemory(...args),
    undoMemory: (...args: unknown[]) => undoMemory(...args),
  };
});

vi.mock('../hooks/useRoomData.js', () => ({
  useRoomData: (key: string, demo: () => unknown) => {
    if (typeof key === 'string' && key.startsWith('documents:')) {
      return { status: 'ready' as const, data: demo() };
    }
    const room = loadRoom('personal');
    if (!room) throw new Error('Missing personal room in demo data');
    return { status: 'ready' as const, data: room };
  },
}));

function renderPersonalRoom() {
  return render(
    <MemoryRouter initialEntries={['/']}>
      <Routes>
        <Route path="/" element={<PersonalRoom />} />
        <Route path="/papperskorg" element={<div>trash</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('PersonalRoom live forget / undo', () => {
  beforeEach(() => {
    forgetMemory.mockReset();
    undoMemory.mockReset();
    forgetMemory.mockResolvedValue({
      item: { shortId: 'p-h58j', status: 'deleted' },
      undoToken: 'undo-live-1',
      daysRecoverable: 30,
    });
    undoMemory.mockResolvedValue({
      item: { shortId: 'p-h58j', status: 'active' },
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('calls forgetMemory then undoMemory on Ta bort / Ångra', async () => {
    const user = userEvent.setup();
    renderPersonalRoom();

    await user.click(screen.getByRole('button', { name: 'Ta bort p-h58j' }));
    expect(screen.getByText('Borttaget')).toBeInTheDocument();

    await waitFor(() => {
      expect(forgetMemory).toHaveBeenCalledWith('p-h58j', 'personal');
    });

    await user.click(screen.getByRole('button', { name: 'Ångra' }));
    await waitFor(() => {
      expect(undoMemory).toHaveBeenCalledWith('undo-live-1');
    });
    expect(screen.getByText(/Emil, 34/)).toBeInTheDocument();
  });

  it('waits for an in-flight forget before undoing', async () => {
    let resolveForget!: (value: {
      item: { shortId: string; status: string };
      undoToken: string;
      daysRecoverable: number;
    }) => void;
    forgetMemory.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveForget = resolve;
        }),
    );

    const user = userEvent.setup();
    renderPersonalRoom();

    await user.click(screen.getByRole('button', { name: 'Ta bort p-h58j' }));
    await user.click(screen.getByRole('button', { name: 'Ångra' }));

    expect(undoMemory).not.toHaveBeenCalled();

    resolveForget({
      item: { shortId: 'p-h58j', status: 'deleted' },
      undoToken: 'undo-after-wait',
      daysRecoverable: 30,
    });

    await waitFor(() => {
      expect(undoMemory).toHaveBeenCalledWith('undo-after-wait');
    });
  });
});
