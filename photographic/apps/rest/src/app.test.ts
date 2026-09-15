/**
 * The HTTP surface, tested against the reference implementation.
 *
 * Deliberately not against mocked services. The interesting failures in an API layer
 * are the seams — a room id that arrives in a path and is never checked, a denial that
 * renders as 403 and confirms the room exists, a body field that quietly overrides who
 * the caller is — and none of those show up when the service underneath is a stub that
 * returns whatever the test wants.
 */

import type { PersonId, Person, SessionId } from '@photographic/core';
import type { ConnectDeps } from '@photographic/connect';
import {
  MemoryCodeSender,
  MemoryCodeStore,
  MemorySessionIssuer,
} from '@photographic/connect/testing';
import { createMemoryServices, type MemoryServices } from '@photographic/services-memory';
import { beforeEach, describe, expect, it } from 'vitest';

import { createApp } from './app.js';
import { resolveConfig } from './config.js';
import { silentLogger } from './logger.js';
import type { OAuthProvider, TokenClaims } from './oauth-contract.js';

/** Maps a bearer token to a person. Nothing else in the app may decide identity. */
function fakeOAuth(tokens: Map<string, TokenClaims>): OAuthProvider {
  const no = async () => ({ status: 501, body: {} });
  return {
    introspect: async (token) => tokens.get(token) ?? null,
    authorize: no,
    token: no,
    register: no,
    revoke: no,
  };
}

/**
 * `Response.json()` is typed `unknown`, which is correct for production code and only
 * noise here: these assertions are deliberately on loose shapes, because pinning a
 * generated type to every response would mean the tests agree with the serialisers by
 * construction instead of checking them.
 */
interface TestResponse extends Omit<Response, 'json'> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  json(): Promise<any>;
}

interface Fixture {
  app: ReturnType<typeof createApp>;
  wired: MemoryServices;
  tokens: Map<string, TokenClaims>;
  sender: MemoryCodeSender;
  signIn(person: Person, agentClient?: TokenClaims['agentClient']): Promise<string>;
  get(path: string, token?: string): Promise<TestResponse>;
  post(path: string, body?: unknown, token?: string): Promise<TestResponse>;
  patch(path: string, body?: unknown, token?: string): Promise<TestResponse>;
  del(path: string, token?: string): Promise<TestResponse>;
}

