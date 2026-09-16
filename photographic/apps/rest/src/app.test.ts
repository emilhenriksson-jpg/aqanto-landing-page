/**
 * The HTTP surface, tested against the reference implementation.
 *
 * Deliberately not against mocked services. The interesting failures in an API layer
 * are the seams — a room id that arrives in a path and is never checked, a denial that
 * renders as 403 and confirms the room exists, a body field that quietly overrides who
 * the caller is — and none of those show up when the service underneath is a stub that
 * returns whatever the test wants.
 */

import { estimateTokens, MIN_HONOURABLE_BUDGET_TOKENS } from '@photographic/agent';
import { SUPPORTED_SCOPES } from '@photographic/auth';
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
import { FIRST_PARTY_CLIENT_ID } from './oauth-contract.js';
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
  signInFirstParty(personId: PersonId): Promise<string>;
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
        // Everything a client gets when it asks for everything. These assertions are
        // about routes and serialisers, not about scope narrowing — `scope.test.ts`
        // owns that — so a fixture short of the full set would fail here for a reason
        // that has nothing to do with what is being checked.
        scopes: [...SUPPORTED_SCOPES],
        roomScope: [],
        expiresAt: null,
      });
      return token;
    },

    /**
     * The person's own browser, which is a different caller from a connected client.
     *
     * Answering a proposal is first-party only — the Godkänn queue exists so that a
     * person decides, and a route any `memory.write` token could call made that
     * advisory. `signIn` deliberately issues a client-shaped token (`clientId: 'test'`),
     * so tests that approve something have to say, as the product does, that it is the
     * person doing it.
     */
    signInFirstParty: async (personId) => {
      const session = await wired.services.sessions.start({
        personId,
        agentClient: 'web',
        transport: 'rest',
      });
      const token = `tok-firstparty-${personId}`;
      tokens.set(token, {
        personId,
        sessionId: session.id as SessionId,
        agentClient: 'web',
        clientId: FIRST_PARTY_CLIENT_ID,
        scopes: [...SUPPORTED_SCOPES],
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

/**
 * Saves into a shared room over HTTP, which means clearing the approval it queues.
 *
 * Every write into a shared room answers 202 now, including one the person asked for out
 * loud. `explicit` is a claim a model makes from text it read, and some of that text
 * arrives inside documents we did not write, so it cannot be the thing that opens a room
 * other people can read.
 */
async function saveIntoRoom(
  f: Fixture,
  token: string,
  body: Record<string, unknown>,
): Promise<void> {
  const queued = await f.post('/v1/memory', { ...body, explicit: true }, token);
  if (queued.status !== 202) {
    throw new Error(`förväntade 202 från ett delat rum, fick ${queued.status}`);
  }

  const { proposal } = await queued.json();
  // Approved by the person, not by the client that queued it — see `signInFirstParty`.
  const accepted = await f.post(
    `/v1/memory/proposals/${proposal.id}`,
    { accept: true },
    await f.signInFirstParty(claimsFor(f, token).personId),
  );
  if (accepted.status !== 200) {
    throw new Error(`kunde inte godkänna förslaget: ${accepted.status}`);
  }
}

/** The claims behind a fixture token, so a helper can find whose token it was given. */
function claimsFor(f: Fixture, token: string): TokenClaims {
  const claims = f.tokens.get(token);
  if (!claims) throw new Error('okänd token i testet');
  return claims;
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

describe('ending a browser session', () => {
  it('clears the httpOnly cookie from the same origin, even without a live token', async () => {
    const res = await f.app.request('https://photographic.test/v1/session/logout', {
      method: 'POST',
      headers: {
        origin: 'https://photographic.test',
        cookie: 'photographic_sid=stale-browser-token',
      },
    });

    expect(res.status).toBe(204);
    expect(res.headers.get('set-cookie')).toContain('photographic_sid=');
    expect(res.headers.get('set-cookie')).toMatch(/Max-Age=0|Expires=/i);
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('does not let another site sign a person out', async () => {
    const res = await f.app.request('https://photographic.test/v1/session/logout', {
      method: 'POST',
      headers: { origin: 'https://elsewhere.example' },
    });

    expect(res.status).toBe(403);
    expect(res.headers.get('set-cookie')).toBeNull();
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

    // 202, not 201: the room resolved from the spoken name, and then the write queued
    // because the room is shared. Both halves matter — a 404 here would mean the name
    // never resolved.
    expect(res.status).toBe(202);
    expect((await res.json()).proposal.roomId).toBeTruthy();
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
      // `type` and `handle` are on the wire so a screen renders the right shape and restores
      // it without knowing that a memory is addressed by short id and a document by uuid.
      type: 'memory',
      handle: saved.item.shortId,
      shortId: saved.item.shortId,
      body: 'Allergisk mot ketchup',
      daysRemaining: 30,
      deletedByClient: 'claude-desktop',
    });

    const restored = await f.post(`/v1/trash/${saved.item.shortId}/restore`, {}, token);
    const body = await restored.json();
    // The id has to survive, or "ta tillbaka p-7k2m" stops meaning anything.
    expect(body.type).toBe('memory');
    expect(body.item.shortId).toBe(saved.item.shortId);
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

  /**
   * One trash, over HTTP.
   *
   * The point being asserted is what a person experiences: a deleted document turns up in the
   * same list as a deleted memory, and comes back through the same route. A document used to
   * have its own listing that no screen called, so it was recoverable in principle and
   * invisible in practice.
   */
  it('lists a deleted document beside a deleted memory, and restores it the same way', async () => {
    const { token } = await register(f, 'emil@example.com', 'Emil');
    const saved = await (await f.post('/v1/memory', { body: 'Bor i Malmö' }, token)).json();
    await f.del(`/v1/memory/${saved.item.shortId}`, token);

    // Multipart, as the route takes it — the JSON write path is a different door.
    const form = new FormData();
    form.set('file', new File(['Villans kontrakt'], 'kontrakt.md', { type: 'text/markdown' }));
    const upload = await f.app.request('https://photographic.test/v1/documents', {
      method: 'POST',
      body: form,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(upload.status).toBe(201);
    const uploaded = (await upload.json()) as { document: { id: string } };
    expect((await f.del(`/v1/documents/${uploaded.document.id}`, token)).status).toBe(200);

    const trash = await (await f.get('/v1/trash', token)).json();
    const kinds = trash.entries.map((entry: { type: string }) => entry.type).sort();
    expect(kinds).toEqual(['document', 'memory']);

    const document = trash.entries.find((entry: { type: string }) => entry.type === 'document');
    expect(document).toMatchObject({ filename: 'kontrakt.md', handle: uploaded.document.id });

    // Same route, discriminated response — no branch in the client on what kind it is.
    const restored = await f.post(`/v1/trash/${document.handle}/restore`, {}, token);
    expect(restored.status).toBe(200);
    expect((await restored.json()).type).toBe('document');

    const after = await (await f.get('/v1/trash', token)).json();
    expect(after.entries.map((entry: { type: string }) => entry.type)).toEqual(['memory']);
  });

  it('answers a handle that is neither shape the same way as one that does not exist', async () => {
    // Denied and nonexistent look alike everywhere else, and a trash handle is no different:
    // an unparseable segment must not tell a caller that it got the shape wrong.
    const { token } = await register(f, 'emil@example.com', 'Emil');

    const nonsense = await f.post('/v1/trash/not-a-handle/restore', {}, token);
    const missing = await f.post('/v1/trash/p-7k2m/restore', {}, token);

    expect(nonsense.status).toBe(404);
    expect(missing.status).toBe(404);
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
    // Two of section 4's six questions. The handler was computing both and then dropping
    // them, which is why nothing outside the calendar could answer "varifrån kom det?".
    expect(json.source).toMatchObject({ kind: 'conversation' });
    expect(json.source.label).toContain('Claude');
    expect(json).toHaveProperty('motivation');
    expect(json.changed).toBe(false);
  });

  it('says not found for a memory that belongs to someone else', async () => {
    const emil = await register(f, 'emil@example.com', 'Emil');
    const saved = await (await f.post('/v1/memory', { body: 'Allergisk mot ketchup' }, emil.token)).json();

    const jacob = await register(f, 'jacob@example.com', 'Jacob');
    const res = await f.get(`/v1/memory/${saved.item.shortId}/provenance`, jacob.token);

    expect(res.status).toBe(404);
  });
});

describe('searching memory — "Fråga mitt minne"', () => {
  it('finds a plain text match exactly as it always has', async () => {
    const { token } = await register(f, 'emil@example.com', 'Emil');
    // The personal room, not a shared one: a shared-room write goes to the Godkänn
    // queue rather than becoming a memory, and this test is about search.
    await f.post('/v1/memory', { body: 'Vi beslutade att skjuta förvärvet till Q3', explicit: true }, token);

    const res = await f.get('/v1/search?q=förvärvet', token);
    const json = await res.json();

    expect(json.hits).toHaveLength(1);
    expect(json.hits[0]).toMatchObject({ kind: 'item', text: expect.stringContaining('Q3') });
  });

  it('rejects a request with neither a question nor a time window', async () => {
    const { token } = await register(f, 'emil@example.com', 'Emil');
    const res = await f.get('/v1/search', token);
    expect(res.status).toBe(400);
  });

  it('folds in the calendar once a time window is given, in the unified hit shape', async () => {
    const { token } = await register(f, 'emil@example.com', 'Emil');
    await f.post('/v1/memory', { body: 'Allergisk mot ketchup', explicit: true }, token);

    const since = new Date(Date.now() - 60_000).toISOString();
    const res = await f.get(`/v1/search?since=${encodeURIComponent(since)}`, token);
    const json = await res.json();

    expect(json.hits.length).toBeGreaterThan(0);
    expect(json.hits[0]).toMatchObject({ kind: 'event', action: 'saved' });
    expect(json.hits[0].occurredAt).toBeTruthy();
  });

  it('excludes a memory from before a since bound', async () => {
    const { token } = await register(f, 'emil@example.com', 'Emil');
    await f.post('/v1/memory', { body: 'Allergisk mot ketchup', explicit: true }, token);

    const since = new Date(Date.now() + 60_000).toISOString(); // a minute in the future
    const res = await f.get(`/v1/search?since=${encodeURIComponent(since)}`, token);
    const json = await res.json();

    expect(json.hits).toHaveLength(0);
  });

  it('never returns a calendar hit from a room the caller cannot reach', async () => {
    const emil = await register(f, 'emil@example.com', 'Emil');
    await f.post('/v1/memory', { body: 'Allergisk mot ketchup', explicit: true }, emil.token);

    const jacob = await register(f, 'jacob@example.com', 'Jacob');
    const since = new Date(Date.now() - 60_000).toISOString();
    const res = await f.get(`/v1/search?since=${encodeURIComponent(since)}`, jacob.token);
    const json = await res.json();

    expect(json.hits.every((hit: { text: string }) => !hit.text.includes('ketchup'))).toBe(true);
  });
});

describe('how a memory changed — ?changes=1', () => {
  const before = 'Styrelsemötet ligger den 15 oktober';
  const after = 'Styrelsemötet ligger inte den 15 oktober';

  /** Saves, then corrects — which queues, and accepting it supersedes the original. */
  async function correctedFact(personId: PersonId, token: string): Promise<string> {
    await f.post('/v1/memory', { body: before, kind: 'fact', explicit: true }, token);

    const queued = await f.post('/v1/memory', { body: after, kind: 'fact', explicit: true }, token);
    if (queued.status !== 202) {
      throw new Error(`förväntade ett förslag för korrigeringen, fick ${queued.status}`);
    }
    const { proposal } = await queued.json();

    // Approved by the person, not by the client that queued it.
    const accepted = await f.post(
      `/v1/memory/proposals/${proposal.id}`,
      { accept: true },
      await f.signInFirstParty(personId),
    );
    const { item } = await accepted.json();
    return item.shortId;
  }

  it('returns the chain of values rather than ranked hits', async () => {
    const { person, token } = await register(f, 'emil@example.com', 'Emil');
    const shortId = await correctedFact(person.id, token);

    const res = await f.get('/v1/search?q=styrelsem%C3%B6tet&changes=1', token);
    const json = await res.json();

    expect(json.hits).toBeUndefined();
    const chain = json.changes.find((c: { shortId: string }) => c.shortId === shortId);
    expect(chain).toBeTruthy();
    expect(chain.changeCount).toBe(1);
    expect(chain.currentBody).toBe(after);
    expect(chain.steps.map((s: { body: string }) => s.body)).toEqual([before, after]);
    expect(chain.steps[1].previousBody).toBe(before);
    expect(chain.steps[0].source).toBeTruthy();
  });

  it('finds the chain by the wording the memory no longer uses', async () => {
    const { person, token } = await register(f, 'emil@example.com', 'Emil');
    const shortId = await correctedFact(person.id, token);

    const json = await (await f.get('/v1/search?q=15%20oktober&changes=1', token)).json();

    expect(json.changes.some((c: { shortId: string }) => c.shortId === shortId)).toBe(true);
  });

  it('has nothing for a deleted memory, and does not quote what it used to say', async () => {
    const { person, token } = await register(f, 'emil@example.com', 'Emil');
    const shortId = await correctedFact(person.id, token);
    await f.del(`/v1/memory/${shortId}`, token);

    for (const q of ['styrelsem%C3%B6tet', '15%20oktober']) {
      const json = await (await f.get(`/v1/search?q=${q}&changes=1`, token)).json();
      expect(json.changes).toEqual([]);
      expect(JSON.stringify(json)).not.toContain('15 oktober');
    }
  });

  it('never returns a chain from a room the caller cannot reach', async () => {
    const emil = await register(f, 'emil@example.com', 'Emil');
    await correctedFact(emil.person.id, emil.token);

    const jacob = await register(f, 'jacob@example.com', 'Jacob');
    const json = await (
      await f.get('/v1/search?q=styrelsem%C3%B6tet&changes=1', jacob.token)
    ).json();

    expect(json.changes).toEqual([]);
  });
});

/**
 * The calendar, and what it says about a room the caller may not read.
 *
 * Two real people over HTTP rather than a service call, because the leak was in the seam:
 * `scopeFor()` returned an empty scope for an inaccessible room and `day()` carried on to a
 * completely unscoped `SELECT title FROM app.room`. So a protected room answered 200 with
 * its own title and a fictional id answered 200 with `null` — which both hands out a name
 * that is frequently the sensitive part ("Vårdplan", "Uppsägningar") and makes the id space
 * enumerable by the difference between the two answers.
 *
 * The assertions are the status *and* the absence of the title, because either one alone
 * passes for the wrong reason: a 404 whose body still carried `roomTitle` would satisfy the
 * first, and the fictional-room case satisfies the second while telling the caller the room
 * does not exist.
 */
describe('a room the caller cannot read looks like a room that does not exist', () => {
  const today = () => new Date().toISOString().slice(0, 10);

  it('answers a protected room and a fictional one identically', async () => {
    const emil = await register(f, 'emil@example.com', 'Emil');
    const created = await f.post('/v1/rooms', { title: 'Vårdplan' }, emil.token);
    const { room } = await created.json();

    const jacob = await register(f, 'jacob@example.com', 'Jacob');

    const protectedRoom = await f.get(
      `/v1/calendar/day?date=${today()}&room=${room.id}`,
      jacob.token,
    );
    const fictional = await f.get(
      `/v1/calendar/day?date=${today()}&room=00000000-0000-4000-8000-000000000000`,
      jacob.token,
    );

    expect(protectedRoom.status).toBe(404);
    expect(fictional.status).toBe(404);

    const leaked = await protectedRoom.text();
    expect(leaked).not.toContain('Vårdplan');
    expect(leaked).toBe(await fictional.text());
  });

  it('still answers the person’s own room, with its title', async () => {
    // The other half: the fix has to be a permission check and not a removed feature.
    const emil = await register(f, 'emil@example.com', 'Emil');
    const created = await f.post('/v1/rooms', { title: 'Vårdplan' }, emil.token);
    const { room } = await created.json();

    const own = await f.get(`/v1/calendar/day?date=${today()}&room=${room.id}`, emil.token);

    expect(own.status).toBe(200);
    expect((await own.json()).roomTitle).toBe('Vårdplan');
  });

  it('does not name it in the whole-calendar view either', async () => {
    const emil = await register(f, 'emil@example.com', 'Emil');
    await f.post('/v1/rooms', { title: 'Uppsägningar' }, emil.token);

    const jacob = await register(f, 'jacob@example.com', 'Jacob');
    const day = await f.get(`/v1/calendar/day?date=${today()}`, jacob.token);

    expect(day.status).toBe(200);
    expect(await day.text()).not.toContain('Uppsägningar');
  });
});

/**
 * The approval gate, from the side an attacker is actually on.
 *
 * The realistic threat here is not prompt injection: there is no MCP tool for `share` or
 * `move`, so a model that read a hostile document cannot reach either through its declared
 * tool surface. It is a stolen or over-scoped bearer token talking to this API directly,
 * which is why these tests are about what a token can do rather than about what a model can
 * be talked into.
 */
describe('a token cannot confirm a share on a person’s behalf', () => {
  async function roomAndMemory() {
    const emil = await register(f, 'emil@example.com', 'Emil');
    const created = await f.post('/v1/rooms', { title: 'Buyersclub Ledning' }, emil.token);
    const { room } = await created.json();

    const saved = await f.post('/v1/memory', { body: 'Allergisk mot ketchup' }, emil.token);
    const { item } = await saved.json();

    return { emil, roomId: room.id as string, shortId: item.shortId as string };
  }

  it('refuses the request outright when it carries confirmed', async () => {
    const { emil, roomId, shortId } = await roomAndMemory();

    // `confirmed: true` used to place the memory immediately. The schema is strict rather
    // than silently dropping the field, so an old client is told the endpoint will not do
    // that instead of being answered as though it had asked for something else.
    const res = await f.post(
      `/v1/memory/${shortId}/share`,
      { toRoomId: roomId, confirmed: true },
      emil.token,
    );

    expect(res.status).toBe(400);
  });

  it('queues a proposal instead, and shares nothing', async () => {
    const { emil, roomId, shortId } = await roomAndMemory();

    const res = await f.post(`/v1/memory/${shortId}/share`, { toRoomId: roomId }, emil.token);
    expect(res.status).toBe(202);
    expect((await res.json()).outcome).toBe('needs_approval');

    // Nothing is in the room until a person answers the queue.
    const items = await (await f.get(`/v1/rooms/${roomId}/items`, emil.token)).json();
    expect(items.items).toEqual([]);
  });

  it('refuses a move that carries confirmed the same way', async () => {
    const { emil, roomId, shortId } = await roomAndMemory();

    const res = await f.post(
      `/v1/memory/${shortId}/move`,
      { toRoomId: roomId, confirmed: true },
      emil.token,
    );

    expect(res.status).toBe(400);
  });

  it('places it only once the person answers the queue from their own browser', async () => {
    const { emil, roomId, shortId } = await roomAndMemory();

    const queued = await f.post(`/v1/memory/${shortId}/share`, { toRoomId: roomId }, emil.token);
    const { proposal } = await queued.json();

    // The client that asked cannot answer: `firstPartyOnly` is the whole point.
    const byClient = await f.post(
      `/v1/memory/proposals/${proposal.id}`,
      { accept: true },
      emil.token,
    );
    expect(byClient.status).toBe(403);

    const byPerson = await f.post(
      `/v1/memory/proposals/${proposal.id}`,
      { accept: true },
      await f.signInFirstParty(emil.person.id),
    );
    expect(byPerson.status).toBe(200);

    const items = await (await f.get(`/v1/rooms/${roomId}/items`, emil.token)).json();
    expect(items.items.map((item: { body: string }) => item.body)).toContain(
      'Allergisk mot ketchup',
    );
  });
});

describe('the context budget an API can honour', () => {
  it('refuses a budget below the floor instead of quietly exceeding it', async () => {
    // `?budget=500` used to be validated, documented and answered with a string well
    // over the budget it named: the preamble, the Compass, the confirmation style and the
    // data boundary are reserved and never given up, and they cost roughly ten times the
    // old minimum of 100. A small lie, and one only found by measuring the response.
    const { token } = await register(f, 'emil@example.com', 'Emil');

    const res = await f.get(`/v1/context?budget=${MIN_HONOURABLE_BUDGET_TOKENS - 1}`, token);

    expect(res.status).toBe(400);
    // The message names the minimum, so the next request can be right.
    expect(JSON.stringify(await res.json())).toMatch(/minst \d+/);
  });

  it('reports what was asked for next to what it sent, so neither has to be assumed', async () => {
    const { token } = await register(f, 'emil@example.com', 'Emil');
    await f.post('/v1/memory', { body: 'Allergisk mot ketchup', explicit: true }, token);
    await f.wired.runJobsToCompletion();

    const asked = MIN_HONOURABLE_BUDGET_TOKENS + 900;
    const res = await f.get(`/v1/context?budget=${asked}`, token);
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.budgetTokens).toBe(asked);
    // `tokenCount` describes the string the caller was actually handed, rather than one
    // rendered against a different ceiling — which is what the bundle carrying its own
    // budget bought. The floor covers the un-droppable text; a person's own profile can
    // push the real minimum higher, so the pair being checkable is the honest part.
    expect(json.tokenCount).toBe(estimateTokens(json.rendered));
    expect(json.tokenCount).toBeLessThanOrEqual(asked);
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

  it('delivers all six Personal Compass principles to a brand-new account', async () => {
    const { token } = await register(f, 'emil@example.com', 'Emil');

    const profile = await (await f.get('/v1/profile', token)).json();

    expect(profile.profile.compass).toHaveLength(6);
    expect(profile.profile.compass.every((entry: { source: string }) => entry.source === 'default')).toBe(
      true,
    );

    const context = await (await f.get('/v1/context', token)).json();
    expect(context.rendered).toMatch(/Personens kompass/);
  });
});

describe('the person’s own first name', () => {
  /**
   * No `displayName` at registration, the way phone sign-up leaves it: unset.
   * Registering by email falls back to the local part (`emil@…` → "Emil"), which is
   * the right behaviour for that path but not what a phone-only account has, so this
   * registers by phone instead, matching `verifyCode`'s `register({ phone })`.
   */
  async function registerNameless(f: Fixture, phone: string) {
    const { person } = await f.wired.services.identity.register({ phone });
    const token = await f.signIn(person);
    return { person, token };
  }

  it('is unset on a brand-new account, never rendered as empty or undefined', async () => {
    const { token } = await registerNameless(f, '+46701111111');
    const account = await (await f.get('/v1/account', token)).json();
    expect(account.firstName).toBeNull();
  });

  it('is set from the account screen and reaches provenance, invites and membership', async () => {
    const emil = await registerNameless(f, '+46701111112');
    const firstParty = await f.signInFirstParty(emil.person.id);

    const set = await (
      await f.patch('/v1/account/name', { firstName: '  Jacob  ' }, firstParty)
    ).json();
    expect(set.firstName).toBe('Jacob');

    const account = await (await f.get('/v1/account', emil.token)).json();
    expect(account.firstName).toBe('Jacob');

    // Room membership: the person's own name shows up beside anyone else's.
    const room = await (await f.post('/v1/rooms', { title: 'Buyersclub Ledning' }, emil.token)).json();
    const detail = await (await f.get(`/v1/rooms/${room.room.id}`, emil.token)).json();
    expect(detail.members).toContainEqual(
      expect.objectContaining({ displayName: 'Jacob', isSelf: true }),
    );

    // Invites: the recipient sees who invited them.
    const invite = await (
      await f.post(
        `/v1/rooms/${room.room.id}/invites`,
        { channel: 'email', destination: 'anna@example.com' },
        emil.token,
      )
    ).json();
    const token = invite.url.split('/').filter(Boolean).at(-1) as string;
    const preview = await (await f.get(`/v1/invites/${token}`)).json();
    expect(preview.invitedByName).toBe('Jacob');

    // Provenance/history: who wrote a memory now has a name instead of falling back to
    // null (rendered as "Någon" downstream) — the exact gap this feature closes.
    await f.post('/v1/memory', { body: 'Allergisk mot ketchup' }, emil.token);
    const history = await (await f.get('/v1/history', emil.token)).json();
    expect(history.entries[0]).toMatchObject({ actorName: 'Jacob' });
  });

  it('supersedes an old name rather than sitting beside it', async () => {
    const emil = await registerNameless(f, '+46701111113');
    const firstParty = await f.signInFirstParty(emil.person.id);

    await f.patch('/v1/account/name', { firstName: 'Jacob' }, firstParty);
    await f.patch('/v1/account/name', { firstName: 'Jonas' }, firstParty);

    const account = await (await f.get('/v1/account', emil.token)).json();
    expect(account.firstName).toBe('Jonas');
  });

  it('cannot be set by a connected AI client, however broad its scope', async () => {
    const { token } = await registerNameless(f, '+46701111114');

    const response = await f.patch('/v1/account/name', { firstName: 'Jacob' }, token);
    expect(response.status).toBe(403);
  });

  it('refuses "name" as an ordinary memory kind', async () => {
    const { token } = await register(f, 'emil@example.com', 'Emil');

    const response = await f.post('/v1/memory', { body: 'Jacob', kind: 'name' }, token);
    expect(response.status).toBe(400);
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

    await saveIntoRoom(f, emil.token, {
      roomId: created.room.id,
      body: 'Vi beslutade att skjuta förvärvet till Q3',
      kind: 'decision',
    });
    await saveIntoRoom(f, emil.token, {
      roomId: created.room.id,
      body: 'Anna äger due diligence',
      kind: 'fact',
    });

    const res = await f.get(`/v1/rooms/${created.room.id}/items`, emil.token);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'decision',
          body: 'Vi beslutade att skjuta förvärvet till Q3',
          shortId: expect.stringMatching(/^[a-z]-[23456789abcdefghjkmnpqrstuvwxyz]{4,6}$/),
        }),
        expect.objectContaining({
          kind: 'fact',
          body: 'Anna äger due diligence',
          shortId: expect.stringMatching(/^[a-z]-[23456789abcdefghjkmnpqrstuvwxyz]{4,6}$/),
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
    expect(body.documents).toHaveLength(1);
    expect(body.documents[0]).toMatchObject({
      id: uploaded.documentId,
      filename: 'Due diligence-paket Q3.pdf',
    });

    // The card fields, never the contents. Asserted as what must be absent rather than
    // as an exact key list: the extracted text and the original bytes can each be
    // megabytes and have their own endpoints, and a list that sometimes carries one is a
    // list that sometimes times out. Pinning the exact keys instead would also fail
    // every time a label is added, which is not the thing worth protecting.
    for (const doc of body.documents) {
      expect(doc).not.toHaveProperty('text');
      expect(doc).not.toHaveProperty('bytes');
      expect(doc).not.toHaveProperty('storageKey');
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
      // Full capabilities, narrowed rooms. The point of this test is that the room
      // narrowing bites even when nothing else does.
      scopes: [...SUPPORTED_SCOPES],
      roomScope: [created.room.id],
      expiresAt: null,
    });

    expect((await f.post('/v1/memory', { body: 'I mitt personliga rum' }, narrow)).status).toBe(404);
    // 202 rather than 201: in scope, and queued because the room is shared. A 404 here
    // would mean the token's scope rejected a room it was issued for.
    expect(
      (
        await f.post(
          '/v1/memory',
          { roomId: created.room.id, body: 'I det delade rummet', explicit: true },
          narrow,
        )
      ).status,
    ).toBe(202);
  });
});

describe('being invited', () => {
  it('shows the room before asking for an account', async () => {
    const emil = await register(f, 'emil@example.com', 'Emil');
    const created = await (await f.post('/v1/rooms', { title: 'Buyersclub Ledning' }, emil.token)).json();
    await saveIntoRoom(f, emil.token, {
      roomId: created.room.id,
      body: 'Vi beslutade att skjuta förvärvet till Q3',
    });

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

  /**
   * The product app used to carry its own invite landing at `/i/:token` whose "Gå med"
   * only set React state: a success screen that joined nothing. It is deleted rather than
   * finished, because two copies of the first thing anyone sees of this product drift, and
   * generated links have always pointed at `/invite/:token`. The short path redirects so a
   * link somebody already shared still lands on the screen that accepts invites.
   */
  it('redirects the short invite path to the landing that accepts invites', async () => {
    const response = await f.app.request('/i/abc123');

    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe('/invite/abc123');
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
      await f.post('/v1/signup/request', { phone: '070-123 45 67' })
    ).json();

    // The masked hint is what goes on screen; the number never comes back.
    expect(requested.channel).toBe('sms');
    expect(requested.destinationHint).toBe('070-••• 45 67');

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
      await f.post('/v1/signup/request', { phone: '070-123 45 67' })
    ).json();

    const res = await f.post('/v1/signup/verify', { requestId: requested.requestId, code: '000000' });
    expect(res.status).toBe(401);
  });

  /**
   * The route the form no longer takes, closed at the endpoint too.
   *
   * Email is not configured to reach anybody, so a `200` here would be a request id for a
   * code that never arrives — the same dead end as leaving the field on screen, only
   * reachable from a saved link instead of a button.
   */
  it('refuses to send a code to an email address', async () => {
    const res = await f.post('/v1/signup/request', { email: 'ny@example.com' });

    expect(res.status).toBe(400);
    expect((await res.json()).message).toContain('SMS');
    expect(f.sender.sent).toEqual([]);
  });

  it('refuses a number that is not a Swedish mobile number, and says why', async () => {
    const res = await f.post('/v1/signup/request', { phone: '08-123 45 67' });

    expect(res.status).toBe(400);
    expect((await res.json()).message).toMatch(/börjar på 070/);
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
    const { person, token } = await register(f, 'emil@example.com', 'Emil');
    await f.post('/v1/import', { text: '- User is allergic to ketchup' }, token);

    const pending = await (await f.get('/v1/memory/proposals', token)).json();
    const res = await f.post(
      `/v1/memory/proposals/${pending.proposals[0].id}`,
      { accept: true },
      await f.signInFirstParty(person.id),
    );
    expect(res.status).toBe(200);

    await f.wired.runJobsToCompletion();
    const context = await (await f.get('/v1/context', token)).json();
    expect(context.rendered).toContain('ketchup');
  });

  /**
   * The takeover chain, end to end, asserted refused.
   *
   * This would have passed — in the sense of completing the takeover — on `main` at
   * `10179fa`, and it is written as the chain rather than as a unit test of the verifier
   * because each link was individually defensible and only the composition was fatal:
   *
   *   1. `GET /v1/rooms/:id` discloses every member's `personId`
   *   2. session tokens were verified by shape (`session-<personId>-<n>`), so the id was
   *      the credential
   *   3. the resulting session was stamped `FIRST_PARTY_CLIENT_ID` with every scope, so
   *      it satisfied `firstPartyOnly` — export, account deletion, the approval queue
   *
   * Verified against production before the fix: forged tokens returned 200 on
   * `/v1/export`, `/v1/account/deletion` and `/v1/clients`, and one completed an OAuth
   * authorization that minted a durable grant with a refresh token — a credential that
   * would have survived the session fix entirely.
   *
   * The assertion is deliberately the whole chain and not just "the verifier rejects a
   * bad token": what made this reachable was a disclosed id meeting a shape check, and a
   * future change could reintroduce either half without touching `readSignedSession`.
   */
  describe('a co-member cannot become you (regression)', () => {
    it('refuses a forged session, and the room no longer discloses a personId to forge one from', async () => {
      const emil = await register(f, 'emil@example.com', 'Emil');

      // A room, and a private memory that must not travel.
      const created = await (await f.post('/v1/rooms', { title: 'Buyersclub Ledning' }, emil.token)).json();
      await f.post('/v1/memory', { body: 'Kodordet är 4711' }, emil.token);

      // Step 1 used to be: `GET /v1/rooms/:id` discloses every member's `personId`. That
      // disclosure is now closed (see `serialiseRoom`/`roomRoutes` — `members` carries
      // `displayName` and `role` only), asserted here so a future change cannot silently
      // reopen it. `emilsId` below comes from the account this test itself created
      // rather than from the API, because steps 2 and 3 are the regression that still
      // matters regardless of how a personId became known: it must never be a credential.
      const room = await (await f.get(`/v1/rooms/${created.room.id}`, emil.token)).json();
      for (const member of room.members as Array<Record<string, unknown>>) {
        expect(member).not.toHaveProperty('personId');
      }
      const emilsId = emil.person.id;

      // Step 2: the id is not a credential. Every shape the old verifier accepted.
      for (const forged of [
        `session-${emilsId}-1`,
        `session-${emilsId}-42`,
        `session-${emilsId}--99999`,
        `ps1.${Buffer.from(String(emilsId), 'utf8').toString('base64url')}.nonce.sig`,
      ]) {
        const asHeader = await f.get('/v1/context', forged);
        expect(asHeader.status, forged).toBe(401);

        // And as a cookie, which is the same credential by another door.
        const asCookie = await f.app.request('https://photographic.test/v1/context', {
          headers: { cookie: `photographic_sid=${forged}` },
        });
        expect(asCookie.status, forged).toBe(401);
      }

      // Step 3: the first-party surface stays closed to it, which is what made the
      // forgery worth attempting rather than merely a read of someone's room.
      for (const path of ['/v1/export', '/v1/account/deletion', '/v1/clients']) {
        const res = await f.get(path, `session-${emilsId}-1`);
        expect(res.status, path).toBe(401);
      }

      // And the private memory never left.
      const leaked = await f.get('/v1/context', `session-${emilsId}-1`);
      expect(await leaked.text()).not.toContain('4711');
    });
  });

  /**
   * The cookie is additive. These assert the three properties that make it safe rather
   * than convenient: it authenticates, it does not disturb bearer auth, and it cannot be
   * used to mutate from another site.
   */
  describe('the browser session cookie', () => {
    const cookieRequest = (path: string, init: RequestInit & { cookie?: string } = {}) =>
      f.app.request(`https://photographic.test${path}`, {
        ...init,
        headers: {
          'content-type': 'application/json',
          ...(init.cookie ? { cookie: init.cookie } : {}),
          ...(init.headers ?? {}),
        },
      }) as Promise<TestResponse>;

    it('authenticates a read with no Authorization header at all', async () => {
      const { person } = await register(f, 'emil@example.com', 'Emil');
      const token = await f.signInFirstParty(person.id);

      const res = await cookieRequest('/v1/profile', { cookie: `photographic_sid=${token}` });

      expect(res.status).toBe(200);
    });

    it('is refused on a mutating request from another site, even though it is valid', async () => {
      const { person } = await register(f, 'emil@example.com', 'Emil');
      const token = await f.signInFirstParty(person.id);

      // What a cross-site form post looks like: the browser attaches the cookie itself,
      // which is the whole reason this needs a second lock beyond SameSite.
      const res = await cookieRequest('/v1/memory', {
        method: 'POST',
        body: JSON.stringify({ body: 'Skrivet av någon annan' }),
        cookie: `photographic_sid=${token}`,
        headers: { origin: 'https://evil.example' },
      });

      expect(res.status).toBe(403);
      expect((await res.json()).error.code).toBe('forbidden');
    });

    it('allows the same mutating request from our own page', async () => {
      const { person } = await register(f, 'emil@example.com', 'Emil');
      const token = await f.signInFirstParty(person.id);

      const res = await cookieRequest('/v1/memory', {
        method: 'POST',
        body: JSON.stringify({ body: 'Skrivet inifrån Photographic' }),
        cookie: `photographic_sid=${token}`,
        headers: { origin: 'https://photographic.test' },
      });

      expect(res.status).toBe(201);
    });

    it('refuses a mutating cookie request that names no origin rather than trusting it', async () => {
      const { person } = await register(f, 'emil@example.com', 'Emil');
      const token = await f.signInFirstParty(person.id);

      const res = await cookieRequest('/v1/memory', {
        method: 'POST',
        body: JSON.stringify({ body: 'Utan origin' }),
        cookie: `photographic_sid=${token}`,
      });

      expect(res.status).toBe(403);
    });

    it('leaves bearer auth alone, including without an origin', async () => {
      // An MCP client sends no `Origin` and must be unaffected: a bearer token is not
      // attached by a browser on its own, so it was never exposed to this attack.
      const { token } = await register(f, 'emil@example.com', 'Emil');

      const res = await f.post('/v1/memory', { body: 'Sparat av en klient' }, token);

      expect(res.status).toBe(201);
    });

    it('prefers the bearer token when both are present, so a cookie cannot shadow a client', async () => {
      const emil = await register(f, 'emil@example.com', 'Emil');
      const jacob = await register(f, 'jacob@example.com', 'Jacob');
      const jacobCookie = await f.signInFirstParty(jacob.person.id);

      const res = await cookieRequest('/v1/profile', {
        cookie: `photographic_sid=${jacobCookie}`,
        headers: { authorization: `Bearer ${emil.token}` },
      });

      // Emil's profile, from Emil's bearer token, with Jacob's cookie ignored.
      expect(res.status).toBe(200);
      expect((await res.json()).profile.rendered).not.toContain('Jacob');
    });

    it('does not let a cookie satisfy a route that requires a real client', async () => {
      // `firstPartyOnly` is the *other* direction and is asserted elsewhere. What matters
      // here is that a cookie is first-party rather than a way to impersonate a client:
      // the client-scoped surface still reports the browser as the first-party client.
      const { person } = await register(f, 'emil@example.com', 'Emil');
      const token = await f.signInFirstParty(person.id);

      const res = await cookieRequest('/v1/clients', { cookie: `photographic_sid=${token}` });

      expect(res.status).toBe(200);
      const listed = (await res.json()).clients as Array<{ agentClient: string }>;
      expect(listed.every((client) => client.agentClient !== 'first-party')).toBe(true);
    });
  });

  it('records an approval as an approval', async () => {
    const { person, token } = await register(f, 'emil@example.com', 'Emil');
    await f.post('/v1/import', { text: '- User is allergic to ketchup' }, token);
    const pending = await (await f.get('/v1/memory/proposals', token)).json();
    await f.post(
      `/v1/memory/proposals/${pending.proposals[0].id}`,
      { accept: true },
      await f.signInFirstParty(person.id),
    );

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

    expect((await request('/v1/signup/request', { phone: '070-111 11 11' })).status).toBe(200);
    expect((await request('/v1/signup/request', { phone: '070-222 22 22' })).status).toBe(200);

    // Verify shares the budget: otherwise the cheap half is metered and the half that
    // guesses codes is not.
    const limited = await request('/v1/signup/verify', { requestId: 'x', code: '000000' });
    expect(limited.status).toBe(429);
    expect(limited.headers.get('retry-after')).toBeTruthy();

    // A different caller is unaffected.
    const elsewhere = await app.request('https://photographic.test/v1/signup/request', {
      method: 'POST',
      body: JSON.stringify({ phone: '070-333 33 33' }),
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

/**
 * One OAuth origin, even though one process answers on two hostnames.
 *
 * The issuer, the registered redirect URIs and the `resource` a client sends all derive
 * from `PUBLIC_URL`. If the apex also served `/oauth/*` and the metadata documents, a
 * client could discover the authorization server under a name the issuer never mentions,
 * authorize against one origin and hold tokens minted for another — which surfaces as an
 * intermittent auth failure rather than as a misconfiguration anyone would look for.
 */
describe('the apex is not a second OAuth origin', () => {
  function apexApp() {
    return createApp({
      services: createMemoryServices().services,
      config: resolveConfig({
        publicUrl: 'https://mcp.photographic.test',
        apexHost: 'photographic.test',
        environment: 'test',
        notFoundFloorMs: 0,
      }),
      logger: silentLogger(),
    });
  }

  // GET-reachable only: `/oauth/token` and `/oauth/register` are POST, and a GET to
  // them is a 404 on either hostname, which would make the comparison meaningless.
  const oauthPaths = [
    '/oauth/authorize',
    '/.well-known/oauth-authorization-server',
    '/.well-known/oauth-protected-resource',
  ];

  it('refuses the OAuth surface on the apex hostname', async () => {
    for (const path of oauthPaths) {
      const response = await apexApp().request(`https://photographic.test${path}`);
      expect(response.status, path).toBe(404);
    }
  });

  it('leaves the same paths reachable on the issuer hostname', async () => {
    for (const path of oauthPaths) {
      const response = await apexApp().request(`https://mcp.photographic.test${path}`);
      expect(response.status, path).not.toBe(404);
    }
  });

  /**
   * The product served on the apex calls these same-origin, and signing in there depends
   * on it, so the refusal must not reach past the OAuth surface.
   */
  it('leaves /v1 and /health working on the apex', async () => {
    for (const path of ['/health', '/v1/rooms']) {
      const response = await apexApp().request(`https://photographic.test${path}`);
      expect(response.status, path).not.toBe(404);
    }
  });
});
