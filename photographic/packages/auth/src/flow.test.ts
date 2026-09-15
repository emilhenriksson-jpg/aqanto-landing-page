/**
 * The authorization flow, end to end and at its edges.
 *
 * This is the file that decides whether a stranger can read someone's memory. Most of it
 * is written as attacks rather than as features, because the happy path is one test and
 * the ways to get a code delivered somewhere it should not go are many.
 */

import type { PersonId, RoomId } from '@photographic/core';
import { beforeEach, describe, expect, it } from 'vitest';

import { s256Challenge } from './crypto.js';
import type { AuthRequest } from './http.js';
import { createInMemoryRateLimiter } from './rate-limit.js';
import type { AuthServer } from './server.js';
import { createAuthServer } from './server.js';
import {
  MemoryAuthCodeStore,
  MemoryClientStore,
  MemoryPendingAuthorizationStore,
  MemoryPersonLookup,
  MemoryTokenStore,
} from './testing/memory-stores.js';

const ISSUER = 'https://api.photographic.test';
const RESOURCE = `${ISSUER}/mcp`;
const REDIRECT = 'cursor://anysphere.cursor/callback';
const VERIFIER = 'a'.repeat(64);

const EMIL = 'person-emil' as PersonId;
const JACOB = 'person-jacob' as PersonId;

let auth: AuthServer;
let people: MemoryPersonLookup;
let clients: MemoryClientStore;
let sessions: Map<string, PersonId>;
let clock: Date;

function get(url: string, headers: Record<string, string> = {}): AuthRequest {
  return { method: 'GET', url, headers };
}

function post(url: string, body: unknown, headers: Record<string, string> = {}): AuthRequest {
  return { method: 'POST', url, headers, body: body as Record<string, unknown> };
}

async function registerClient(overrides: Record<string, unknown> = {}) {
  const response = await auth.register(
    post('/oauth/register', {
      client_name: 'Cursor',
      redirect_uris: [REDIRECT],
      ...overrides,
    }),
  );
  return { status: response.status, body: JSON.parse(response.body) as Record<string, string> };
}

/** Runs authorize, returning the `auth_request` id the login page would receive. */
async function startFlow(clientId: string, overrides: Record<string, string> = {}) {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: REDIRECT,
    code_challenge: s256Challenge(VERIFIER),
    code_challenge_method: 'S256',
    scope: 'memory.read memory.write offline_access',
    state: 'state-123',
    ...overrides,
  });

  const response = await auth.authorize(get(`/oauth/authorize?${params.toString()}`));
  const location = response.headers['location'];

  return {
    response,
    location,
    requestId: location ? new URL(location).searchParams.get('auth_request') : null,
  };
}

async function approve(requestId: string, sessionToken: string, approved = true) {
  const response = await auth.approve(
    post(
      '/oauth/authorize/approve',
      { requestId, approved },
      { authorization: `Bearer ${sessionToken}` },
    ),
  );
  return { status: response.status, body: JSON.parse(response.body) as Record<string, string> };
}

async function exchange(body: Record<string, string>) {
  const response = await auth.token(post('/oauth/token', body));
  return { status: response.status, body: JSON.parse(response.body) as Record<string, string> };
}

/** Registers a client, authorizes as Emil, and redeems the code. The happy path, reused. */
async function connect(): Promise<{ clientId: string; tokens: Record<string, string> }> {
  const { body: client } = await registerClient();
  const { requestId } = await startFlow(client['client_id'] as string);
  const { body } = await approve(requestId as string, 'session-emil');
  const code = new URL(body['redirectUrl'] as string).searchParams.get('code') as string;

  const { body: tokens } = await exchange({
    grant_type: 'authorization_code',
    code,
    redirect_uri: REDIRECT,
    code_verifier: VERIFIER,
    client_id: client['client_id'] as string,
  });

  return { clientId: client['client_id'] as string, tokens };
}

