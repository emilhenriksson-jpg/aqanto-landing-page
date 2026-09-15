/**
 * Connecting an AI, all the way through.
 *
 * This is the one journey that has to work before anything else matters: a person opens
 * their AI client, it discovers this server from a 401, registers itself, asks them to
 * log in, and from then on the model knows who they are. Nobody reads documentation and
 * nobody pastes a key.
 *
 * It runs against `createWiring` — the same composition the process serves — rather than
 * a hand-assembled app, because the wiring is where this breaks. Every individual piece
 * has its own tests and they all pass while the login page points at an origin that
 * serves no HTML, or while the resource advertises a scope set that never yields a
 * refresh token. Those are seam bugs, and a seam only shows up when it is crossed.
 */

import { createHash, randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';

import { serve } from '@hono/node-server';
import { BREAK_GLASS_SECRET_MIN_LENGTH, mintBreakGlassToken } from '@photographic/connect';
import type { PersonId } from '@photographic/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { resolveConfig } from './config.js';
import { createLogger } from './logger.js';
import { createWiring } from './wiring.js';

const API = 'http://api.test';
const WEB = 'http://web.test';
/** What a desktop client registers. A private-use scheme, as every shipping client uses. */
const REDIRECT_URI = 'cursor://anysphere.cursor-retrieval/oauth/callback';

const base64url = (value: Buffer) => value.toString('base64url');

/** A distinct Swedish mobile number per sign-up, so two runs are two people. */
const randomMobile = () =>
  `+4670${String(randomBytes(4).readUInt32BE(0) % 10_000_000).padStart(7, '0')}`;

const pkce = () => {
  const verifier = base64url(randomBytes(32));
  return { verifier, challenge: base64url(createHash('sha256').update(verifier).digest()) };
};

/**
 * Served on a real socket rather than through `app.fetch`.
 *
 * MCP answers over server-sent events, and a streaming response only behaves like one
 * when something is actually reading a socket. Going through the fetch handler in-process
 * silently truncates it, which would make this suite prove less than it looks like it
 * does.
 */
async function harness(options: { breakGlassSecret?: string } = {}) {
  const codes: string[] = [];
  const logger = createLogger({ level: 'error' });

  // Read by `createWiring` at construction time, so it is set around that call rather than
  // passed in: break-glass is deliberately configured by the machine's environment and
  // nothing else, and a test that could inject it another way would not be testing the
  // same thing the deploy does.
  const priorSecret = process.env.BREAK_GLASS_SECRET;
  if (options.breakGlassSecret) process.env.BREAK_GLASS_SECRET = options.breakGlassSecret;
  else delete process.env.BREAK_GLASS_SECRET;

  const wiring = await createWiring({
    config: resolveConfig({ publicUrl: API, webUrl: WEB, environment: 'test' }),
    logger: {
      ...logger,
      // The sign-up code only exists in the log in development, which is also the only
      // way a test can read it without reaching into the code store.
      warn: (event, fields) => {
        if (event === 'signup_code' && typeof fields?.['code'] === 'string') {
          codes.push(fields['code']);
        }
      },
    },
  });

  if (priorSecret === undefined) delete process.env.BREAK_GLASS_SECRET;
  else process.env.BREAK_GLASS_SECRET = priorSecret;

  // Port 0: the OS picks one, so a suite running in parallel with the dev server or with
  // itself cannot collide.
  const server = await new Promise<ReturnType<typeof serve>>((resolve) => {
    const listening = serve({ fetch: wiring.app.fetch, hostname: '127.0.0.1', port: 0 }, () =>
      resolve(listening),
    );
  });

  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const call = (path: string, init?: RequestInit) =>
    fetch(`${origin}${path}`, { ...init, redirect: 'manual' });

  const json = async (path: string, init?: RequestInit) => {
    const response = await call(path, init);
    return { response, body: (await response.json()) as Record<string, unknown> };
  };

  const postJson = (path: string, body: unknown, token?: string) =>
    json(path, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
    });

  const postForm = (path: string, fields: Record<string, string>) =>
    call(path, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(fields),
    });

  /**
   * Signs a person up and returns both who they are and the session the browser keeps.
   *
   * Takes the number because the break-glass tests need to sign in *as a known account*
   * — the whole point of that path is reaching one specific person — while every other
   * caller only wants some account and lets it default.
   */
  const signInAsPerson = async (phone = randomMobile()) => {
    const requested = await postJson('/v1/signup/request', { phone });
    const verified = await postJson('/v1/signup/verify', {
      requestId: requested.body['requestId'],
      code: codes.at(-1),
    });
    const session = verified.body['session'] as { token: string };
    const person = verified.body['person'] as { id: string };
    return { token: session.token, personId: person.id };
  };

  /** Signs a person up and returns the session token the browser keeps. */
  const signIn = async (phone?: string) => (await signInAsPerson(phone)).token;

  const registerClient = (overrides: Record<string, unknown> = {}) =>
    postJson('/oauth/register', {
      client_name: 'Cursor',
      redirect_uris: [REDIRECT_URI],
      token_endpoint_auth_method: 'none',
      ...overrides,
    });

  const startAuthorization = (clientId: string, params: Record<string, string> = {}) => {
    const query = new URLSearchParams({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: REDIRECT_URI,
      code_challenge_method: 'S256',
      scope: wiring.auth.config.scopesSupported.join(' '),
      ...params,
    });
    return call(`/oauth/authorize?${query.toString()}`);
  };

  return {
    wiring,
    call,
    json,
    postJson,
    postForm,
    signIn,
    signInAsPerson,
    registerClient,
    startAuthorization,
    origin,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

type Harness = Awaited<ReturnType<typeof harness>>;

describe('connecting an AI with nobody reading instructions', () => {
  let h: Harness;

  beforeAll(async () => {
    h = await harness();
  });

  afterAll(async () => {
    await h.close();
  });

  it('points an unauthenticated MCP call at the metadata that explains how to log in', async () => {
    const response = await h.call('/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
    });

    expect(response.status).toBe(401);

    // Without this header the 401 is a dead end and every client needs setting up by
    // hand, which is the entire problem this product exists to remove.
    const challenge = response.headers.get('www-authenticate') ?? '';
    const metadataUrl = challenge.match(/resource_metadata="([^"]+)"/)?.[1];
    expect(metadataUrl).toBe(`${API}/.well-known/oauth-protected-resource/mcp`);
  });

  it('describes the resource as the endpoint the client actually called', async () => {
    // A strict RFC 9728 client compares this to the URL it connected to and refuses on a
    // mismatch, so reporting the origin here would break the flow before it starts.
    const { body } = await h.json('/.well-known/oauth-protected-resource/mcp');

    expect(body['resource']).toBe(`${API}/mcp`);
    expect(body['authorization_servers']).toEqual([API]);
  });

  it('advertises a scope set that yields a refresh token', async () => {
    // A client asks for exactly what the resource advertises. A list that came up short
    // of offline_access would hand every client an hour of access and no way to renew
    // it, and the connection would stop working long after anyone was watching.
    const { body } = await h.json('/.well-known/oauth-protected-resource/mcp');
    const resource = body['scopes_supported'] as string[];

    expect(resource).toContain('offline_access');

    const { body: server } = await h.json('/.well-known/oauth-authorization-server');
    expect(server['scopes_supported']).toEqual(resource);
  });

  it('registers a client that nobody entered in a console', async () => {
    const { response, body } = await h.registerClient();

    expect(response.status).toBe(201);
    expect(body['client_id']).toMatch(/^pgm_client_/);
    // Public client: software on a person's machine cannot hold a secret, and issuing one
    // would only mean shipping it inside something they can read.
    expect(body['client_secret']).toBeUndefined();
    expect(body['redirect_uris']).toEqual([REDIRECT_URI]);
  });

  it('sends the person to the web app to log in, not to the API', async () => {
    const { body: client } = await h.registerClient();
    const response = await h.startAuthorization(client['client_id'] as string, {
      code_challenge: pkce().challenge,
    });

    expect(response.status).toBe(302);

    const location = new URL(response.headers.get('location') as string);
    expect(location.origin).toBe(WEB);
    expect(location.pathname).toBe('/login');
    expect(location.searchParams.get('auth_request')).toBeTruthy();
  });

  it('tells the login page what it is asking the person to approve', async () => {
    const { body: client } = await h.registerClient({ client_name: 'Claude Desktop' });
    const started = await h.startAuthorization(client['client_id'] as string, {
      code_challenge: pkce().challenge,
    });
    const requestId = new URL(started.headers.get('location') as string).searchParams.get(
      'auth_request',
    );

    const { body } = await h.json(`/oauth/authorize/request?auth_request=${requestId}`);

    expect(body['clientName']).toBe('Claude Desktop');
    expect(body['scopes']).toContain('memory.read');
  });

  it('carries a person from a cold start to a model that knows them', async () => {
    const { verifier, challenge } = pkce();
    const state = base64url(randomBytes(8));

    const { body: client } = await h.registerClient();
    const clientId = client['client_id'] as string;

    const started = await h.startAuthorization(clientId, {
      code_challenge: challenge,
      state,
      resource: `${API}/mcp`,
    });
    const requestId = new URL(started.headers.get('location') as string).searchParams.get(
      'auth_request',
    ) as string;

    const sessionToken = await h.signIn();
    const approved = await h.postJson(
      '/oauth/authorize/approve',
      { requestId, approved: true },
      sessionToken,
    );

    expect(approved.response.status).toBe(200);

    const back = new URL(approved.body['redirectUrl'] as string);
    // `state` has to come back, or a client cannot match the response to the request it
    // started and hangs waiting for one that already arrived.
    expect(back.searchParams.get('state')).toBe(state);
    const code = back.searchParams.get('code') as string;

    const exchanged = await h.postForm('/oauth/token', {
      grant_type: 'authorization_code',
      code,
      redirect_uri: REDIRECT_URI,
      client_id: clientId,
      code_verifier: verifier,
    });

    expect(exchanged.status).toBe(200);
    expect(exchanged.headers.get('cache-control')).toBe('no-store');

    const tokens = (await exchanged.json()) as Record<string, string>;
    expect(tokens['token_type']).toBe('Bearer');
    expect(tokens['refresh_token']).toBeTruthy();

    // And now the part the person notices: the model already knows them.
    const mcp = await mcpSession(h, tokens['access_token'] as string);

    expect(mcp.instructions.length).toBeGreaterThan(0);
    expect(mcp.tools).toContain('remember');
    expect(mcp.tools).toContain('list_trash');
  });

  it('keeps a connection working past the first hour', async () => {
    const { tokens, clientId } = await connected(h);

    const refreshed = await h.postForm('/oauth/token', {
      grant_type: 'refresh_token',
      refresh_token: tokens['refresh_token'] as string,
      client_id: clientId,
    });

    expect(refreshed.status).toBe(200);
    const rotated = (await refreshed.json()) as Record<string, string>;

    // Rotated, not reissued. A refresh token that survived its own use is a credential an
    // attacker who read it once can keep using forever.
    expect(rotated['refresh_token']).not.toBe(tokens['refresh_token']);

    const session = await mcpSession(h, rotated['access_token'] as string);
    expect(session.instructions.length).toBeGreaterThan(0);
  });

  it('remembers something through MCP and finds it again', async () => {
    const { tokens } = await connected(h);
    const accessToken = tokens['access_token'] as string;
    const session = await mcpSession(h, accessToken);

    const written = await session.callTool('remember', {
      text: 'Jag är allergisk mot jordnötter.',
    });
    expect(written).toContain('Sparat');

    const found = await session.callTool('search_memory', { query: 'allergi' });
    expect(found).toContain('jordnötter');
  });

  it('stops honouring a token the moment it is revoked', async () => {
    const { tokens, clientId } = await connected(h);
    const accessToken = tokens['access_token'] as string;

    // Works first, so the 401 below is the revocation and not a token that never worked.
    await mcpSession(h, accessToken);

    await h.postForm('/oauth/revoke', { token: accessToken, client_id: clientId });

    const after = await h.call('/mcp', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });

    expect(after.status).toBe(401);
  });

  /**
   * The paths the first-party app calls, checked against the ones this app serves.
   *
   * Written because they had drifted: the onboarding app asked for `/v1/me/clients` and
   * `/v1/context/rendered`, neither of which ever existed, and every test on both sides
   * passed — the app's tests run against a fake, and the API's tests only ever ask for
   * routes the API defines. The seam had nobody standing on it.
   */
  describe('what the web client asks for', () => {
    it('lists the AI clients a person connected, and not our own app', async () => {
      const sessionToken = await h.signIn();
      const { response, body } = await h.json('/v1/clients', {
        headers: { authorization: `Bearer ${sessionToken}` },
      });

      expect(response.status).toBe(200);

      const listed = body['clients'] as Array<Record<string, unknown>>;
      // Signing in opened a web session. It must not appear: this list is headed "your
      // connected AIs", and the app someone is reading it in is not one of them — least
      // of all with a red light saying it never received their profile.
      expect(listed.map((client) => client['agentClient'])).not.toContain('web');
    });

    it('names each connected client and says whether context arrived the good way', async () => {
      const { tokens } = await connected(h);
      // An MCP connection reports as the client that opened it, which is what puts a
      // light on this list in the first place.
      await mcpSession(h, tokens['access_token'] as string);

      const { body } = await h.json('/v1/clients', {
        headers: { authorization: `Bearer ${tokens['access_token']}` },
      });

      const listed = body['clients'] as Array<Record<string, unknown>>;
      const cursor = listed.find((client) => client['agentClient'] === 'cursor');

      expect(cursor).toBeDefined();
      expect(cursor?.['displayName']).toBe('Cursor');
      // `degraded` is a judgement about what this client was capable of, made here so
      // every surface that asks gets the same answer.
      expect(cursor).toHaveProperty('degraded');
    });

    it('refuses a session token that was made up rather than issued', async () => {
      // The bug this pins down: sessions used to be `session-<personId>-<n>`, checked on
      // shape alone with no signature and no store, so anyone holding a `personId` could
      // mint that person's session. `personId` is not a secret — a shared room hands out
      // its members' ids — so room-mates could authenticate as each other, and because
      // `/oauth/authorize/approve` reads the person from this same token, a forged session
      // could also mint a lasting MCP grant over someone else's whole memory.
      const { personId, token } = await h.signInAsPerson();

      // The real token still works, so this is a test about forgery and not about the
      // endpoint being closed to everyone.
      const genuine = await h.json('/v1/profile', {
        headers: { authorization: `Bearer ${token}` },
      });
      expect(genuine.response.status).toBe(200);

      // Two different forgeries, because they are refused for two different reasons and
      // only the second one tests the signature. The old shape never reaches the session
      // verifier at all now — it fails to look like a session and is offered to OAuth
      // instead — so a test using only that would pass even with signing removed.
      const legacy = [`session-${personId}-1`, `session-${personId}-7`, `session-${personId}-999`];

      // Shaped like a session, carrying the right person, signed with nothing that matches.
      const encodedPerson = Buffer.from(personId, 'utf8').toString('base64url');
      const unsigned = [
        `ps1.${encodedPerson}.nonce.not-a-real-signature`,
        `ps1.${encodedPerson}.nonce.`,
        `ps1.${encodedPerson}..`,
      ];

      for (const forged of [...legacy, ...unsigned]) {
        const attempt = await h.json('/v1/profile', {
          headers: { authorization: `Bearer ${forged}` },
        });
        expect(attempt.response.status, `forged token accepted: ${forged}`).toBe(401);
      }
    });

    it('serves the rendered profile for the paste-it-yourself path', async () => {
      const sessionToken = await h.signIn();
      const { response, body } = await h.json('/v1/profile', {
        headers: { authorization: `Bearer ${sessionToken}` },
      });

      expect(response.status).toBe(200);
      expect(typeof (body['profile'] as Record<string, unknown>)['rendered']).toBe('string');
    });

    it('serves the connect screen without a token, because nobody is signed in yet', async () => {
      const { response, body } = await h.json('/v1/connect');

      expect(response.status).toBe(200);
      expect(body['mcpUrl']).toBe(`${API}/mcp`);
    });
  });

  it('treats a replayed refresh token as theft and cuts the family off', async () => {
    const { tokens, clientId } = await connected(h);

    const refresh = (token: string) =>
      h.postForm('/oauth/token', {
        grant_type: 'refresh_token',
        refresh_token: token,
        client_id: clientId,
      });

    const rotated = (await (await refresh(tokens['refresh_token'] as string)).json()) as Record<
      string,
      string
    >;

    // The old one showing up again means two parties hold it, and we cannot tell which is
    // the person. Everything in the family goes, including the access token just issued.
    expect((await refresh(tokens['refresh_token'] as string)).status).toBe(400);

    const after = await h.call('/mcp', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: `Bearer ${rotated['access_token']}`,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });

    expect(after.status).toBe(401);
  });
});

