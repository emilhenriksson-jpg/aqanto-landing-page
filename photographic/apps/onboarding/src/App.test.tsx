import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import { buildClients, findClient } from '@photographic/connect';
import type { VerificationState } from '@photographic/connect';

import { App } from './App.js';
import { CALLBACK_URL, FakeApi, MCP_URL } from './test/fake-api.js';

const CLIENTS = buildClients({ mcpUrl: MCP_URL, connectPageUrl: 'https://photographic.me/connect' });

function connected(overrides: Partial<{ degraded: boolean }> = {}) {
  return [
    { status: 'waiting' as const, prompt: 'Vad vet du om mig?', elapsedMs: 0, remainingMs: 90_000 },
    {
      status: 'connected' as const,
      agentClient: 'claude-desktop' as const,
      deliveryMethod: 'mcp_instructions' as const,
      at: new Date('2026-09-15T22:04:00Z'),
      degraded: overrides.degraded ?? false,
    },
  ];
}

describe('signing up', () => {
  it('asks for one field and no password', async () => {
    render(<App api={new FakeApi()} />);

    expect(screen.getByLabelText('E-post eller mobilnummer')).toBeInTheDocument();
    expect(document.querySelector('input[type="password"]')).toBeNull();
  });

  it('shows the masked destination and never the code', async () => {
    const user = userEvent.setup();
    render(<App api={new FakeApi()} />);

    await user.type(screen.getByLabelText('E-post eller mobilnummer'), 'emil@example.com');
    await user.click(screen.getByRole('button', { name: 'Fortsätt' }));

    expect(await screen.findByText(/e\*\*\*@example\.com/)).toBeInTheDocument();
    expect(screen.queryByText(/424242/)).toBeNull();
    expect(document.body.textContent).not.toContain('emil@example.com');
  });

  it('goes straight to connecting rather than to a dashboard', async () => {
    const user = userEvent.setup();
    render(<App api={new FakeApi()} />);

    await user.type(screen.getByLabelText('E-post eller mobilnummer'), 'emil@example.com');
    await user.click(screen.getByRole('button', { name: 'Fortsätt' }));
    await user.type(await screen.findByLabelText('Kod'), '424242');
    await user.click(screen.getByRole('button', { name: 'Fortsätt' }));

    expect(await screen.findByRole('heading', { name: 'Koppla din AI' })).toBeInTheDocument();
  });

  it('surfaces a wrong code without losing the entered state', async () => {
    const user = userEvent.setup();
    render(<App api={new FakeApi()} />);

    await user.type(screen.getByLabelText('E-post eller mobilnummer'), 'emil@example.com');
    await user.click(screen.getByRole('button', { name: 'Fortsätt' }));
    await user.type(await screen.findByLabelText('Kod'), '000000');
    await user.click(screen.getByRole('button', { name: 'Fortsätt' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Fel kod.');
    expect(screen.getByLabelText('Kod')).toBeInTheDocument();
  });
});

describe('the invite landing', () => {
  const invite = {
    room: { id: 'room-2', title: 'Buyersclub Ledning', description: null },
    invitedByName: 'Emil',
    preview: 'Vi beslutade att skjuta förvärvet till Q3',
  };

  it('shows the room content before asking for anything', async () => {
    render(<App api={new FakeApi({ invite })} initial={{ name: 'invite', token: 'tok' }} />);

    expect(await screen.findByRole('heading', { name: 'Buyersclub Ledning' })).toBeInTheDocument();
    expect(screen.getByText(/skjuta förvärvet till Q3/)).toBeInTheDocument();
    // No form field until they choose to join.
    expect(screen.queryByLabelText('E-post eller mobilnummer')).toBeNull();
  });

  it('carries the invite token into the signup request', async () => {
    const user = userEvent.setup();
    const api = new FakeApi({ invite });
    render(<App api={api} initial={{ name: 'invite', token: 'tok' }} />);

    await user.click(await screen.findByRole('button', { name: 'Gå med' }));
    await user.type(screen.getByLabelText('E-post eller mobilnummer'), 'jacob@example.com');
    await user.click(screen.getByRole('button', { name: 'Fortsätt' }));

    expect(api.requested[0]).toMatchObject({ inviteToken: 'tok' });
  });

  it('says the personal room comes along and stays private', async () => {
    render(<App api={new FakeApi({ invite })} initial={{ name: 'invite', token: 'tok' }} />);
    expect(await screen.findByText(/eget personligt rum/)).toBeInTheDocument();
  });
});

describe('the connect screen', () => {
  it('shows one shared URL, not a per-person one', async () => {
    render(<App api={new FakeApi()} initial={{ name: 'connect' }} />);

    expect(await screen.findByText(MCP_URL)).toBeInTheDocument();
    expect(screen.getByText(/Samma adress för alla/)).toBeInTheDocument();
  });

  it('renders a card for every client the payload returned', async () => {
    render(<App api={new FakeApi()} initial={{ name: 'connect' }} />);

    for (const client of CLIENTS) {
      expect(await screen.findByRole('heading', { name: client.displayName })).toBeInTheDocument();
    }
  });

  it('shows the caveats in the open rather than behind a disclosure', async () => {
    render(<App api={new FakeApi()} initial={{ name: 'connect' }} />);
    await screen.findByRole('heading', { name: 'ChatGPT' });

    // The things that cost people ten minutes if unsaid.
    expect(screen.getByText(/röstläge kan inte anropa connectors/)).toBeVisible();
    expect(screen.getByText(/måste läggas till från web eller desktop/)).toBeVisible();
  });

  it('marks the one-click clients and gives them a real link', async () => {
    render(<App api={new FakeApi()} initial={{ name: 'connect' }} />);
    await screen.findByRole('heading', { name: 'Cursor' });

    const link = screen.getByRole('link', { name: 'Lägg till i Cursor' });
    expect(link).toHaveAttribute(
      'href',
      expect.stringContaining('cursor://anysphere.cursor-deeplink/mcp/install'),
    );
  });

  it('fills the ChatGPT fallback with the real profile text', async () => {
    const user = userEvent.setup();
    render(
      <App
        api={new FakeApi({ profile: 'Allergisk mot ketchup' })}
        initial={{ name: 'connect' }}
      />,
    );

    const heading = await screen.findByRole('heading', { name: 'ChatGPT' });
    const card = heading.closest('article');
    await user.click(within(card as HTMLElement).getByRole('button', { name: 'Fler sätt' }));

    expect(
      within(card as HTMLElement).getByRole('button', { name: 'Kopiera din profil istället' }),
    ).toBeEnabled();
  });
});

describe('verification', () => {
  const claude = findClient(CLIENTS, 'claude');

  it('shows the prompt while waiting and claims nothing yet', async () => {
    render(<App api={new FakeApi()} initial={{ name: 'verify', client: claude }} />);

    expect(await screen.findByText('Vad vet du om mig?')).toBeInTheDocument();
    expect(screen.getByText(/Öppna Claude och fråga/)).toBeInTheDocument();
    expect(screen.queryByText(/läste din profil/)).toBeNull();
  });

  it('never reports success from a click alone', async () => {
    const user = userEvent.setup();
    render(<App api={new FakeApi()} initial={{ name: 'connect' }} />);

    const heading = await screen.findByRole('heading', { name: 'Claude' });
    const card = heading.closest('article');
    await user.click(within(card as HTMLElement).getByRole('button', { name: 'Jag har gjort det' }));

    // The person said they did it. That is not evidence, so we are still waiting.
    expect(await screen.findByText('Vad vet du om mig?')).toBeInTheDocument();
    expect(screen.queryByText(/läste din profil/)).toBeNull();
  });

  it('flips to connected with the client name and the time it arrived', async () => {
    render(
      <App
        api={new FakeApi({ verification: connected() })}
        initial={{ name: 'verify', client: claude }}
      />,
    );

    // Polling runs on a two-second interval, so allow for one tick.
    await waitFor(
      () => {
        expect(screen.getByText(/Claude anslöt .* och läste din profil\./)).toBeInTheDocument();
      },
      { timeout: 4000 },
    );
    expect(screen.getByText(/Nu vet Claude vem du är/)).toBeInTheDocument();
  });

  it('distinguishes a degraded delivery from a clean one', async () => {
    const [, arrived] = connected({ degraded: true });
    render(
      <App
        api={new FakeApi({ verification: [arrived as VerificationState] })}
        initial={{ name: 'verify', client: claude }}
      />,
    );

    expect(await screen.findByText(/mindre pålitlig väg/)).toBeInTheDocument();
    expect(screen.queryByText(/Nu vet Claude vem du är/)).toBeNull();
  });

  it('shows the client-specific remedy on timeout', async () => {
    render(
      <App
        api={new FakeApi({
          verification: [{ status: 'timed_out', remedy: claude.remedy, elapsedMs: 90_000 }],
        })}
        initial={{ name: 'verify', client: claude }}
      />,
    );

    expect(await screen.findByText(/Inget kom fram från Claude\./)).toBeInTheDocument();
    expect(screen.getByText(/web eller desktop/)).toBeInTheDocument();
  });
});

describe('client health', () => {
  it('tells the truth per client rather than claiming universal support', async () => {
    const now = new Date('2026-09-15T22:04:00Z').toISOString();
    render(
      <App
        api={new FakeApi({
          health: [
            {
              agentClient: 'claude-desktop',
              displayName: 'Claude',
              lastSeenAt: now,
              profileDelivered: true,
              deliveryMethod: 'mcp_instructions',
              degraded: false,
            },
            {
              agentClient: 'chatgpt-web',
              displayName: 'ChatGPT',
              lastSeenAt: now,
              profileDelivered: true,
              deliveryMethod: 'tool_call',
              degraded: true,
            },
            {
              agentClient: 'codex',
              displayName: 'Codex',
              lastSeenAt: now,
              profileDelivered: false,
              deliveryMethod: null,
              degraded: false,
            },
          ],
        })}
        initial={{ name: 'connect' }}
      />,
    );

    expect(await screen.findByText(/Läste din profil/)).toBeInTheDocument();
    expect(screen.getByText(/bara när modellen själv frågade/)).toBeInTheDocument();
    expect(screen.getByText('Har aldrig fått din profil.')).toBeInTheDocument();
  });
});

describe('approving an AI', () => {
  const pending = {
    requestId: 'ar-1',
    clientName: 'Claude Desktop',
    scopes: ['memory.read', 'memory.write', 'offline_access'],
    expiresAt: new Date(Date.now() + 900_000).toISOString(),
  };

  const arrive = (api: FakeApi, navigate: (url: string) => void = () => {}) =>
    render(
      <App api={api} initial={{ name: 'approve', requestId: 'ar-1' }} navigate={navigate} />,
    );

  /** Signs in, which is what the consent screen waits for before showing anything. */
  const signIn = async (user: ReturnType<typeof userEvent.setup>) => {
    await user.type(await screen.findByLabelText('E-post eller mobilnummer'), 'emil@example.com');
    await user.click(screen.getByRole('button', { name: 'Fortsätt' }));
    await user.type(await screen.findByLabelText('Kod'), '424242');
    await user.click(screen.getByRole('button', { name: 'Fortsätt' }));
  };

  it('asks the person to log in before showing what is being requested', async () => {
    arrive(new FakeApi({ authorization: pending }));

    // Naming the client first, because a person who arrived by redirect needs to know
    // who sent them before they are asked to type an address.
    expect(await screen.findByText(/Claude Desktop/)).toBeInTheDocument();
    expect(screen.getByLabelText('E-post eller mobilnummer')).toBeInTheDocument();
  });

  it('spells out each capability in words a person can refuse', async () => {
    const user = userEvent.setup();
    arrive(new FakeApi({ authorization: pending }));

    await signIn(user);

    expect(
      await screen.findByRole('heading', { name: 'Ge Claude Desktop åtkomst?' }),
    ).toBeInTheDocument();
    expect(screen.getByText('Läsa det du sparat')).toBeInTheDocument();
    expect(screen.getByText('Spara nytt åt dig')).toBeInTheDocument();
    // Nothing is shown as a raw scope string, which is what a person cannot consent to.
    expect(screen.queryByText('memory.read')).toBeNull();
    // Declining has to be a real option, not a link in the corner.
    expect(screen.getByRole('button', { name: 'Neka' })).toBeInTheDocument();
  });

  it('says the client name is unverified, because registration is open', async () => {
    const user = userEvent.setup();
    arrive(new FakeApi({ authorization: { ...pending, clientName: 'Photographic Official' } }));

    await signIn(user);

    expect(await screen.findByText(/appen själv uppgav/)).toBeInTheDocument();
  });

  it('hands the browser back to the client, at the URL the server chose', async () => {
    const user = userEvent.setup();
    const api = new FakeApi({ authorization: pending });
    const went: string[] = [];
    arrive(api, (url) => went.push(url));

    await signIn(user);
    await user.click(await screen.findByRole('button', { name: /Ge Claude Desktop åtkomst/ }));

    // The fake refuses an unauthenticated approval, so getting an answer through at all
    // is half the assertion: the session token was attached.
    await waitFor(() => expect(api.answered).toEqual([{ requestId: 'ar-1', approved: true }]));
    expect(went).toEqual([CALLBACK_URL]);
  });

  it('sends a refusal back too, so the client stops waiting', async () => {
    const user = userEvent.setup();
    const api = new FakeApi({ authorization: pending });
    const went: string[] = [];
    arrive(api, (url) => went.push(url));

    await signIn(user);
    await user.click(await screen.findByRole('button', { name: 'Neka' }));

    await waitFor(() => expect(api.answered).toEqual([{ requestId: 'ar-1', approved: false }]));
    // A person who says no still gets returned. Leaving them on a dead page means the
    // client sits there until it times out, and they try again and hit the same screen.
    expect(went).toEqual([CALLBACK_URL]);
  });

  it('explains an expired request instead of showing an empty consent screen', async () => {
    arrive(new FakeApi());

    expect(
      await screen.findByRole('heading', { name: 'Förfrågan gäller inte längre' }),
    ).toBeInTheDocument();
    expect(screen.getByText(/Ingen åtkomst gavs/)).toBeInTheDocument();
    expect(screen.queryByLabelText('E-post eller mobilnummer')).toBeNull();
  });
});