beforeEach(() => {
  clock = new Date('2026-01-01T12:00:00Z');
  const now = () => clock;

  clients = new MemoryClientStore(now);
  people = new MemoryPersonLookup();
  people.add(EMIL, []);
  people.add(JACOB, []);

  sessions = new Map([
    ['session-emil', EMIL],
    ['session-jacob', JACOB],
  ]);

  auth = createAuthServer({
    clients,
    codes: new MemoryAuthCodeStore(now),
    pending: new MemoryPendingAuthorizationStore(now),
    tokens: new MemoryTokenStore(now),
    people,
    sessions: { verify: async (token) => sessions.get(token) ?? null },
    config: { issuer: ISSUER, resource: RESOURCE, loginUrl: `${ISSUER}/login` },
    rateLimiter: createInMemoryRateLimiter({ limit: 50, windowSeconds: 60, now }),
    now,
  });
});

describe('the whole flow', () => {
  it('takes a client from knowing nothing to holding a working token', async () => {
    // What has to happen without a person configuring anything: the client registers
    // itself, sends the person to log in, and comes back with a token. If any step here
    // needs a human, connecting an AI becomes a support conversation.
    const { tokens } = await connect();

    expect(tokens['token_type']).toBe('Bearer');
    expect(tokens['access_token']).toMatch(/^pgm_at_/);
    expect(tokens['refresh_token']).toMatch(/^pgm_rt_/);

    const claims = await auth.introspect(tokens['access_token'] as string);
    expect(claims?.personId).toBe(EMIL);
    expect(claims?.scopes).toContain('memory.write');
  });

  it('carries state back so the client can match the response', async () => {
    const { body: client } = await registerClient();
    const { requestId } = await startFlow(client['client_id'] as string);
    const { body } = await approve(requestId as string, 'session-emil');

    expect(new URL(body['redirectUrl'] as string).searchParams.get('state')).toBe('state-123');
  });

  it('publishes metadata a client can complete the flow from', async () => {
    const metadata = JSON.parse(auth.authorizationServerMetadata().body) as Record<string, unknown>;

    // Without a registration endpoint the client cannot get credentials on its own, and
    // everything above becomes manual.
    expect(metadata['registration_endpoint']).toBe(`${ISSUER}/oauth/register`);
    expect(metadata['code_challenge_methods_supported']).toEqual(['S256']);
    // Advertising `plain` would invite the downgrade PKCE exists to prevent.
    expect(metadata['code_challenge_methods_supported']).not.toContain('plain');
  });
});

