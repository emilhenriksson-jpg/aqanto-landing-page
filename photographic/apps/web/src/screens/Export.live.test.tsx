import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Export } from './Export.js';

const listExports = vi.fn();
const requestExport = vi.fn();
const getExport = vi.fn();
const createExportLink = vi.fn();

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
    listExports: () => listExports(),
    requestExport: () => requestExport(),
    getExport: (id: string) => getExport(id),
    createExportLink: (id: string) => createExportLink(id),
  };
});

function job(overrides: Record<string, unknown> = {}) {
  return {
    id: 'exp-1',
    scope: 'own',
    status: 'pending',
    byteSize: null,
    byteSizeLabel: null,
    counts: { events: null, items: null, documents: null },
    requestedAt: '2026-09-15T14:32:00.000Z',
    finishedAt: null,
    expiresAt: '2026-09-22T14:32:00.000Z',
    error: null,
    ...overrides,
  };
}

function renderExport() {
  return render(
    <MemoryRouter initialEntries={['/konto/export']}>
      <Export />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  listExports.mockResolvedValue({ exports: [] });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('Export', () => {
  /**
   * The scope is a decision, not an implementation detail: the archive is the person's own
   * writing including their contributions to shared rooms, and deliberately not the other
   * members' notes. If the screen stops saying so, the export quietly becomes a surprise.
   */
  it('says what the archive contains before it is asked for', async () => {
    renderExport();

    expect(await screen.findByText(/Inte de andras anteckningar/)).toBeInTheDocument();
    expect(screen.getByText(/Hela ditt privata rum/)).toBeInTheDocument();
    expect(screen.getByText(/Dina uppladdade dokument i original/)).toBeInTheDocument();
    expect(screen.getByText(/får en händelse i loggen/)).toBeInTheDocument();
  });

  it('requests an export and says it is being built rather than pretending it is done', async () => {
    const user = userEvent.setup();
    requestExport.mockResolvedValue({ export: job() });

    renderExport();
    await user.click(await screen.findByRole('button', { name: 'Begär export' }));

    expect(requestExport).toHaveBeenCalledTimes(1);
    expect(await screen.findByText('Förbereds…', { selector: 'p' })).toBeInTheDocument();
    expect(screen.getByText(/Arkivet byggs i bakgrunden/)).toBeInTheDocument();
    // No fabricated zero counts while the job has not run.
    expect(screen.queryByText(/0 händelser/)).toBeNull();
  });

  it('shows what a finished archive holds, and mints the link on demand', async () => {
    const user = userEvent.setup();
    const assign = vi.fn();
    vi.spyOn(window, 'location', 'get').mockReturnValue({
      ...window.location,
      assign,
    } as unknown as Location);

    listExports.mockResolvedValue({
      exports: [
        job({
          status: 'ready',
          byteSize: 4_200_000,
          byteSizeLabel: '4,2 MB',
          counts: { events: 1234, items: 87, documents: 3 },
          finishedAt: '2026-09-15T14:33:00.000Z',
        }),
      ],
    });
    createExportLink.mockResolvedValue({
      url: 'https://mcp.photographic.space/v1/export/download/pgm_dl_x',
      expiresAt: '2026-09-22T14:33:00.000Z',
    });

    renderExport();

    expect(await screen.findByText('Klar att hämta')).toBeInTheDocument();
    expect(screen.getByText(/1 234 händelser · 87 minnen · 3 dokument · 4,2 MB/)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Hämta arkivet' }));

    await waitFor(() => expect(createExportLink).toHaveBeenCalledWith('exp-1'));
    expect(assign).toHaveBeenCalledWith(
      'https://mcp.photographic.space/v1/export/download/pgm_dl_x',
    );
  });

  it('reports a failure as itself rather than as an empty list', async () => {
    listExports.mockResolvedValue({
      exports: [job({ status: 'failed', error: 'Något gick fel under bygget.' })],
    });

    renderExport();

    expect(await screen.findByText('Exporten misslyckades')).toBeInTheDocument();
    expect(screen.getByText(/Något gick fel under bygget/)).toBeInTheDocument();
  });
});