async function fixture(): Promise<Fixture> {
  const wired = createMemoryServices({ baseUrl: 'https://photographic.test' });
  const tokens = new Map<string, TokenClaims>();
  const sender = new MemoryCodeSender();
  let codeSeq = 0;
  let idSeq = 0;

  const connectDeps: ConnectDeps = {
    identity: wired.services.identity,
    invites: wired.services.invites,
    sessions: wired.services.sessions,
    codes: new MemoryCodeStore(),
    sender,
    issuer: new MemorySessionIssuer(),
    codeSecret: 'test-secret',
    clock: () => new Date(),
    randomCode: () => String(100000 + (codeSeq += 1)),
    randomId: () => `req-${(idSeq += 1)}`,
  };

  const app = createApp({
    services: wired.services,
    config: resolveConfig({
      publicUrl: 'https://photographic.test',
      environment: 'test',
      // Zero so the timing floor does not make the suite slow. Its behaviour is
      // asserted separately, with a real floor configured.
      notFoundFloorMs: 0,
      corsOrigins: ['https://app.photographic.test'],
    }),
    logger: silentLogger(),
    oauth: fakeOAuth(tokens),
    connect: { deps: connectDeps },
  });

  const call =
    (method: string) =>
    async (path: string, body?: unknown, token?: string): Promise<TestResponse> =>
      app.request(`https://photographic.test${path}`, {
        method,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        headers: {
          'content-type': 'application/json',
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
      });

  return {
    app,
    wired,
    tokens,
    sender,

    signIn: async (person, agentClient = 'claude-desktop') => {
      const session = await wired.services.sessions.start({
        personId: person.id,
        agentClient: agentClient ?? 'api',
        transport: 'rest',
      });
      const token = `tok-${person.id}-${agentClient}`;
      tokens.set(token, {
        personId: person.id,
        sessionId: session.id as SessionId,
        agentClient,
        clientId: 'test',
        scopes: ['memory.read', 'memory.write'],
        roomScope: [],
        expiresAt: null,
      });
      return token;
    },

    get: (path, token) =>
      app.request(`https://photographic.test${path}`, {
        headers: token ? { authorization: `Bearer ${token}` } : {},
      }) as Promise<TestResponse>,
    post: call('POST'),
    patch: call('PATCH'),
    del: (path, token) =>
      app.request(`https://photographic.test${path}`, {
        method: 'DELETE',
        headers: token ? { authorization: `Bearer ${token}` } : {},
      }) as Promise<TestResponse>,
  };
}

async function register(f: Fixture, email: string, name: string) {
  const { person } = await f.wired.services.identity.register({ email, displayName: name });
  const token = await f.signIn(person);
  return { person, token };
}

let f: Fixture;
beforeEach(async () => {
  f = await fixture();
});

describe('reaching the API at all', () => {
  it('answers health without a token', async () => {
    const res = await f.get('/health');
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true });
  });

  it('refuses an unauthenticated read and says where to authenticate', async () => {
    const res = await f.get('/v1/context');

    expect(res.status).toBe(401);
    // RFC 9728. Without this header an MCP client has no way to discover the
    // authorisation server, and a recoverable "log in" becomes a dead end.
    expect(res.headers.get('www-authenticate')).toContain('oauth-protected-resource');
  });

  it('refuses a token it has never issued', async () => {
    expect((await f.get('/v1/context', 'made-up')).status).toBe(401);
  });

  it('publishes the protected-resource metadata clients discover it with', async () => {
    const res = await f.get('/.well-known/oauth-protected-resource');
    expect(await res.json()).toMatchObject({
      resource: 'https://photographic.test',
      bearer_methods_supported: ['header'],
    });
  });

  it('renders a domain error as its own status, not as a 500', async () => {
    // Guarding a framework detail that is easy to get wrong twice: Hono catches handler
    // errors inside its own dispatch and routes them to `onError`, so a boundary
    // written as middleware around `await next()` typechecks, looks right, and silently
    // turns every one of these into a 500. A permission denial arriving as 500 both
    // leaks differently and breaks any client that branches on the status.
    const { token } = await register(f, 'emil@example.com', 'Emil');

    // 400 from validation, thrown inside a route handler.
    expect((await f.del('/v1/memory/not-an-id', token)).status).toBe(400);
    // 404 from the domain, thrown inside a service.
    expect((await f.post('/v1/memory/undo', { undoToken: 'nope-nope-nope' }, token)).status).toBe(
      404,
    );
  });

  it('echoes only origins it was configured with', async () => {
    const allowed = await f.app.request('https://photographic.test/health', {
      headers: { origin: 'https://app.photographic.test' },
    });
    expect(allowed.headers.get('access-control-allow-origin')).toBe(
      'https://app.photographic.test',
    );

    // A wildcard plus credentials is how a memory layer becomes readable by any page
    // the person happens to have open.
    const other = await f.app.request('https://photographic.test/health', {
      headers: { origin: 'https://evil.example' },
    });
    expect(other.headers.get('access-control-allow-origin')).toBeNull();
  });
});