describe('where the code is allowed to go', () => {
  it('refuses to redirect to a URI the client never registered', async () => {
    // The whole game. If this redirects, an attacker who can start a flow gets the code
    // delivered to themselves, and the person sees a normal-looking login.
    const { body: client } = await registerClient();
    const { response } = await startFlow(client['client_id'] as string, {
      redirect_uri: 'https://attacker.example/callback',
    });

    expect(response.status).toBe(400);
    expect(response.headers['location']).toBeUndefined();
  });

  it('will not accept a redirect_uri that merely starts with the registered one', async () => {
    // Prefix matching is the classic mistake, and this is what it lets through.
    const { body: client } = await registerClient({
      redirect_uris: ['https://app.example/callback'],
    });

    for (const attempt of [
      'https://app.example/callback/../../evil',
      'https://app.example/callback.evil.com',
      'https://app.example/callback?next=https://evil.example',
      'https://app.example:8443/callback',
    ]) {
      const { response } = await startFlow(client['client_id'] as string, {
        redirect_uri: attempt,
      });
      expect(response.status, attempt).toBe(400);
    }
  });

  it('refuses to register a redirect it could not protect', async () => {
    for (const uri of [
      'http://app.example/callback', // plain http off-loopback: interceptable
      'https://app.example/callback#fragment', // never sent to the server
      'javascript:alert(1)', // code execution in whatever follows the redirect
      'data:text/html,<script>fetch(location)</script>',
      'file:///etc/passwd',
      'cursor:', // a scheme with nothing after it is not a destination
      'not a url',
    ]) {
      const { status } = await registerClient({ redirect_uris: [uri] });
      expect(status, uri).toBe(400);
    }
  });

  it('accepts the private-use schemes desktop clients actually ship', async () => {
    // RFC 8252 recommends a reverse-DNS scheme and no shipping client follows it. Refusing
    // these would mean refusing most of the clients this server exists to serve. PKCE is
    // what protects them: the OS decides who owns `cursor://`, and a code delivered to the
    // wrong app is useless without the verifier that app never had.
    for (const uri of ['cursor://anysphere.cursor-retrieval/oauth/callback', 'vscode://callback']) {
      const { status } = await registerClient({ redirect_uris: [uri] });
      expect(status, uri).toBe(201);
    }
  });

  it('allows loopback on any port, because a native app cannot choose one', async () => {
    // RFC 8252: the app binds whatever the OS gives it, so the port cannot be registered
    // in advance. The carve-out is scoped to loopback, where there is no network to sniff.
    const { body: client } = await registerClient({
      redirect_uris: ['http://127.0.0.1/callback'],
    });
    const { response } = await startFlow(client['client_id'] as string, {
      redirect_uri: 'http://127.0.0.1:53421/callback',
    });

    expect(response.status).toBe(302);
  });

  it('reports an unknown client to the person, not to a redirect', async () => {
    const { response } = await startFlow('pgm_client_nonexistent');

    expect(response.status).toBe(400);
    expect(response.headers['location']).toBeUndefined();
  });

  it('redirects later errors, because that is what the client is waiting for', async () => {
    const { body: client } = await registerClient();
    const { response } = await startFlow(client['client_id'] as string, {
      response_type: 'token',
    });

    expect(response.status).toBe(302);
    const location = new URL(response.headers['location'] as string);
    expect(location.searchParams.get('error')).toBe('unsupported_response_type');
    expect(location.searchParams.get('state')).toBe('state-123');
  });
});

describe('PKCE', () => {
  it('will not start a flow without a challenge', async () => {
    const { body: client } = await registerClient();
    const { response } = await startFlow(client['client_id'] as string, { code_challenge: '' });

    const location = new URL(response.headers['location'] as string);
    expect(location.searchParams.get('error')).toBe('invalid_request');
  });

  it('refuses the plain method, which is the downgrade attack', async () => {
    const { body: client } = await registerClient();
    const { response } = await startFlow(client['client_id'] as string, {
      code_challenge: VERIFIER,
      code_challenge_method: 'plain',
    });

    const location = new URL(response.headers['location'] as string);
    expect(location.searchParams.get('error')).toBe('invalid_request');
  });

  it('rejects a code redeemed with the wrong verifier', async () => {
    // What an attacker who intercepted the redirect has: the code, and no verifier.
    const { body: client } = await registerClient();
    const { requestId } = await startFlow(client['client_id'] as string);
    const { body } = await approve(requestId as string, 'session-emil');
    const code = new URL(body['redirectUrl'] as string).searchParams.get('code') as string;

    const wrong = await exchange({
      grant_type: 'authorization_code',
      code,
      redirect_uri: REDIRECT,
      code_verifier: 'b'.repeat(64),
      client_id: client['client_id'] as string,
    });

    expect(wrong.status).toBe(400);
    expect(wrong.body['error']).toBe('invalid_grant');
  });
});

