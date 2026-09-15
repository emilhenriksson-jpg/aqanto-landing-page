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
    expect(screen.getByText('Ja, det har sagt något annat tidigare')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Öppna originalkällan' })).toHaveAttribute(
      'href',
      '/kalender/handelse/44',
    );
  });

  /*
   * `embedding` arrives with `0016_embedding_provenance`. It is the part of "hur vet du
   * det om mig?" a person cannot find out any other way, and the part the answer is
   * least entitled to guess at.
   */
  it('reads out which model has seen the text, when the server recorded it', async () => {
    getProvenance.mockResolvedValue({
      shortId: 'p-h58j',
      body: 'Allergisk mot ketchup',
      roomTitle: 'Mitt rum',
      savedAt: '2026-09-02T09:14:00.000Z',
      savedByClient: 'claude-desktop',
      approvedByName: null,
      motivation: 'Sparat privat eftersom det handlar om dig.',
      source: { kind: 'conversation', label: 'Samtal med Claude', ref: 'sess-1', uri: null },
      changed: false,
      embedding: {
        provider: 'openai',
        model: 'text-embedding-3-small',
        external: true,
        at: '2026-09-02T09:14:02.000Z',
      },
      timeline: [],
    });

    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <ul>
          <MemoryRow item={{ shortId: 'p-h58j', body: 'Allergisk mot ketchup' }} roomId="room-1" />
        </ul>
      </MemoryRouter>,
    );

    await user.click(screen.getByRole('button', { name: 'Hur vet du det?' }));
    expect(
      await screen.findByText(
        'Ja — skickad till OpenAI (text-embedding-3-small) 2 september 2026, för att kunna hittas på betydelse. Modellen tränas inte på den.',
      ),
    ).toBeInTheDocument();
  });

  it('answers no only when the server actually said the vector was computed here', async () => {
    getProvenance.mockResolvedValue({
      shortId: 'p-h58j',
      body: 'Allergisk mot ketchup',
      roomTitle: 'Mitt rum',
      savedAt: '2026-09-02T09:14:00.000Z',
      savedByClient: 'claude-desktop',
      approvedByName: null,
      motivation: null,
      source: null,
      changed: false,
      embedding: { provider: 'local', model: 'bag-of-words', external: false, at: '2026-09-02T09:14:02.000Z' },
      timeline: [],
    });

    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <ul>
          <MemoryRow item={{ shortId: 'p-h58j', body: 'Allergisk mot ketchup' }} roomId="room-1" />
        </ul>
      </MemoryRouter>,
    );

    await user.click(screen.getByRole('button', { name: 'Hur vet du det?' }));
    expect(
      await screen.findByText('Nej — sökindexet räknades ut här (bag-of-words).'),
    ).toBeInTheDocument();
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