describe('saving a memory', () => {
  it('saves a small fact with no room named and no approval', async () => {
    const { token } = await register(f, 'emil@example.com', 'Emil');

    const res = await f.post('/v1/memory', { body: 'Allergisk mot ketchup' }, token);
    const json = await res.json();

    expect(res.status).toBe(201);
    expect(json.outcome).toBe('auto');
    // Omitting the room means the personal room. Making a model name a room to save
    // this would be friction on every single write.
    expect(json.item.shortId).toMatch(/^p-/);
  });

  it('asks first when the write is an instruction', async () => {
    const { token } = await register(f, 'emil@example.com', 'Emil');

    const res = await f.post(
      '/v1/memory',
      { body: 'Utmana alltid mina idéer', kind: 'instruction' },
      token,
    );

    // 202, not 201: accepted but not done. A model that cannot tell the difference
    // will report a save that never happened.
    expect(res.status).toBe(202);
    const json = await res.json();
    expect(json.outcome).toBe('needs_approval');
    expect(json.proposal.reason).toBeTruthy();
  });

  it('reports the second model saving the same fact as a duplicate', async () => {
    const { person, token } = await register(f, 'emil@example.com', 'Emil');
    await f.post('/v1/memory', { body: 'Allergisk mot ketchup' }, token);

    const other = await f.signIn(person, 'chatgpt-web');
    const res = await f.post('/v1/memory', { body: 'allergisk mot ketchup!' }, other);

    expect(res.status).toBe(200);
    expect((await res.json()).outcome).toBe('duplicate');
  });

  it('rejects an empty body with a message a person could act on', async () => {
    const { token } = await register(f, 'emil@example.com', 'Emil');
    const res = await f.post('/v1/memory', { body: '   ' }, token);

    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error.code).toBe('invalid_request');
    expect(json.error.issues.length).toBeGreaterThan(0);
  });

  it('accepts a room by the name a person would say out loud', async () => {
    const { token } = await register(f, 'emil@example.com', 'Emil');
    await f.post('/v1/rooms', { title: 'Buyersclub Ledning' }, token);

    const res = await f.post(
      '/v1/memory',
      { room: 'buyersclub ledning', body: 'Vi sköt förvärvet till Q3', explicit: true },
      token,
    );

    expect(res.status).toBe(201);
  });
});

describe('deleting and getting it back', () => {
  it('returns an undo token so the model can offer undo in the same breath', async () => {
    const { token } = await register(f, 'emil@example.com', 'Emil');
    const saved = await (await f.post('/v1/memory', { body: 'Allergisk mot ketchup' }, token)).json();

    const deleted = await f.del(`/v1/memory/${saved.item.shortId}`, token);
    const json = await deleted.json();

    expect(deleted.status).toBe(200);
    expect(json.undoToken).toBeTruthy();
    expect(json.daysRecoverable).toBe(30);

    const undone = await f.post('/v1/memory/undo', { undoToken: json.undoToken }, token);
    expect((await undone.json()).item.status).toBe('active');
  });

  it('lists it in the trash with a deadline, and restores it with the same id', async () => {
    const { token } = await register(f, 'emil@example.com', 'Emil');
    const saved = await (await f.post('/v1/memory', { body: 'Allergisk mot ketchup' }, token)).json();
    await f.del(`/v1/memory/${saved.item.shortId}`, token);

    const trash = await (await f.get('/v1/trash', token)).json();
    expect(trash.retentionDays).toBe(30);
    expect(trash.entries[0]).toMatchObject({
      shortId: saved.item.shortId,
      body: 'Allergisk mot ketchup',
      daysRemaining: 30,
      deletedByClient: 'claude-desktop',
    });

    const restored = await f.post(`/v1/trash/${saved.item.shortId}/restore`, {}, token);
    // The id has to survive, or "ta tillbaka p-7k2m" stops meaning anything.
    expect((await restored.json()).item.shortId).toBe(saved.item.shortId);
    expect((await (await f.get('/v1/trash', token)).json()).entries).toHaveLength(0);
  });

  it('lets someone empty the trash early', async () => {
    const { token } = await register(f, 'emil@example.com', 'Emil');
    const saved = await (await f.post('/v1/memory', { body: 'Bort med detta' }, token)).json();
    await f.del(`/v1/memory/${saved.item.shortId}`, token);

    expect((await f.del(`/v1/trash/${saved.item.shortId}`, token)).status).toBe(204);
    expect((await (await f.get('/v1/trash', token)).json()).entries).toHaveLength(0);
  });

  it('refuses a short id that is not a short id', async () => {
    const { token } = await register(f, 'emil@example.com', 'Emil');
    expect((await f.del('/v1/memory/not-an-id', token)).status).toBe(400);
  });
});