describe('the authorization code', () => {
  it('works once, and the second use revokes everything it produced', async () => {
    // A code redeemed twice means someone else has it. There is no way to tell a replay
    // from a retry, so the safe reading is that it leaked — and every token descended from
    // it has to die, even the legitimate client's.
    const { clientId, tokens } = await connect();
    const first = tokens['access_token'] as string;

    expect(await auth.introspect(first)).not.toBeNull();

    const { requestId } = await startFlow(clientId);
    const { body } = await approve(requestId as string, 'session-emil');
    const code = new URL(body['redirectUrl'] as string).searchParams.get('code') as string;

    await exchange({
      grant_type: 'authorization_code',
      code,
      redirect_uri: REDIRECT,
      code_verifier: VERIFIER,
      client_id: clientId,
    });

    const replay = await exchange({
      grant_type: 'authorization_code',
      code,
      redirect_uri: REDIRECT,
      code_verifier: VERIFIER,
      client_id: clientId,
    });

    expect(replay.status).toBe(400);
    expect(await auth.introspect(first)).toBeNull();
  });

  it('expires quickly, because it only has to survive a redirect', async () => {
    const { body: client } = await registerClient();
    const { requestId } = await startFlow(client['client_id'] as string);
    const { body } = await approve(requestId as string, 'session-emil');
    const code = new URL(body['redirectUrl'] as string).searchParams.get('code') as string;

    clock = new Date(clock.getTime() + 120_000);

    const late = await exchange({
      grant_type: 'authorization_code',
      code,
      redirect_uri: REDIRECT,
      code_verifier: VERIFIER,
      client_id: client['client_id'] as string,
    });

    expect(late.body['error']).toBe('invalid_grant');
  });

  it('cannot be redeemed by a different client than it was issued to', async () => {
    const { body: mine } = await registerClient({ client_name: 'Cursor' });
    const { body: theirs } = await registerClient({ client_name: 'Attacker' });

    const { requestId } = await startFlow(mine['client_id'] as string);
    const { body } = await approve(requestId as string, 'session-emil');
    const code = new URL(body['redirectUrl'] as string).searchParams.get('code') as string;

    const stolen = await exchange({
      grant_type: 'authorization_code',
      code,
      redirect_uri: REDIRECT,
      code_verifier: VERIFIER,
      client_id: theirs['client_id'] as string,
    });

    expect(stolen.status).toBe(400);
    expect(stolen.body['error']).toBe('invalid_grant');
  });

  it('is bound to the redirect_uri it was issued against', async () => {
    const { body: client } = await registerClient({
      redirect_uris: [REDIRECT, 'https://app.example/other'],
    });
    const { requestId } = await startFlow(client['client_id'] as string);
    const { body } = await approve(requestId as string, 'session-emil');
    const code = new URL(body['redirectUrl'] as string).searchParams.get('code') as string;

    // Both URIs are registered, so checking against the registered list rather than
    // against the code would let this through.
    const swapped = await exchange({
      grant_type: 'authorization_code',
      code,
      redirect_uri: 'https://app.example/other',
      code_verifier: VERIFIER,
      client_id: client['client_id'] as string,
    });

    expect(swapped.body['error']).toBe('invalid_grant');
  });
});

describe('who is approving', () => {
  it('issues the code for the person who is signed in, not the one named in the request', async () => {
    // The identity comes from the session token and nowhere else. If the login page could
    // assert a person id, the endpoint would hand out codes for anyone.
    const { body: client } = await registerClient();
    const { requestId } = await startFlow(client['client_id'] as string);

    const { body } = await approve(requestId as string, 'session-jacob');
    const code = new URL(body['redirectUrl'] as string).searchParams.get('code') as string;

    const { body: tokens } = await exchange({
      grant_type: 'authorization_code',
      code,
      redirect_uri: REDIRECT,
      code_verifier: VERIFIER,
      client_id: client['client_id'] as string,
    });

    expect((await auth.introspect(tokens['access_token'] as string))?.personId).toBe(JACOB);
  });

  it('refuses to approve without a session', async () => {
    const { body: client } = await registerClient();
    const { requestId } = await startFlow(client['client_id'] as string);

    const { status } = await approve(requestId as string, 'not-a-session');

    expect(status).toBe(401);
  });

  it('approves a request once, whatever the answer was', async () => {
    // A page that has already shown the person a refusal must not be able to come back and
    // approve it, and a double-approve must not produce two codes.
    const { body: client } = await registerClient();
    const { requestId } = await startFlow(client['client_id'] as string);

    const declined = await approve(requestId as string, 'session-emil', false);
    expect(new URL(declined.body['redirectUrl'] as string).searchParams.get('error')).toBe(
      'access_denied',
    );

    const second = await approve(requestId as string, 'session-emil', true);
    expect(second.status).toBe(400);
  });

  it('tells the login page what the person is agreeing to', async () => {
    const { body: client } = await registerClient({ client_name: 'Cursor' });
    const { requestId } = await startFlow(client['client_id'] as string);

    const response = await auth.describeRequest(
      get(`/oauth/authorize/request?auth_request=${requestId}`),
    );
    const view = JSON.parse(response.body) as { clientName: string; scopes: string[] };

    expect(view.clientName).toBe('Cursor');
    expect(view.scopes).toContain('memory.write');
  });

  it('strips what a client name could use to forge a consent screen', async () => {
    // Registration is open, so anyone can register a client called whatever they like.
    // The name is shown to a person who is deciding whether to trust it.
    const { body: client } = await registerClient({
      client_name: 'Photographic\u200b Official\nGodkänn allt',
    });

    expect(client['client_name']).not.toContain('\n');
    expect(client['client_name']).not.toContain('\u200b');
  });
});