/**
 * The way in when SMS is not working, driven end to end.
 *
 * Production refuses to deliver a code it can only write to a log, which is right and
 * which would otherwise leave the owner with no door at all. This is the other door, and
 * the reason it is tested here rather than beside the token itself is that everything
 * interesting about it is a seam: the script mints on the machine, the process verifies
 * with the same secret out of the same environment, and what comes back has to be an
 * ordinary session that the ordinary authenticated routes accept. Each half passes its own
 * tests while the credential is useless.
 */
describe('nödinloggning: signing in without SMS and without the log', () => {
  const secret = 'f'.repeat(BREAK_GLASS_SECRET_MIN_LENGTH);
  let h: Harness;
  let phone: string;
  let personId: PersonId;

  beforeAll(async () => {
    h = await harness({ breakGlassSecret: secret });

    // An account that exists, because break-glass is a way back into one and not a way to
    // create one. Signed up through the ordinary flow so nothing here is privileged setup.
    phone = randomMobile();
    await h.signIn(phone);
    const person = await h.wiring.services.identity.findByPhone(phone);
    personId = person?.id as PersonId;
  });

  afterAll(async () => {
    await h.close();
  });

  /** What the script prints, minted the way the script mints it. */
  const mint = () => mintBreakGlassToken({ personId, secret }).token;

  const exchange = (token: string) =>
    h.json('/v1/signup/break-glass', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: h.origin },
      body: JSON.stringify({ token }),
    });

  it('turns a token minted on the machine into a session the product accepts', async () => {
    const { response, body } = await exchange(mint());

    expect(response.status).toBe(200);
    expect(body['ok']).toBe(true);
    // Not in the body. The cookie is httpOnly for a reason and a second copy within reach
    // of page script would undo it.
    expect(JSON.stringify(body)).not.toContain('session-');

    const cookie = response.headers.get('set-cookie') ?? '';
    expect(cookie).toContain('HttpOnly');

    // The actual claim: this is a sign-in, not a 200. A first-party-only route, because
    // being signed in as yourself is exactly what break-glass has to restore.
    const me = await h.json('/v1/clients', {
      headers: { cookie: cookie.split(';')[0] as string },
    });
    expect(me.response.status).toBe(200);
  });

  it('spends the token, so a link left in a scrollback is not a standing credential', async () => {
    const token = mint();

    expect((await exchange(token)).response.status).toBe(200);

    const again = await exchange(token);
    expect(again.response.status).toBe(401);
    expect(again.response.headers.get('set-cookie')).toBeNull();
  });

  it('refuses a token that has expired, judged by the endpoint', async () => {
    const expired = mintBreakGlassToken({
      personId,
      secret,
      now: new Date(Date.now() - 60 * 60 * 1000),
    }).token;

    expect((await exchange(expired)).response.status).toBe(401);
  });

  it('refuses a token signed with anything but the machine secret', async () => {
    const forged = mintBreakGlassToken({
      personId,
      secret: 'g'.repeat(BREAK_GLASS_SECRET_MIN_LENGTH),
    }).token;

    const { response, body } = await exchange(forged);

    expect(response.status).toBe(401);
    // The same sentence a spent or expired token gets: the endpoint is public, and telling
    // the difference apart is how someone learns whether they guessed the key.
    expect((body['error'] as { message: string }).message).toMatch(/Nödkoden gäller inte/);
  });

  it('refuses a session token presented as a break-glass token', async () => {
    // The shapes must not be interchangeable in either direction. This is the one that
    // would matter if a session token ever leaked: it must not also be a way to mint one.
    const sessionToken = await h.signIn();

    expect((await exchange(sessionToken)).response.status).toBe(401);
  });

  it('records every use in the person’s own event log', async () => {
    const before = await h.wiring.services.events.replay({ limit: 1000 });
    await exchange(mint());
    const after = await h.wiring.services.events.replay({ limit: 1000 });

    const added = after.filter(
      (event) => !before.some((earlier) => earlier.seq === event.seq),
    );
    const recorded = added.find((event) => event.eventType === 'session.break_glass_used');

    // In their own room and under their own name, so it sits beside everything else that
    // happened to their memory rather than in an audit file only we can read.
    expect(recorded).toBeDefined();
    expect(recorded?.actorPersonId).toBe(personId);
    // And the record names the token without being the token.
    expect(JSON.stringify(recorded?.payload)).toMatch(/jti/);
  });

  it('reaches the history the person can actually read, not only the log', async () => {
    // The event log is not the claim. "It was audited" only means something if the person
    // whose account it is can see it, so this asserts the feed and not `app.event`.
    //
    // Only the used half, because that is the half this process writes: the minted event is
    // appended by the script, and `e2e/src/journey.test.ts` covers both actions reaching the
    // feed on both drivers rather than either being re-implemented here.
    await exchange(mint());

    const actor = { personId, agentClient: 'web' as const, sessionId: null, roomScope: [] };
    const entries = await h.wiring.services.history.list(actor, { limit: 100 });
    const used = entries.find((entry) => entry.action === 'break_glass_used');

    expect(used).toBeDefined();
    // About the account, not about a memory: a feed line implying a memory changed would be
    // worse than none.
    expect(used?.body).toBeNull();
    expect(used?.shortId).toBeNull();
  });

  it('serves the page that spends the token, with no bundle to build first', async () => {
    const response = await h.call('/nodlage');

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toMatch(/text\/html/);

    const html = await response.text();
    // Reads the token out of the fragment and posts it: the fragment is the one part of a
    // URL that never reaches a server log, a browser history entry, or a Referer header.
    expect(html).toContain('location.hash');
    expect(html).toContain('/v1/signup/break-glass');
  });
});