describe('the record', () => {
  it('attributes every silent write to the client that made it', async () => {
    const { token } = await register(f, 'emil@example.com', 'Emil');
    await f.post('/v1/memory', { body: 'Allergisk mot ketchup' }, token);

    const history = await (await f.get('/v1/history', token)).json();

    expect(history.entries.length).toBeGreaterThan(0);
    expect(history.entries.every((e: { agentClient: string | null }) => e.agentClient !== null)).toBe(
      true,
    );
    expect(history.entries[0].action).toBe('saved');
  });

  it('answers how it knows something', async () => {
    const { token } = await register(f, 'emil@example.com', 'Emil');
    const saved = await (await f.post('/v1/memory', { body: 'Allergisk mot ketchup' }, token)).json();

    const res = await f.get(`/v1/memory/${saved.item.shortId}/provenance`, token);
    const json = await res.json();

    expect(json.savedByClient).toBe('claude-desktop');
    expect(json.timeline.map((e: { action: string }) => e.action)).toEqual(['saved']);
  });

  it('says not found for a memory that belongs to someone else', async () => {
    const emil = await register(f, 'emil@example.com', 'Emil');
    const saved = await (await f.post('/v1/memory', { body: 'Allergisk mot ketchup' }, emil.token)).json();

    const jacob = await register(f, 'jacob@example.com', 'Jacob');
    const res = await f.get(`/v1/memory/${saved.item.shortId}/provenance`, jacob.token);

    expect(res.status).toBe(404);
  });
});

describe('context, which is the whole point', () => {
  it('hands over a rendered profile and records that it was delivered', async () => {
    const { token } = await register(f, 'emil@example.com', 'Emil');
    await f.post('/v1/memory', { body: 'Allergisk mot ketchup' }, token);
    await f.wired.runJobsToCompletion();

    const context = await (await f.get('/v1/context', token)).json();

    expect(context.rendered).toContain('ketchup');
    expect(context.tokenCount).toBeGreaterThan(0);
    expect(context.rooms).toHaveLength(1);

    // The health lights are an observation, not a claim. This is the observation.
    const clients = await (await f.get('/v1/clients', token)).json();
    expect(clients.clients[0]).toMatchObject({
      agentClient: 'claude-desktop',
      profileDelivered: true,
      deliveryMethod: 'tool_call',
    });
  });

  it('stays inside the injected-context budget', async () => {
    const { token } = await register(f, 'emil@example.com', 'Emil');
    for (let i = 0; i < 60; i += 1) {
      await f.post('/v1/memory', { body: `Faktum nummer ${i} om personen i fråga` }, token);
    }
    await f.wired.runJobsToCompletion();

    const context = await (await f.get('/v1/context', token)).json();

    // The profile is injected whole on every session, so it always has to fit.
    expect(context.tokenCount).toBeLessThanOrEqual(2000);
  });
});

