import { render, screen, waitFor } from '@testing-library/react';
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
    const fetchMock = vi.fn(async () =>
      Response.json({
        documents: [{ id: 'doc-live-1', filename: 'Styrelseunderlag juni.pdf' }],
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    render(<DocumentsSection roomId="room-live-1" />);

    expect(screen.getByText('Hämtar dokument…')).toBeInTheDocument();

    await waitFor(() => {
      expect(screen.getByText('Styrelseunderlag juni.pdf')).toBeInTheDocument();
    });
    expect(screen.getByText('Dokument', { selector: '.meta' })).toBeInTheDocument();
    expect(String(fetchMock.mock.calls[0]![0])).toBe(
      'http://127.0.0.1:8787/v1/rooms/room-live-1/documents',
    );
  });
});