describe('with no BREAK_GLASS_SECRET set, which is every deployment by default', () => {
  let h: Harness;

  beforeAll(async () => {
    h = await harness();
  });

  afterAll(async () => {
    await h.close();
  });

  it('accepts nothing, and says the same thing to every attempt', async () => {
    // A token that is valid in every other respect. Without a secret on this side there is
    // no second front door, which is what makes shipping this endpoint everywhere safe.
    const token = mintBreakGlassToken({
      personId: '0f1d4a9c-3f9b-4a1f-9c0e-2b7c6d5e4f30',
      secret: 'h'.repeat(BREAK_GLASS_SECRET_MIN_LENGTH),
    }).token;

    const { response } = await h.json('/v1/signup/break-glass', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: h.origin },
      body: JSON.stringify({ token }),
    });

    expect(response.status).toBe(401);
    expect(response.headers.get('set-cookie')).toBeNull();
  });
});

/** A person connected all the way to a token, for the tests that start after that. */
async function connected(h: Harness) {
  const { verifier, challenge } = pkce();
  const { body: client } = await h.registerClient();
  const clientId = client['client_id'] as string;

  const started = await h.startAuthorization(clientId, { code_challenge: challenge });
  const requestId = new URL(started.headers.get('location') as string).searchParams.get(
    'auth_request',
  ) as string;

  const sessionToken = await h.signIn();
  const approved = await h.postJson(
    '/oauth/authorize/approve',
    { requestId, approved: true },
    sessionToken,
  );
  const code = new URL(approved.body['redirectUrl'] as string).searchParams.get('code') as string;

  const exchanged = await h.postForm('/oauth/token', {
    grant_type: 'authorization_code',
    code,
    redirect_uri: REDIRECT_URI,
    client_id: clientId,
    code_verifier: verifier,
  });

  return { tokens: (await exchanged.json()) as Record<string, string>, clientId, sessionToken };
}

