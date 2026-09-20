import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import { buildClients, findClient } from '@photographic/connect';
import { SHARED_ROOM_CONSENT } from '@photographic/core';
import type { VerificationState } from '@photographic/connect';

import { App } from './App.js';
import { CALLBACK_URL, FakeApi, MCP_URL } from './test/fake-api.js';

const CLIENTS = buildClients({ mcpUrl: MCP_URL, connectPageUrl: 'https://photographic.me/connect' });

function connected(overrides: Partial<{ degraded: boolean }> = {}) {
  return [
    { status: 'waiting' as const, prompt: 'Hämta mitt minne från Photographic nu. Om du inte har tillgång till Photographics verktyg, säg det.', elapsedMs: 0, remainingMs: 90_000 },
    {
      status: 'connected' as const,
      agentClient: 'claude-desktop' as const,
      deliveryMethod: 'mcp_instructions' as const,
      at: new Date('2026-09-15T22:04:00Z'),
      degraded: overrides.degraded ?? false,
    },
  ];
}

const PHONE = '070-123 45 67';

describe('signing up', () => {
  it('asks for one field and no password', async () => {
    render(<App api={new FakeApi()} />);

    expect(screen.getByLabelText('Mobilnummer')).toBeInTheDocument();
    expect(document.querySelector('input[type="password"]')).toBeNull();
  });

  it('offers a mobile number and nothing else', async () => {
    render(<App api={new FakeApi()} />);

    // No second field, no channel picker, and no copy that reads as an offer of one:
    // email is configured to reach nobody, so naming it here would be a door drawn on a
    // wall. The field is a `tel` so a phone puts up a number pad.
    expect(document.querySelectorAll('input')).toHaveLength(1);
    expect(screen.getByLabelText('Mobilnummer')).toHaveAttribute('type', 'tel');
    expect(document.body.textContent).not.toMatch(/e-post|mejl|adress/i);
  });

  it('reads the same number whichever way it is written', async () => {
    const written = ['070-123 45 67', '0701234567', '+46 70 123 45 67', '+46701234567'];

    for (const number of written) {
      const user = userEvent.setup();
      const api = new FakeApi();
      const { unmount } = render(<App api={api} />);

      await user.type(screen.getByLabelText('Mobilnummer'), number);
      await user.click(screen.getByRole('button', { name: 'Fortsätt' }));

      await screen.findByLabelText('Kod');
      expect(api.requested).toEqual([{ phone: '+46701234567' }]);
      unmount();
    }
  });

  it('leaves what the person typed alone', async () => {
    const user = userEvent.setup();
    render(<App api={new FakeApi()} />);

    // Their own number, their own spacing. Reformatting it under their fingers is the
    // form arguing with them about something they know better than we do.
    const field = screen.getByLabelText('Mobilnummer');
    await user.type(field, '070-123 45 67');
    expect(field).toHaveValue('070-123 45 67');
  });

  it('says what is wrong rather than just refusing', async () => {
    const user = userEvent.setup();
    render(<App api={new FakeApi()} />);

    await user.type(screen.getByLabelText('Mobilnummer'), '08-123 45 67');
    await user.click(screen.getByRole('button', { name: 'Fortsätt' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/börjar på 070/);
    // Still on the first screen, with the number intact to correct.
    expect(screen.getByLabelText('Mobilnummer')).toHaveValue('08-123 45 67');
  });

  it('tells someone who types an address that the code comes by SMS', async () => {
    const user = userEvent.setup();
    const api = new FakeApi();
    render(<App api={api} />);

    await user.type(screen.getByLabelText('Mobilnummer'), 'emil@example.com');
    await user.click(screen.getByRole('button', { name: 'Fortsätt' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/SMS/);
    // And no request went out, so nothing is waiting on a code that cannot arrive.
    expect(api.requested).toEqual([]);
  });

  it('shows the masked destination and never the code', async () => {
    const user = userEvent.setup();
    render(<App api={new FakeApi()} />);

    await user.type(screen.getByLabelText('Mobilnummer'), PHONE);
    await user.click(screen.getByRole('button', { name: 'Fortsätt' }));

    expect(await screen.findByText(/070-••• 45 67/)).toBeInTheDocument();
    expect(screen.queryByText(/424242/)).toBeNull();
    expect(document.body.textContent).not.toContain('+46701234567');
  });

  it('goes straight to connecting rather than to a dashboard', async () => {
    const user = userEvent.setup();
    // A returning person, so the (skippable) first-sign-in name prompt does not stand
    // between the code and connecting — that prompt is its own describe block below.
    render(<App api={new FakeApi({ created: false })} />);

    await user.type(screen.getByLabelText('Mobilnummer'), PHONE);
    await user.click(screen.getByRole('button', { name: 'Fortsätt' }));
    await user.type(await screen.findByLabelText('Kod'), '424242');
    await user.click(screen.getByRole('button', { name: 'Fortsätt' }));

    expect(await screen.findByRole('heading', { name: 'Koppla din AI' })).toBeInTheDocument();
  });

  it('surfaces a wrong code without losing the entered state', async () => {
    const user = userEvent.setup();
    render(<App api={new FakeApi()} />);

    await user.type(screen.getByLabelText('Mobilnummer'), PHONE);
    await user.click(screen.getByRole('button', { name: 'Fortsätt' }));
    await user.type(await screen.findByLabelText('Kod'), '000000');
    await user.click(screen.getByRole('button', { name: 'Fortsätt' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Fel kod.');
    expect(screen.getByLabelText('Kod')).toBeInTheDocument();
  });

  it('offers another number, not another address', async () => {
    const user = userEvent.setup();
    render(<App api={new FakeApi()} />);

    await user.type(screen.getByLabelText('Mobilnummer'), PHONE);
    await user.click(screen.getByRole('button', { name: 'Fortsätt' }));
    await user.click(await screen.findByRole('button', { name: 'Använd ett annat nummer' }));

    expect(screen.getByLabelText('Mobilnummer')).toBeInTheDocument();
  });
});

describe('the first-name prompt', () => {
  /** Types the number and the code; stops right after verification. */
  const verify = async (user: ReturnType<typeof userEvent.setup>) => {
    await user.type(screen.getByLabelText('Mobilnummer'), PHONE);
    await user.click(screen.getByRole('button', { name: 'Fortsätt' }));
    await user.type(await screen.findByLabelText('Kod'), '424242');
    await user.click(screen.getByRole('button', { name: 'Fortsätt' }));
  };

  it('asks only on first sign-in, never for a returning person', async () => {
    const user = userEvent.setup();
    render(<App api={new FakeApi({ created: false })} />);

    await verify(user);

    expect(screen.queryByText('Vad heter du?')).toBeNull();
    expect(await screen.findByRole('heading', { name: 'Koppla din AI' })).toBeInTheDocument();
  });

  it('appears after the code, not before, and is not a wall', async () => {
    const user = userEvent.setup();
    render(<App api={new FakeApi()} />);

    await verify(user);

    expect(await screen.findByText('Vad heter du?')).toBeInTheDocument();
    // Skippable in the most literal sense: no field is required to move past it.
    expect(screen.getByRole('button', { name: 'Hoppa över' })).toBeEnabled();
  });

  it('skipping moves straight on without calling the API', async () => {
    const user = userEvent.setup();
    const api = new FakeApi();
    render(<App api={api} />);

    await verify(user);
    await user.click(await screen.findByRole('button', { name: 'Hoppa över' }));

    expect(await screen.findByRole('heading', { name: 'Koppla din AI' })).toBeInTheDocument();
    expect(api.namedFirst).toEqual([]);
  });

  it('submitting empty is the same as skipping', async () => {
    const user = userEvent.setup();
    const api = new FakeApi();
    render(<App api={api} />);

    await verify(user);
    await user.click(await screen.findByRole('button', { name: 'Fortsätt' }));

    expect(await screen.findByRole('heading', { name: 'Koppla din AI' })).toBeInTheDocument();
    expect(api.namedFirst).toEqual([]);
  });

  it('saves a name that is filled in, then continues', async () => {
    const user = userEvent.setup();
    const api = new FakeApi();
    render(<App api={api} />);

    await verify(user);
    await user.type(await screen.findByLabelText('Förnamn'), 'Jacob');
    await user.click(screen.getByRole('button', { name: 'Fortsätt' }));

    expect(await screen.findByRole('heading', { name: 'Koppla din AI' })).toBeInTheDocument();
    expect(api.namedFirst).toEqual(['Jacob']);
  });

  it('surfaces a failure without losing the typed name or blocking the way forward', async () => {
    const user = userEvent.setup();
    render(<App api={new FakeApi({ failSetFirstNameWith: 'Något gick fel.' })} />);

    await verify(user);
    await user.type(await screen.findByLabelText('Förnamn'), 'Jacob');
    await user.click(screen.getByRole('button', { name: 'Fortsätt' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Något gick fel.');
    expect(screen.getByLabelText('Förnamn')).toHaveValue('Jacob');
    // Still reachable: "Hoppa över" never depends on the save having worked.
    expect(screen.getByRole('button', { name: 'Hoppa över' })).toBeEnabled();
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
    expect(screen.queryByLabelText('Mobilnummer')).toBeNull();
  });

  it('carries the invite token into the signup request', async () => {
    const user = userEvent.setup();
    const api = new FakeApi({ invite });
    render(<App api={api} initial={{ name: 'invite', token: 'tok' }} />);

    await user.click(await screen.findByRole('button', { name: 'Gå med' }));
    await user.type(screen.getByLabelText('Mobilnummer'), '072-987 65 43');
    await user.click(screen.getByRole('button', { name: 'Fortsätt' }));

    expect(api.requested[0]).toMatchObject({ inviteToken: 'tok' });
  });

  it('says the personal room comes along and stays private', async () => {
    render(<App api={new FakeApi({ invite })} initial={{ name: 'invite', token: 'tok' }} />);
    expect(await screen.findByText(/eget privat rum/)).toBeInTheDocument();
  });

  /**
   * The decision, above the button.
   *
   * Everything asserted here is what a person needs before pressing "Gå med": who it is
   * from, that the room is shared, and that what they write in it stays there if they
   * leave. That last one is the whole justification for the rule, and it only holds if it
   * was said first — so it is a test rather than a layout preference.
   */
  it('names who invited them, that the room is shared, and what stays behind', async () => {
    render(<App api={new FakeApi({ invite })} initial={{ name: 'invite', token: 'tok' }} />);

    expect(await screen.findByText(/Emil bjuder in dig till ett delat rum/)).toBeInTheDocument();
    expect(screen.getByText(/stannar i rummet, även om du lämnar det/)).toBeInTheDocument();
    expect(screen.getByText(SHARED_ROOM_CONSENT)).toBeInTheDocument();

    // The consequence lines come before the action in document order, which is what puts
    // them above the button on a phone.
    const consequences = screen.getByText(/stannar i rummet, även om du lämnar det/);
    const join = screen.getByRole('button', { name: 'Gå med' });
    expect(consequences.compareDocumentPosition(join)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  });

  it('falls back to "Någon" for an inviter with no name, not a nameless sentence', async () => {
    render(
      <App
        api={new FakeApi({ invite: { ...invite, invitedByName: null } })}
        initial={{ name: 'invite', token: 'tok' }}
      />,
    );

    // Same fallback word every other unknown-person surface uses, not a different
    // sentence shape ("Du är inbjuden till") that only this screen used to have. The
    // sentence itself is the invite viewport's, which this test predates.
    expect(
      await screen.findByText('Någon bjuder in dig till ett delat rum'),
    ).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/undefined|null/i);
  });
});

describe('the public landing page', () => {
  it('says what the product is, and offers a way in for an existing account', async () => {
    const user = userEvent.setup();
    const visited: string[] = [];
    render(
      <App api={new FakeApi()} initial={{ name: 'landing' }} navigate={(url) => visited.push(url)} />,
    );

    expect(
      screen.getByRole('heading', { level: 1, name: 'Ditt minne, inte modellens.' }),
    ).toBeInTheDocument();
    expect(screen.getByText(/Byter du modell börjar du inte om/)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Logga in' }));
    expect(visited).toEqual(['/login']);
  });

  it('explains an expired session and preserves the product destination through login', async () => {
    const user = userEvent.setup();
    const visited: string[] = [];
    render(
      <App
        api={new FakeApi()}
        initial={{
          name: 'landing',
          notice: 'Din session har gått ut. Logga in igen för att fortsätta.',
          returnTo: '/konto',
        }}
        navigate={(url) => visited.push(url)}
      />,
    );

    expect(screen.getByRole('status')).toHaveTextContent('Din session har gått ut');
    await user.click(screen.getByRole('button', { name: 'Logga in' }));
    expect(visited).toEqual(['/login?fran=%2Fkonto']);
  });

  /**
   * The landing page is the one screen strangers read, so it may only promise what runs.
   * Voice, summaries and open signup are the three things it would be easiest to imply.
   */
  it('promises nothing that is not built', () => {
    render(<App api={new FakeApi()} initial={{ name: 'landing' }} />);

    expect(screen.queryByText(/röst/i)).toBeNull();
    expect(screen.queryByText(/sammanfattning/i)).toBeNull();
    expect(screen.getByText(/Nya konton öppnas inte för alla ännu/)).toBeInTheDocument();
    expect(screen.queryByLabelText('Mobilnummer')).toBeNull();
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
    expect(screen.getByText(/inte automatiskt Photographic/)).toBeVisible();
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

    expect(await screen.findByText('Hämta mitt minne från Photographic nu. Om du inte har tillgång till Photographics verktyg, säg det.')).toBeInTheDocument();
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
    expect(await screen.findByText('Hämta mitt minne från Photographic nu. Om du inte har tillgång till Photographics verktyg, säg det.')).toBeInTheDocument();
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
    await user.type(await screen.findByLabelText('Mobilnummer'), PHONE);
    await user.click(screen.getByRole('button', { name: 'Fortsätt' }));
    await user.type(await screen.findByLabelText('Kod'), '424242');
    await user.click(screen.getByRole('button', { name: 'Fortsätt' }));
  };

  it('asks the person to log in before showing what is being requested', async () => {
    arrive(new FakeApi({ authorization: pending }));

    // Naming the client first, because a person who arrived by redirect needs to know
    // who sent them before they are asked to type an address.
    expect(await screen.findByText(/Claude Desktop/)).toBeInTheDocument();
    expect(screen.getByLabelText('Mobilnummer')).toBeInTheDocument();
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

  it('skips the login form when a session already exists', async () => {
    const api = new FakeApi({ authorization: pending });
    api.setSession('session-1');
    arrive(api);

    expect(
      await screen.findByRole('heading', { name: 'Ge Claude Desktop åtkomst?' }),
    ).toBeInTheDocument();
    expect(screen.queryByLabelText('Mobilnummer')).toBeNull();
    expect(screen.getByRole('button', { name: /Ge Claude Desktop åtkomst/ })).toBeInTheDocument();
  });

  it('explains an expired request instead of showing an empty consent screen', async () => {
    arrive(new FakeApi());

    expect(
      await screen.findByRole('heading', { name: 'Förfrågan gäller inte längre' }),
    ).toBeInTheDocument();
    expect(screen.getByText(/Ingen åtkomst gavs/)).toBeInTheDocument();
    expect(screen.queryByLabelText('Mobilnummer')).toBeNull();
  });
});