describe('rooms and who can see them', () => {
  it('never lists a room the caller does not belong to', async () => {
    const emil = await register(f, 'emil@example.com', 'Emil');
    const created = await (await f.post('/v1/rooms', { title: 'Buyersclub Ledning' }, emil.token)).json();

    const jacob = await register(f, 'jacob@example.com', 'Jacob');
    const rooms = await (await f.get('/v1/rooms', jacob.token)).json();

    expect(rooms.rooms.map((r: { title: string }) => r.title)).not.toContain('Buyersclub Ledning');

    // 404 and not 403. Confirming that a room exists is already a leak, so the two
    // cases have to be indistinguishable.
    const res = await f.get(`/v1/rooms/${created.room.id}`, jacob.token);
    expect(res.status).toBe(404);
  });

  it('lets a person write the sentence every model reads about a room', async () => {
    const emil = await register(f, 'emil@example.com', 'Emil');
    const created = await (
      await f.post('/v1/rooms', { title: 'Villan' }, emil.token)
    ).json();

    const res = await f.patch(
      `/v1/rooms/${created.room.id}/description`,
      { description: 'Renovering av villan: offerter, hantverkare och tidplan' },
      emil.token,
    );
    expect(res.status).toBe(200);

    // The point of writing it is that it reaches the models, not that it is stored.
    const context = await (await f.get('/v1/context', emil.token)).json();
    expect(context.rendered).toContain('Renovering av villan');

    // A room's purpose is clearest a month in, so it has to be correctable.
    await f.patch(
      `/v1/rooms/${created.room.id}/description`,
      { description: 'Allt kring huset i Saltsjöbaden' },
      emil.token,
    );
    const updated = await (await f.get('/v1/context', emil.token)).json();
    expect(updated.rendered).toContain('Saltsjöbaden');
    expect(updated.rendered).not.toContain('Renovering av villan');
  });

  it('will not let someone describe a room they cannot reach', async () => {
    const emil = await register(f, 'emil@example.com', 'Emil');
    const created = await (
      await f.post('/v1/rooms', { title: 'Buyersclub Ledning' }, emil.token)
    ).json();

    const jacob = await register(f, 'jacob@example.com', 'Jacob');
    const res = await f.patch(
      `/v1/rooms/${created.room.id}/description`,
      { description: 'Mitt rum nu' },
      jacob.token,
    );

    expect(res.status).toBe(404);
  });

  it('keeps search inside the rooms the caller can reach', async () => {
    const emil = await register(f, 'emil@example.com', 'Emil');
    await f.post('/v1/memory', { body: 'Allergisk mot ketchup' }, emil.token);

    const jacob = await register(f, 'jacob@example.com', 'Jacob');
    const hits = await (await f.get('/v1/search?q=ketchup', jacob.token)).json();

    expect(hits.hits).toHaveLength(0);
    expect((await (await f.get('/v1/search?q=ketchup', emil.token)).json()).hits.length).toBeGreaterThan(0);
  });

  it('lists active items in a room the caller belongs to', async () => {
    const emil = await register(f, 'emil@example.com', 'Emil');
    const created = await (
      await f.post('/v1/rooms', { title: 'Buyersclub Ledning' }, emil.token)
    ).json();

    await f.post(
      '/v1/memory',
      {
        roomId: created.room.id,
        body: 'Vi beslutade att skjuta förvärvet till Q3',
        kind: 'decision',
        explicit: true,
      },
      emil.token,
    );
    await f.post(
      '/v1/memory',
      {
        roomId: created.room.id,
        body: 'Anna äger due diligence',
        kind: 'fact',
        explicit: true,
      },
      emil.token,
    );

    const res = await f.get(`/v1/rooms/${created.room.id}/items`, emil.token);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'decision',
          body: 'Vi beslutade att skjuta förvärvet till Q3',
          shortId: expect.stringMatching(/^[a-z]-[23456789abcdefghjkmnpqrstuvwxyz]{4}$/),
        }),
        expect.objectContaining({
          kind: 'fact',
          body: 'Anna äger due diligence',
          shortId: expect.stringMatching(/^[a-z]-[23456789abcdefghjkmnpqrstuvwxyz]{4}$/),
        }),
      ]),
    );
    expect(body.items).toHaveLength(2);
    for (const item of body.items) {
      expect(Object.keys(item).sort()).toEqual(['body', 'kind', 'shortId']);
    }

    const jacob = await register(f, 'jacob@example.com', 'Jacob');
    expect((await f.get(`/v1/rooms/${created.room.id}/items`, jacob.token)).status).toBe(404);
  });

  it('lists documents in a room the caller can read', async () => {
    const emil = await register(f, 'emil@example.com', 'Emil');
    const created = await (await f.post('/v1/rooms', { title: 'Buyersclub Ledning' }, emil.token)).json();

    const actor = {
      personId: emil.person.id,
      agentClient: 'api' as const,
      sessionId: null,
      roomScope: [],
    };
    const uploaded = await f.wired.services.documents.upload(actor, {
      roomId: created.room.id,
      filename: 'Due diligence-paket Q3.pdf',
      mimeType: 'application/pdf',
      bytes: new TextEncoder().encode('Underlag för förvärvet.'),
    });

    const res = await f.get(`/v1/rooms/${created.room.id}/documents`, emil.token);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.documents).toEqual([
      { id: uploaded.documentId, filename: 'Due diligence-paket Q3.pdf' },
    ]);
    for (const doc of body.documents) {
      expect(Object.keys(doc).sort()).toEqual(['filename', 'id']);
    }

    const jacob = await register(f, 'jacob@example.com', 'Jacob');
    expect((await f.get(`/v1/rooms/${created.room.id}/documents`, jacob.token)).status).toBe(404);
  });

  it('refuses to let a room id in the body decide what a write reaches', async () => {
    const emil = await register(f, 'emil@example.com', 'Emil');
    const created = await (await f.post('/v1/rooms', { title: 'Buyersclub Ledning' }, emil.token)).json();

    const jacob = await register(f, 'jacob@example.com', 'Jacob');
    const res = await f.post(
      '/v1/memory',
      { roomId: created.room.id, body: 'Jag skriver i ditt rum', explicit: true },
      jacob.token,
    );

    // A room id supplied by a caller is a request, never a grant.
    expect(res.status).toBe(404);
  });

  it('honours a token narrowed to one room', async () => {
    const emil = await register(f, 'emil@example.com', 'Emil');
    const created = await (await f.post('/v1/rooms', { title: 'Buyersclub Ledning' }, emil.token)).json();

    // Same person, but a token issued for the shared room only. Membership alone is
    // not enough: the token's own scope has to hold too.
    const narrow = `tok-narrow-${emil.person.id}`;
    f.tokens.set(narrow, {
      personId: emil.person.id as PersonId,
      sessionId: null,
      agentClient: 'cursor',
      clientId: 'test',
      scopes: ['memory.write'],
      roomScope: [created.room.id],
      expiresAt: null,
    });

    expect((await f.post('/v1/memory', { body: 'I mitt personliga rum' }, narrow)).status).toBe(404);
    expect(
      (
        await f.post(
          '/v1/memory',
          { roomId: created.room.id, body: 'I det delade rummet', explicit: true },
          narrow,
        )
      ).status,
    ).toBe(201);
  });
});