describe('refresh', () => {
  it('rotates, and a reused refresh token takes the family with it', async () => {
    const { clientId, tokens } = await connect();
    const original = tokens['refresh_token'] as string;

    const rotated = await exchange({
      grant_type: 'refresh_token',
      refresh_token: original,
      client_id: clientId,
    });
    expect(rotated.status).toBe(200);
    expect(rotated.body['refresh_token']).not.toBe(original);

    // Presenting the old one is either a replay or a theft, and they are
    // indistinguishable. Both end with the person re-authorizing.
    const reuse = await exchange({
      grant_type: 'refresh_token',
      refresh_token: original,
      client_id: clientId,
    });
    expect(reuse.status).toBe(400);
    expect(await auth.introspect(rotated.body['access_token'] as string)).toBeNull();
  });

  it('will not widen the scope it was granted', async () => {
    const { body: client } = await registerClient();
    const { requestId } = await startFlow(client['client_id'] as string, {
      scope: 'memory.read offline_access',
    });
    const { body } = await approve(requestId as string, 'session-emil');
    const code = new URL(body['redirectUrl'] as string).searchParams.get('code') as string;

    const { body: tokens } = await exchange({
      grant_type: 'authorization_code',
      code,
      redirect_uri: REDIRECT,
      code_verifier: VERIFIER,
      client_id: client['client_id'] as string,
    });

    const widened = await exchange({
      grant_type: 'refresh_token',
      refresh_token: tokens['refresh_token'] as string,
      scope: 'memory.read memory.write',
      client_id: client['client_id'] as string,
    });

    expect(widened.body['error']).toBe('invalid_grant');
  });

  it('issues no refresh token when offline_access was not asked for', async () => {
    const { body: client } = await registerClient();
    const { requestId } = await startFlow(client['client_id'] as string, { scope: 'memory.read' });
    const { body } = await approve(requestId as string, 'session-emil');
    const code = new URL(body['redirectUrl'] as string).searchParams.get('code') as string;

    const { body: tokens } = await exchange({
      grant_type: 'authorization_code',
      code,
      redirect_uri: REDIRECT,
      code_verifier: VERIFIER,
      client_id: client['client_id'] as string,
    });

    expect(tokens['refresh_token']).toBeUndefined();
  });
});

describe('revocation and expiry', () => {
  it('makes "koppla bort" immediate, which is why tokens are not JWTs', async () => {
    const { clientId, tokens } = await connect();

    await auth.token(post('/oauth/revoke', {}));
    await auth.revoke(
      post('/oauth/revoke', { token: tokens['access_token'], client_id: clientId }),
    );

    expect(await auth.introspect(tokens['access_token'] as string)).toBeNull();
  });

  it('answers a revocation of a token it never issued with success', async () => {
    // RFC 7009 section 2.2. The caller wanted it gone and it is gone; "no such token" only
    // confirms which tokens exist.
    const response = await auth.revoke(
      post('/oauth/revoke', { token: 'pgm_at_whatever', client_id: 'pgm_client_x' }),
    );

    expect(response.status).toBe(200);
  });

  it('stops honouring a token once it has expired', async () => {
    const { tokens } = await connect();

    clock = new Date(clock.getTime() + 2 * 3600 * 1000);

    expect(await auth.introspect(tokens['access_token'] as string)).toBeNull();
  });

  it('stops honouring a token whose person is gone', async () => {
    const { tokens } = await connect();
    people.rooms.delete(EMIL);

    expect(await auth.introspect(tokens['access_token'] as string)).toBeNull();
  });
});