/**
 * One JSON-RPC response, read the way a client reads it.
 *
 * Streamable HTTP may answer as JSON or as server-sent events, and when it chooses events
 * the stream stays open for anything the server wants to push later. So this reads until
 * the first complete event arrives rather than to the end of the body — waiting for an
 * end that is not coming is how a test like this hangs, or worse, passes on an empty
 * string.
 */
/** Only the fields this suite reads. */
interface RpcResponse {
  result?: {
    instructions?: string;
    tools?: Array<{ name: string }>;
    content?: Array<{ type: string; text: string }>;
  };
  error?: { code: number; message: string };
}

async function readResult(response: Response): Promise<RpcResponse> {
  if (response.headers.get('content-type')?.includes('text/event-stream') !== true) {
    const text = await response.text();
    return text === '' ? {} : JSON.parse(text);
  }

  const reader = (response.body as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  let buffered = '';

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (value) buffered += decoder.decode(value, { stream: true });

      const data = buffered
        .split('\n')
        .find((line) => line.startsWith('data:'))
        ?.slice('data:'.length);

      if (data !== undefined && buffered.includes('\n\n')) return JSON.parse(data);
      if (done) return data === undefined ? {} : JSON.parse(data);
    }
  } finally {
    await reader.cancel();
  }
}