describe('being invited', () => {
  it('shows the room before asking for an account', async () => {
    const emil = await register(f, 'emil@example.com', 'Emil');
    const created = await (await f.post('/v1/rooms', { title: 'Buyersclub Ledning' }, emil.token)).json();
    await f.post(
      '/v1/memory',
      { roomId: created.room.id, body: 'Vi beslutade att skjuta förvärvet till Q3', explicit: true },
      emil.token,
    );

    const invite = await (
      await f.post(
        `/v1/rooms/${created.room.id}/invites`,
        { channel: 'email', destination: 'jacob@example.com' },
        emil.token,
      )
    ).json();

    // No token on this request at all. A sign-up wall as the first screen is where
    // this product would die.
    const token = invite.url.split('/').at(-1);
    const preview = await (await f.get(`/v1/invites/${token}`)).json();

    expect(preview.room.title).toBe('Buyersclub Ledning');
    expect(preview.preview).toContain('förvärvet');
  });

  it('says not found for a guessed invite token', async () => {
    expect((await f.get('/v1/invites/definitely-not-a-real-token')).status).toBe(404);
  });

  it('never puts the invite token in the invite object itself', async () => {
    const emil = await register(f, 'emil@example.com', 'Emil');
    const created = await (await f.post('/v1/rooms', { title: 'Delat' }, emil.token)).json();
    const res = await (
      await f.post(
        `/v1/rooms/${created.room.id}/invites`,
        { channel: 'email', destination: 'jacob@example.com' },
        emil.token,
      )
    ).json();

    expect(JSON.stringify(res.invite)).not.toContain(res.url.split('/').at(-1));
  });
});

