import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildClients } from '@photographic/connect/clients';
import { AppRoutes } from '../App.js';
import { rememberChatChoice } from '../data/chat-choice.js';
import { ChatStart } from './ChatStart.js';

const clients = buildClients({ mcpUrl: 'https://memory.example/mcp', connectPageUrl: '/connect' });
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks(); localStorage.clear(); });

describe('conversation home', () => {
  it('opens with four AI choices and no room-selection requirement', () => {
    render(<MemoryRouter initialEntries={['/']}><AppRoutes /></MemoryRouter>);
    expect(screen.getByRole('heading', { name: 'Hej, Emil.' })).toBeInTheDocument();
    for (const name of ['ChatGPT', 'Codex', 'Cursor', 'Claude']) {
      expect(screen.getByRole('link', { name: `Öppna ${name}` })).toBeInTheDocument();
    }
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Ditt personliga rum/ })).toHaveAttribute('href', '/personligt');
    for (const status of screen.getAllByText(/Ingen bekräftad koppling ännu/)) expect(status).toBeVisible();
    expect(screen.getByText('Koppla ChatGPT till Photographic')).toBeVisible();
    expect(screen.getByText('Välj Photographic i den nya chattens verktygsmeny innan du börjar prata.')).toBeVisible();
  });

  it('keeps the Mac app handoff on the user click and offers the web separately', () => {
    vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X)', maxTouchPoints: 0 });
    render(<MemoryRouter><ChatStart /></MemoryRouter>);
    const link = screen.getByRole('link', { name: 'Öppna ChatGPT' });
    const chatgptUrl = new URL(link.getAttribute('href')!);
    const codexUrl = new URL(screen.getByRole('link', { name: 'Öppna Codex' }).getAttribute('href')!);
    expect(chatgptUrl.protocol + '//' + chatgptUrl.host + chatgptUrl.pathname).toBe('codex://threads/new');
    expect(chatgptUrl.searchParams.get('mode')).toBe('chat');
    expect(codexUrl.searchParams.get('mode')).toBe('codex');
    expect([...chatgptUrl.searchParams.keys()].sort()).toEqual(['mode']);
    expect(codexUrl.searchParams.has('prompt')).toBe(false);
    expect(link).not.toHaveAttribute('target');
    fireEvent.click(screen.getByText('Hjälp med ChatGPT'));
    expect(screen.getAllByRole('link', { name: 'Öppna i webbläsaren' }).some((entry) => entry.getAttribute('href') === 'https://chatgpt.com/?no_universal_links=1')).toBe(true);
  });

  it.each([
    ['iPhone; CPU iPhone OS 18_0 like Mac OS X', 5, 'https://chatgpt.com/?q='],
    ['Mozilla/5.0 (Macintosh; Intel Mac OS X)', 5, 'https://chatgpt.com/?q='],
    ['Mozilla/5.0 (Linux; Android 14)', 5, 'intent://chatgpt.com/?q='],
  ])('uses mobile launches for %s even if the server sent desktop descriptors', (userAgent, maxTouchPoints, prefix) => {
    vi.stubGlobal('navigator', { userAgent, maxTouchPoints });
    render(<MemoryRouter><ChatStart /></MemoryRouter>);
    expect(screen.getByRole('link', { name: 'Öppna ChatGPT' }).getAttribute('href')).toContain(prefix);
    expect(screen.getByRole('link', { name: 'Öppna ChatGPT' })).not.toHaveAttribute('target');
    expect(screen.queryByRole('link', { name: 'Öppna Codex' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Öppna Cursor' })).not.toBeInTheDocument();
    for (const button of screen.getAllByRole('button', { name: 'Öppna på datorn' })) expect(button).toBeDisabled();
  });

  it('shows selectable text if clipboard permission is denied', async () => {
    vi.stubGlobal('navigator', { clipboard: { writeText: vi.fn().mockRejectedValue(new Error('denied')) } });
    render(<MemoryRouter><ChatStart /></MemoryRouter>);
    const setup = screen.getByText('Koppla ChatGPT till Photographic');
    fireEvent.click(setup);
    fireEvent.click(within(setup.closest('details')!).getByRole('button', { name: 'Kopiera kontrollfrågan' }));
    expect(await screen.findByRole('textbox', { name: 'Kopiera kontrollfrågan' })).toHaveValue(clients.find(client => client.id === 'chatgpt')!.verifyPrompt);
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
    expect(screen.queryByText('Ditt minne har skickats till Codex.')).not.toBeInTheDocument();
    expect(screen.getByText('Väntar på att Codex hämtar ditt minne.')).toBeInTheDocument();
    expect(screen.getByText(/Det bekräftar inte kopplingen i en ny chatt/)).toBeVisible();
  });

  it('offers retry when the start data cannot be fetched', async () => {
    vi.stubEnv('VITE_USE_DEMO', '0');
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
    render(<MemoryRouter><ChatStart /></MemoryRouter>);
    expect(await screen.findByRole('button', { name: 'Försök igen' })).toBeInTheDocument();
    expect(screen.queryByText('Ingen bekräftad leverans ännu.')).not.toBeInTheDocument();
  });

  it.each(['connected', 'timed_out'])('reports the result of a real verification check: %s', async (status) => {
    vi.stubEnv('VITE_USE_DEMO', '0');
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.endsWith('/v1/connect')) return Response.json({ clients });
      if (url.endsWith('/v1/clients')) return Response.json({ clients: [] });
      if (url.endsWith('/verify')) return Response.json({ handle: { clientId: 'chatgpt' } });
      if (url.endsWith('/status')) return Response.json({ status });
      throw new Error(url);
    }));
    render(<MemoryRouter><ChatStart /></MemoryRouter>);
    const setup = await screen.findByText('Koppla ChatGPT till Photographic');
    fireEvent.click(setup);
    expect(within(setup.closest('details')!).getByRole('link', { name: 'Öppna ChatGPTs pluginsida' })).toHaveAttribute('href', 'https://chatgpt.com/plugins');
    fireEvent.click(within(setup.closest('details')!).getByRole('button', { name: 'Kontrollera kopplingen' }));
    expect(await screen.findByText(status === 'connected'
      ? 'ChatGPT har hämtat ditt minne. Kvittot gäller appen; vi kan inte avgöra vilken chatt som hämtade det.'
      : 'Ingen ny hämtning bekräftad. Välj Photographic i chatten och be din AI hämta ditt minne med kontrollfrågan nedan.')).toBeVisible();
  });
});