describe('narrowed tokens', () => {
  it('resolves rooms per request rather than freezing them on the token', async () => {
    // A token that cached its memberships would keep reading a room after the person left
    // it, and nothing would error — the failure nobody notices.
    const room = '11111111-1111-4111-8111-111111111111' as RoomId;
    people.add(EMIL, [room]);

    const { body: client } = await registerClient();
    const { requestId } = await startFlow(client['client_id'] as string, {
      scope: `memory.read room:${room}`,
    });
    const { body } = await approve(requestId as string, 'session-emil');
    const code = new URL(body['redirectUrl'] as string).searchParams.get('code') as string;

    const { body: tokens } = await exchange({
      grant_type: 'authorization_code',
      code,
      redirect_uri: REDIRECT,
      code_verifier: VERIFIER,
      client_id: client['client_id'] as string,
    });

    expect((await auth.introspect(tokens['access_token'] as string))?.roomScope).toEqual([room]);

    // The person leaves the room. The token stays valid in form and reaches nothing.
    people.add(EMIL, []);
    expect(await auth.introspect(tokens['access_token'] as string)).toBeNull();
  });
});

describe('request hygiene', () => {
  it('refuses a request with a duplicated parameter instead of picking one', async () => {
    // Which copy a server picks is the whole of parameter pollution: an attacker appends a
    // second redirect_uri and hopes this server reads the other one than the validator did.
    const { body: client } = await registerClient();
    const params = new URLSearchParams({
      response_type: 'code',
      client_id: client['client_id'] as string,
      redirect_uri: REDIRECT,
      code_challenge: s256Challenge(VERIFIER),
      code_challenge_method: 'S256',
    });
    params.append('redirect_uri', 'https://attacker.example/callback');

    const response = await auth.authorize(get(`/oauth/authorize?${params.toString()}`));

    expect(response.status).toBe(400);
  });

  it('refuses a resource that is not this server', async () => {
    // RFC 8707. A token issued for someone else's resource must not be usable here, and
    // the mirror of that is refusing to mint one for a resource that is not ours.
    const { body: client } = await registerClient();
    const { response } = await startFlow(client['client_id'] as string, {
      resource: 'https://someone-else.example/mcp',
    });

    const location = new URL(response.headers['location'] as string);
    expect(location.searchParams.get('error')).toBe('invalid_target');
  });

  it('will not let a public client present a secret, or a confidential one omit it', async () => {
    const { body: pub } = await registerClient();
    const { body: conf } = await registerClient({
      client_name: 'Server',
      redirect_uris: ['https://app.example/cb'],
      token_endpoint_auth_method: 'client_secret_post',
    });

    expect(conf['client_secret']).toMatch(/^pgm_cs_/);

    const impersonated = await exchange({
      grant_type: 'authorization_code',
      code: 'pgm_ac_whatever',
      client_id: conf['client_id'] as string,
    });
    expect(impersonated.status).toBe(401);

    const overreaching = await exchange({
      grant_type: 'authorization_code',
      code: 'pgm_ac_whatever',
      client_id: pub['client_id'] as string,
      client_secret: 'pgm_cs_invented',
    });
    expect(overreaching.status).toBe(401);
  });

  it('gives one answer for every kind of bad token', async () => {
    // Unknown, revoked and expired have to be indistinguishable, or a holder of a stolen
    // token learns what kind of stolen token they have.
    for (const token of ['', 'garbage', 'pgm_at_' + 'x'.repeat(43)]) {
      expect(await auth.introspect(token)).toBeNull();
    }
  });
});