/**
 * An initialized MCP connection.
 *
 * Hand-rolled JSON-RPC rather than the client SDK: `apps/mcp` already tests itself with
 * the real SDK over a socket, and what is being checked here is that a token minted by
 * the flow above is accepted by the endpoint mounted in this process.
 */
async function mcpSession(h: Harness, accessToken: string) {
  const rpc = async (body: unknown, sessionId?: string) => {
    const response = await h.call('/mcp', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: `Bearer ${accessToken}`,
        ...(sessionId ? { 'mcp-session-id': sessionId } : {}),
      },
      body: JSON.stringify(body),
    });

    return { response, payload: await readResult(response) };
  };

  const initialized = await rpc({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'Cursor', version: '1.0' },
    },
  });

  expect(initialized.response.status).toBe(200);
  const sessionId = initialized.response.headers.get('mcp-session-id') as string;

  await rpc({ jsonrpc: '2.0', method: 'notifications/initialized' }, sessionId);

  const listed = await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, sessionId);

  let nextId = 3;

  return {
    sessionId,
    instructions: initialized.payload.result?.instructions ?? '',
    tools: (listed.payload.result?.tools ?? []).map((tool) => tool.name),
    callTool: async (name: string, args: Record<string, unknown>) => {
      const called = await rpc(
        {
          jsonrpc: '2.0',
          id: (nextId += 1),
          method: 'tools/call',
          params: { name, arguments: args },
        },
        sessionId,
      );
      return called.payload.result?.content?.[0]?.text ?? '';
    },
  };
}