function home() { return render(<MemoryRouter><ChatStart /></MemoryRouter>); }

it('remembers only a clicked AI, keeps the click layout stable, and brings it first next visit', () => {
  const view = home();
  const link = screen.getByRole('link', { name: 'Öppna Claude' });
  link.addEventListener('click', event => event.preventDefault());
  fireEvent.click(link);
  expect(screen.queryByText('Senast vald här')).not.toBeInTheDocument();
  view.unmount(); home();
  const choices = within(screen.getByRole('region', { name: 'Öppna en chatt' }));
  expect(choices.getAllByRole('heading')[0]).toHaveTextContent('Claude');
  expect(choices.getByText('Senast vald här')).toBeInTheDocument();
  expect(screen.queryByText('Ditt minne har skickats till Claude.')).not.toBeInTheDocument();
});

it('keeps mobile apps first when the last device choice needs a desktop', () => {
  rememberChatChoice('codex');
  vi.stubGlobal('navigator', { userAgent: 'iPhone', maxTouchPoints: 5 });
  home();
  expect(within(screen.getByRole('region', { name: 'Öppna en chatt' })).getAllByRole('heading')
    .map(heading => heading.textContent)).toEqual(['ChatGPT', 'Claude', 'Codex', 'Cursor']);
  expect(screen.queryByText('Senast vald här')).not.toBeInTheDocument();
});

it('still opens an AI if storage is blocked, without touching the clipboard', () => {
  vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('denied'); });
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('denied'); });
  const writeText = vi.fn();
  vi.stubGlobal('navigator', { userAgent: 'iPhone', maxTouchPoints: 5, clipboard: { writeText } });
  home();
  const link = screen.getByRole('link', { name: 'Öppna ChatGPT' });
  link.addEventListener('click', event => event.preventDefault());
  fireEvent.click(link);
  expect(link).toHaveAttribute('href', expect.stringContaining('https://chatgpt.com/?q='));
  expect(writeText).not.toHaveBeenCalled();
  expect(screen.queryByRole('button', {name: 'Kopiera hälsning'})).not.toBeInTheDocument();
});

it('does not make optional account or receipt failures block the start or invent a name', async () => {
  vi.stubEnv('VITE_USE_DEMO', '0');
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url.endsWith('/v1/connect')) return Response.json({ clients });
    throw new Error('unavailable');
  }));
  home();
  expect(await screen.findByRole('link', { name: 'Öppna ChatGPT' })).toBeInTheDocument();
  expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Hej.');
  expect(screen.getAllByText(/Kopplingen kunde inte kontrolleras/)[0]).toBeVisible();
  expect(screen.queryByText(/Ingen bekräftad leverans ännu/)).not.toBeInTheDocument();
});

it('does not wait for a slow optional account read before offering app launches', async () => {
  vi.stubEnv('VITE_USE_DEMO', '0');
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url.endsWith('/v1/connect')) return Response.json({ clients });
    return new Promise<Response>(() => {});
  }));
  home();
  expect(await screen.findByRole('link', { name: 'Öppna ChatGPT' })).toBeInTheDocument();
});

it('greets the signed-in account by its actual name', async () => {
  vi.stubEnv('VITE_USE_DEMO', '0');
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url.endsWith('/v1/connect')) return Response.json({ clients });
    if (url.endsWith('/v1/account')) return Response.json({ firstName: 'Nora' });
    if (url.endsWith('/v1/clients')) return Response.json({ clients: [] });
    return Response.json({ paused: false });
  }));
  home();
  expect(await screen.findByRole('heading', { name: 'Hej, Nora.' })).toBeInTheDocument();
  expect(screen.queryByRole('heading', { name: 'Hej, Emil.' })).not.toBeInTheDocument();
});
