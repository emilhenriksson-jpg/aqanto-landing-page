import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { MemoryRow } from './MemoryRow.js';

const getProvenance = vi.fn();

vi.mock('../api/index.js', async () => {
  const actual = await vi.importActual<typeof import('../api/index.js')>('../api/index.js');
  return {
    ...actual,
    isDemoMode: () => false,
    getProvenance: (...args: unknown[]) => getProvenance(...args),
  };
});

/*
 * Against the wire shape rather than a fixture. This project has twice shipped a screen
 * that rendered because demo data was underneath it, so the mapping from what the API
 * actually returns is the part worth asserting.
 */
describe('Hur vet du det? against the API', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('asks the provenance endpoint for that memory, in that room, once opened', async () => {
    getProvenance.mockResolvedValue({
      shortId: 'r-8k2m',
      body: 'Vi beslutade att skjuta förvärvet till Q3',
      roomTitle: 'Buyersclub Ledning',
      savedAt: '2026-09-04T12:20:00.000Z',
      savedByClient: 'chatgpt-web',
      approvedByName: 'Emil',
      motivation: 'Hör till Buyersclub Ledning eftersom det nämner förvärvet.',
      source: { kind: 'document', label: 'styrelseunderlag-q3.pdf', ref: 'doc-1', uri: null },
      changed: true,
      timeline: [
        {
          seq: 44,
          action: 'saved',
          occurredAt: '2026-09-04T12:20:00.000Z',
          roomId: 'room-ledning',
          roomTitle: 'Buyersclub Ledning',
          shortId: 'r-8k2m',
          body: 'Vi beslutade att skjuta förvärvet till Q3',
          agentClient: 'chatgpt-web',
          actorName: 'Emil',
          wasApproved: true,
          redacted: false,
        },
      ],
    });

    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <ul>
          <MemoryRow
            item={{ shortId: 'r-8k2m', body: 'Vi beslutade att skjuta förvärvet till Q3' }}
            roomId="room-ledning"
            roomKind="shared"
          />
        </ul>
      </MemoryRouter>,
    );

    // Nothing is fetched until the question is asked: a profile of forty lines must not
    // make forty requests nobody wanted.
    expect(getProvenance).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Hur vet du det?' }));
    await waitFor(() => {
      expect(getProvenance).toHaveBeenCalledWith('r-8k2m', 'room-ledning');
    });

    expect(await screen.findByText('styrelseunderlag-q3.pdf')).toBeInTheDocument();
    expect(screen.getByText('ChatGPT')).toBeInTheDocument();
    expect(screen.getByText('Buyersclub Ledning (delat rum)')).toBeInTheDocument();
    expect(screen.getByText('Ja, du sa ja till det')).toBeInTheDocument();
    expect(screen.getByText('Ja, det har korrigerats')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Öppna originalkällan' })).toHaveAttribute(
      'href',
      '/kalender/handelse/44',
    );
  });

  it('stays calm when the answer cannot be fetched', async () => {
    getProvenance.mockRejectedValue(new Error('nej'));

    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <ul>
          <MemoryRow item={{ shortId: 'p-h58j', body: 'Emil, 34' }} roomId="room-1" />
        </ul>
      </MemoryRouter>,
    );

    await user.click(screen.getByRole('button', { name: 'Hur vet du det?' }));
    expect(await screen.findByText('Kunde inte hämta just nu.')).toBeInTheDocument();
  });
});