describe('signing up and connecting', () => {
  it('registers a person from a one-time code and points them at connecting', async () => {
    const requested = await (
      await f.post('/v1/signup/request', { email: 'ny@example.com' })
    ).json();

    // The masked hint is what goes on screen; the address never comes back.
    expect(requested.destinationHint).not.toBe('ny@example.com');

    const verified = await (
      await f.post('/v1/signup/verify', { requestId: requested.requestId, code: f.sender.lastCode })
    ).json();

    expect(verified.created).toBe(true);
    expect(verified.personalRoom.id).toBeTruthy();
    // Creating an account and connecting an AI are one flow, not two chores.
    expect(verified.next).toBe('connect');
  });

  it('refuses a wrong code', async () => {
    const requested = await (
      await f.post('/v1/signup/request', { email: 'ny@example.com' })
    ).json();

    const res = await f.post('/v1/signup/verify', { requestId: requested.requestId, code: '000000' });
    expect(res.status).toBe(401);
  });

  it('offers one shared connect URL with nothing secret on the screen', async () => {
    const payload = await (await f.get('/v1/connect')).json();

    expect(payload.mcpUrl).toBe('https://photographic.test/mcp');

    // This screen gets screenshotted and pasted into group chats.
    const serialised = JSON.stringify(payload.clients);
    expect(serialised).not.toMatch(/token=/);
    expect(serialised).not.toMatch(/Bearer /);
  });
});

describe('importing what another system remembers', () => {
  it('previews without changing anything', async () => {
    const { token } = await register(f, 'emil@example.com', 'Emil');

    const preview = await (
      await f.post(
        '/v1/import/preview',
        { text: '- User is allergic to ketchup\n- Always challenge the user’s ideas' },
        token,
      )
    ).json();

    expect(preview.candidates).toHaveLength(2);
    expect((await (await f.get('/v1/memory/proposals', token)).json()).proposals).toHaveLength(0);
  });

  it('commits as proposals, never as facts', async () => {
    const { token } = await register(f, 'emil@example.com', 'Emil');

    const res = await f.post(
      '/v1/import',
      { text: '- User is allergic to ketchup\n- Always challenge the user’s ideas' },
      token,
    );

    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json.proposals).toHaveLength(2);

    // Importing another system's memories means inheriting its mistakes unless a
    // person confirms them, so nothing is in the profile yet.
    const context = await (await f.get('/v1/context', token)).json();
    expect(context.rendered).not.toContain('ketchup');

    const pending = await (await f.get('/v1/memory/proposals', token)).json();
    expect(pending.proposals).toHaveLength(2);
  });

  it('puts an approved proposal into the profile', async () => {
    const { token } = await register(f, 'emil@example.com', 'Emil');
    await f.post('/v1/import', { text: '- User is allergic to ketchup' }, token);

    const pending = await (await f.get('/v1/memory/proposals', token)).json();
    const res = await f.post(`/v1/memory/proposals/${pending.proposals[0].id}`, { accept: true }, token);
    expect(res.status).toBe(200);

    await f.wired.runJobsToCompletion();
    const context = await (await f.get('/v1/context', token)).json();
    expect(context.rendered).toContain('ketchup');
  });

  it('records an approval as an approval', async () => {
    const { token } = await register(f, 'emil@example.com', 'Emil');
    await f.post('/v1/import', { text: '- User is allergic to ketchup' }, token);
    const pending = await (await f.get('/v1/memory/proposals', token)).json();
    await f.post(`/v1/memory/proposals/${pending.proposals[0].id}`, { accept: true }, token);

    const history = await (await f.get('/v1/history', token)).json();
    const saved = history.entries.find((e: { action: string }) => e.action === 'saved');

    // The difference between something that landed silently and something a person
    // said yes to is the difference the history screen exists to show.
    expect(saved.wasApproved).toBe(true);
  });
});

