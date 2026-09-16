import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SharedRoom } from './SharedRoom.js';

const getRoom = vi.fn();
const listRoomItems = vi.fn();
const listRoomDocuments = vi.fn();
const listHistory = vi.fn();

vi.mock('../api/config.js', async () => {
  const actual = await vi.importActual<typeof import('../api/config.js')>('../api/config.js');
  return { ...actual, isDemoMode: () => false };
});

vi.mock('../api/index.js', async () => {
  const actual = await vi.importActual<typeof import('../api/index.js')>('../api/index.js');
  return {
    ...actual,
    isDemoMode: () => false,
    getRoom: (id: string) => getRoom(id),
    listRoomItems: (id: string) => listRoomItems(id),
    listRoomDocuments: (id: string) => listRoomDocuments(id),
    listHistory: (options: unknown) => listHistory(options),
  };
});

const ROOM_ID = '9f1d5b7a-2c44-4d3e-9b8f-77b0c2a1e001';

function renderRoom() {
  return render(
    <MemoryRouter initialEntries={[`/rum/${ROOM_ID}`]}>
      <Routes>
        <Route path="/rum/:roomId" element={<SharedRoom />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  getRoom.mockResolvedValue({
    room: {
      id: ROOM_ID,
      kind: 'shared',
      slug: 'villan',
      title: 'Villan',
      description: 'Renoveringen',
      createdAt: '2026-05-01T10:00:00.000Z',
      archivedAt: null,
    },
    brief: { roomId: ROOM_ID, rendered: 'Renoveringen', tokenCount: 40, stale: false, builtAt: '' },
    members: [{ displayName: 'Emil', role: 'owner' }],
  });
  listRoomItems.mockResolvedValue({ items: [] });
  listRoomDocuments.mockResolvedValue({ documents: [] });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('SharedRoom activity — live', () => {
  /**
   * The feed used to read `DEMO_ACTIVITY[room.id]` with no flag check. The fixtures are
   * keyed by slug and a real room id is a UUID, so every real room reported "Ingen
   * aktivitet ännu" forever — a feature rendering as "nothing ever happened here".
   */
  it('reads the room’s own history rather than demo fixtures', async () => {
    listHistory.mockResolvedValue({
      entries: [
        {
          seq: 41,
          action: 'saved',
          occurredAt: new Date(Date.now() - 3 * 3_600_000).toISOString(),
          roomId: ROOM_ID,
          roomTitle: 'Villan',
          shortId: 'r-9x2k',
          body: 'Elektrikern heter Micke',
          agentClient: 'claude-desktop',
          actorName: 'Emil',
          wasApproved: true,
          redacted: false,
        },
      ],
    });

    renderRoom();

    expect(await screen.findByText(/Claude sparade Elektrikern heter Micke/)).toBeInTheDocument();
    expect(listHistory).toHaveBeenCalledWith({ room: ROOM_ID, limit: 12 });
    expect(screen.queryByText(/skjuta förvärvet till Q3/)).toBeNull();
  });

  it('says nothing has happened only when the log says so', async () => {
    listHistory.mockResolvedValue({ entries: [] });

    renderRoom();

    expect(await screen.findByText('Ingen aktivitet ännu.')).toBeInTheDocument();
  });

  /** A failing feed is context lost, not a room lost. */
  it('keeps the room on screen when the history call fails', async () => {
    listHistory.mockRejectedValue(new Error('nope'));

    renderRoom();

    expect(await screen.findByRole('heading', { level: 1, name: 'Villan' })).toBeInTheDocument();
    expect(await screen.findByText('Kunde inte hämta just nu.')).toBeInTheDocument();
  });
});
