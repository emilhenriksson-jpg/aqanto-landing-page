import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildClients } from '@photographic/connect/clients';
import { AppRoutes } from '../App.js';
import { ChatStart } from './ChatStart.js';

const clients = buildClients({ mcpUrl: 'https://memory.example/mcp', connectPageUrl: '/connect' });
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('conversation home', () => {
  it('opens with four AI choices and no room-selection requirement', () => {
    render(<MemoryRouter initialEntries={['/']}><AppRoutes /></MemoryRouter>);
    expect(screen.getByRole('heading', { name: 'Vad vill du prata om?' })).toBeInTheDocument();
    for (const name of ['ChatGPT', 'Codex', 'Cursor', 'Claude']) {
      expect(screen.getByRole('link', { name: `Öppna ${name}` })).toBeInTheDocument();
    }
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Ditt personliga rum/ })).toHaveAttribute('href', '/personligt');
    expect(screen.getAllByText('Ingen bekräftad leverans ännu.')).toHaveLength(4);
  });

  it('shows selectable text if clipboard permission is denied', async () => {
    vi.stubGlobal('navigator', { clipboard: { writeText: vi.fn().mockRejectedValue(new Error('denied')) } });
    render(<MemoryRouter><ChatStart /></MemoryRouter>);
    fireEvent.click(screen.getAllByRole('button', { name: 'Kopiera starttext' })[0]!);
    expect(await screen.findByRole('textbox', { name: 'Kopiera starttext' })).toHaveValue(clients[0]!.launch!.prompt);
  });

  it('does not turn an old delivery or an app click into a new delivery receipt', async () => {
    vi.stubEnv('VITE_USE_DEMO', '0');
    const request = vi.fn(async (url: string) => {
      if (url.endsWith('/v1/connect')) return Response.json({ clients });
      if (url.endsWith('/v1/clients')) return Response.json({ clients: [{ agentClient: 'codex', revoked: false, profileDelivered: true, lastSeenAt: '2026-09-01T10:00:00Z' }] });
      if (url.endsWith('/verify')) return Response.json({ handle: { clientId: 'codex' } });
      if (url.endsWith('/status')) return Response.json({ status: 'waiting' });
      throw new Error(url);
    });
    vi.stubGlobal('fetch', request);
    render(<MemoryRouter><ChatStart /></MemoryRouter>);
    const link = await screen.findByRole('link', { name: 'Öppna Codex' });
    // Prevent navigation out of jsdom while exercising the actual launch handler.
    link.addEventListener('click', (event) => event.preventDefault());
    fireEvent.click(link);
    await waitFor(() => expect(request.mock.calls.some(([url]) => url.endsWith('/status'))).toBe(true));
    expect(screen.queryByText('Ny kontext skickad till Codex.')).not.toBeInTheDocument();
    expect(screen.getByText(/Att appen öppnas betyder inte/)).toBeInTheDocument();
  });

  it('offers retry when the start data cannot be fetched', async () => {
    vi.stubEnv('VITE_USE_DEMO', '0');
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
    render(<MemoryRouter><ChatStart /></MemoryRouter>);
    expect(await screen.findByRole('button', { name: 'Försök igen' })).toBeInTheDocument();
    expect(screen.queryByText('Ingen bekräftad leverans ännu.')).not.toBeInTheDocument();
  });
});