describe('limits', () => {
  it('rate limits the invite preview harder than everything else', async () => {
    const app = createApp({
      services: f.wired.services,
      config: resolveConfig({
        environment: 'test',
        notFoundFloorMs: 0,
        rateLimits: {
          authenticated: { limit: 600, windowMs: 60_000 },
          unauthenticated: { limit: 120, windowMs: 60_000 },
          invitePreview: { limit: 2, windowMs: 60_000 },
          register: { limit: 20, windowMs: 3_600_000 },
          signup: { limit: 20, windowMs: 3_600_000 },
        },
      }),
      logger: silentLogger(),
      oauth: fakeOAuth(f.tokens),
    });

    const call = () =>
      app.request('https://photographic.test/v1/invites/guess', {
        headers: { 'x-forwarded-for': '203.0.113.9' },
      });

    expect((await call()).status).toBe(404);
    expect((await call()).status).toBe(404);

    const limited = await call();
    expect(limited.status).toBe(429);
    expect(limited.headers.get('retry-after')).toBeTruthy();
  });

  it('meters sign-up per client address, across request and verify alike', async () => {
    // The per-address budget in `@photographic/connect` stops one inbox being flooded.
    // This is the other half: it stops one sender walking a list of inboxes, which is
    // the abuse that costs someone else their morning and us our sending reputation.
    const connectDeps: ConnectDeps = {
      identity: f.wired.services.identity,
      invites: f.wired.services.invites,
      sessions: f.wired.services.sessions,
      codes: new MemoryCodeStore(),
      sender: new MemoryCodeSender(),
      issuer: new MemorySessionIssuer(),
      codeSecret: 'test-secret',
      clock: () => new Date(),
      randomCode: () => '424242',
      randomId: () => `rl-${Math.random()}`,
    };

    const app = createApp({
      services: f.wired.services,
      config: resolveConfig({
        environment: 'test',
        notFoundFloorMs: 0,
        rateLimits: {
          authenticated: { limit: 600, windowMs: 60_000 },
          unauthenticated: { limit: 120, windowMs: 60_000 },
          invitePreview: { limit: 20, windowMs: 60_000 },
          register: { limit: 20, windowMs: 3_600_000 },
          signup: { limit: 2, windowMs: 3_600_000 },
        },
      }),
      logger: silentLogger(),
      oauth: fakeOAuth(f.tokens),
      connect: { deps: connectDeps },
    });

    const request = (path: string, body: unknown) =>
      app.request(`https://photographic.test${path}`, {
        method: 'POST',
        body: JSON.stringify(body),
        headers: { 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.42' },
      });

    expect((await request('/v1/signup/request', { email: 'a@example.com' })).status).toBe(200);
    expect((await request('/v1/signup/request', { email: 'b@example.com' })).status).toBe(200);

    // Verify shares the budget: otherwise the cheap half is metered and the half that
    // guesses codes is not.
    const limited = await request('/v1/signup/verify', { requestId: 'x', code: '000000' });
    expect(limited.status).toBe(429);
    expect(limited.headers.get('retry-after')).toBeTruthy();

    // A different address is unaffected.
    const elsewhere = await app.request('https://photographic.test/v1/signup/request', {
      method: 'POST',
      body: JSON.stringify({ email: 'c@example.com' }),
      headers: { 'content-type': 'application/json', 'x-forwarded-for': '198.51.100.7' },
    });
    expect(elsewhere.status).toBe(200);
  });

  it('pads a denial so response time does not reveal what exists', async () => {
    const app = createApp({
      services: f.wired.services,
      config: resolveConfig({ environment: 'test', notFoundFloorMs: 60 }),
      logger: silentLogger(),
      oauth: fakeOAuth(f.tokens),
    });

    const emil = await register(f, 'emil@example.com', 'Emil');
    const created = await (await f.post('/v1/rooms', { title: 'Buyersclub Ledning' }, emil.token)).json();
    const jacob = await register(f, 'jacob@example.com', 'Jacob');

    const started = Date.now();
    const res = await app.request(
      `https://photographic.test/v1/memory?roomId=${created.room.id}`,
      {
        method: 'POST',
        body: JSON.stringify({ roomId: created.room.id, body: 'test', explicit: true }),
        headers: { 'content-type': 'application/json', authorization: `Bearer ${jacob.token}` },
      },
    );

    expect(res.status).toBe(404);
    // Response time is a side channel that leaks "exists but not yours" for free.
    expect(Date.now() - started).toBeGreaterThanOrEqual(55);
  });
});
