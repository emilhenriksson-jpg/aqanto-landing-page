import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { DocumentsSection } from './DocumentsSection.js';

describe('DocumentsSection', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  it('renders an optional documents prop without fetching', () => {
    render(
      <DocumentsSection
        documents={[
          { id: 'doc-prop-1', title: 'Offert Peab kök.pdf', meta: 'Dokument' },
        ]}
      />,
    );

    expect(screen.getByRole('heading', { level: 2, name: 'Dokument' })).toBeInTheDocument();
    expect(screen.getByText('Offert Peab kök.pdf')).toBeInTheDocument();
    expect(screen.getByText('Dokument', { selector: '.meta' })).toBeInTheDocument();
  });

  it('shows demo rows when roomId is given in demo mode', () => {
    vi.stubEnv('VITE_USE_DEMO', '1');
    render(<DocumentsSection roomId="personal" />);

    expect(screen.getByText('Vaccinationskort Vera')).toBeInTheDocument();
  });

  it('loads via GET /v1/rooms/:id/documents when VITE_USE_DEMO=0', async () => {
    vi.stubEnv('VITE_USE_DEMO', '0');
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      Response.json({
        documents: [
          {
            id: 'doc-live-1',
            filename: 'Styrelseunderlag juni.pdf',
            mimeType: 'application/pdf',
            byteSize: 1_258_291,
            byteSizeLabel: '1,2 MB',
            createdAt: '2026-09-14T10:00:00.000Z',
            extraction: 'extracted',
            extractionError: null,
            warnings: [],
            pageCount: 12,
            chunkCount: 9,
            searchable: true,
            summary: null,
          },
        ],
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    render(<DocumentsSection roomId="room-live-1" />);

    expect(screen.getByText('Hämtar dokument…')).toBeInTheDocument();

    await waitFor(() => {
      expect(screen.getByText('Styrelseunderlag juni.pdf')).toBeInTheDocument();
    });
    // Size and pages, and — when it applies — that the file is not searchable. A row
    // that reads like every other one hides a scan the AI cannot read.
    expect(screen.getByText('12 sidor · 1,2 MB', { selector: '.meta' })).toBeInTheDocument();
    const call = fetchMock.mock.calls[0]!;
    expect(String(call[0])).toBe('http://127.0.0.1:8787/v1/rooms/room-live-1/documents');
  });
});

describe('uploading a document into a room', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  const pdf = () =>
    new File([new Uint8Array([0x25, 0x50, 0x44, 0x46])], 'protokoll.pdf', {
      type: 'application/pdf',
    });

  function liveFetch(uploadResponse: () => Response) {
    let uploads = 0;
    return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if ((init?.method ?? 'GET') === 'POST') {
        uploads += 1;
        return uploadResponse();
      }
      return Response.json({
        documents:
          uploads === 0
            ? []
            : [
                {
                  id: 'doc-new',
                  filename: 'protokoll.pdf',
                  mimeType: 'application/pdf',
                  byteSize: 816,
                  byteSizeLabel: '816 B',
                  createdAt: '2026-09-15T09:00:00.000Z',
                  extraction: 'extracted',
                  extractionError: null,
                  warnings: [],
                  pageCount: 1,
                  chunkCount: 1,
                  searchable: true,
                  summary: null,
                },
              ],
      });
    });
  }

  it('offers no upload control in demo mode', () => {
    vi.stubEnv('VITE_USE_DEMO', '1');
    render(<DocumentsSection roomId="personal" />);

    expect(screen.queryByRole('button', { name: 'Lägg till dokument' })).not.toBeInTheDocument();
  });

  it('sends the file as multipart and lets the browser set the boundary', async () => {
    // Setting content-type by hand on a FormData body omits the boundary and produces a
    // request the server cannot parse, with an error that says nothing about why.
    vi.stubEnv('VITE_USE_DEMO', '0');
    const fetchMock = liveFetch(() =>
      Response.json(
        {
          document: {
            id: 'doc-new',
            filename: 'protokoll.pdf',
            byteSizeLabel: '816 B',
            searchable: true,
          },
          extraction: 'extracted',
          chunkCount: 1,
        },
        { status: 201 },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    render(<DocumentsSection roomId="room-1" />);
    await waitFor(() => expect(screen.getByText('Inga dokument ännu.')).toBeInTheDocument());

    const input = screen.getByLabelText('Välj en fil att lägga i rummet') as HTMLInputElement;
    await userEvent.upload(input, pdf());

    await waitFor(() => {
      expect(screen.getByRole('status')).toHaveTextContent('sparad och sökbar');
    });

    const post = fetchMock.mock.calls.find((call) => call[1]?.method === 'POST')!;
    expect(String(post[0])).toBe('http://127.0.0.1:8787/v1/rooms/room-1/documents');
    expect(post[1]?.body).toBeInstanceOf(FormData);
    expect((post[1]?.headers as Record<string, string>)['content-type']).toBeUndefined();
  });

  it('keeps the confirmation visible after the shelf reloads', async () => {
    // The message and the reloaded shelf have to coexist. When the message lived inside
    // the shelf, the reload remounted it and the confirmation vanished within a frame —
    // which matters most in the one case worth reading: "saved, but we could not read
    // any text out of it".
    vi.stubEnv('VITE_USE_DEMO', '0');
    vi.stubGlobal(
      'fetch',
      liveFetch(() =>
        Response.json(
          {
            document: { id: 'doc-new', filename: 'protokoll.pdf', searchable: true },
            extraction: 'extracted',
            chunkCount: 1,
          },
          { status: 201 },
        ),
      ),
    );

    render(<DocumentsSection roomId="room-1" />);
    await waitFor(() => expect(screen.getByText('Inga dokument ännu.')).toBeInTheDocument());

    await userEvent.upload(
      screen.getByLabelText('Välj en fil att lägga i rummet') as HTMLInputElement,
      pdf(),
    );

    // Still there once the reloaded shelf has landed. The reload passes through a
    // loading render, and the message used to live inside the shelf — so that render
    // remounted it and the confirmation was gone. A mocked fetch resolves too fast to
    // catch the intermediate frame, so this asserts the outcome rather than the timing.
    await waitFor(() => expect(screen.getByText('protokoll.pdf')).toBeInTheDocument());
    expect(screen.getByRole('status')).toHaveTextContent('sparad och sökbar');
  });

  it('reloads the shelf from the server after an upload', async () => {
    // Rather than pushing the new row in locally: whether a document is searchable is
    // decided by extraction on the server, and guessing it here would show a row that
    // says something different from the truth.
    vi.stubEnv('VITE_USE_DEMO', '0');
    vi.stubGlobal(
      'fetch',
      liveFetch(() =>
        Response.json(
          {
            document: { id: 'doc-new', filename: 'protokoll.pdf', searchable: true },
            extraction: 'extracted',
            chunkCount: 1,
          },
          { status: 201 },
        ),
      ),
    );

    render(<DocumentsSection roomId="room-1" />);
    await waitFor(() => expect(screen.getByText('Inga dokument ännu.')).toBeInTheDocument());

    await userEvent.upload(
      screen.getByLabelText('Välj en fil att lägga i rummet') as HTMLInputElement,
      pdf(),
    );

    await waitFor(() => {
      expect(screen.getByText('protokoll.pdf')).toBeInTheDocument();
    });
  });

  it('says the file is saved but unreadable rather than calling it a failure', async () => {
    // A scanned PDF is a normal thing to be handed. Reporting it as an error would tell
    // the person their upload did not work, when the file is stored and downloadable.
    vi.stubEnv('VITE_USE_DEMO', '0');
    vi.stubGlobal(
      'fetch',
      liveFetch(() =>
        Response.json(
          {
            document: { id: 'doc-scan', filename: 'inskannat.pdf', searchable: false },
            extraction: 'empty',
            chunkCount: 0,
          },
          { status: 201 },
        ),
      ),
    );

    render(<DocumentsSection roomId="room-1" />);
    await waitFor(() => expect(screen.getByText('Inga dokument ännu.')).toBeInTheDocument());

    await userEvent.upload(
      screen.getByLabelText('Välj en fil att lägga i rummet') as HTMLInputElement,
      pdf(),
    );

    await waitFor(() => {
      expect(screen.getByRole('status')).toHaveTextContent('kunde inte läsa ut text');
    });
    expect(screen.getByRole('status')).toHaveTextContent('sparad');
  });

  it('passes the storage-limit message straight through to the person', async () => {
    // "Det finns inte plats för X, du har 1,2 GB kvar" is written for the person and is
    // the whole value of the message. Replacing it with a generic failure loses it.
    vi.stubEnv('VITE_USE_DEMO', '0');
    vi.stubGlobal(
      'fetch',
      liveFetch(
        () =>
          Response.json(
            {
              error: {
                code: 'storage_limit_reached',
                message:
                  'Det finns inte plats för "protokoll.pdf" (816 B). Du använder 10 GB av 10 GB.',
              },
            },
            { status: 413 },
          ),
      ),
    );

    render(<DocumentsSection roomId="room-1" />);
    await waitFor(() => expect(screen.getByText('Inga dokument ännu.')).toBeInTheDocument());

    await userEvent.upload(
      screen.getByLabelText('Välj en fil att lägga i rummet') as HTMLInputElement,
      pdf(),
    );

    await waitFor(() => {
      expect(screen.getByRole('status')).toHaveTextContent('inte plats');
    });
  });
});
