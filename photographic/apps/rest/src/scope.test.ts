/**
 * Scope enforcement.
 *
 * Two kinds of assertion here, and the second kind is the one worth having.
 *
 * The first checks that a token without `memory.write` cannot write. Useful, but it only
 * covers the routes someone remembered to test.
 *
 * The second reads the route table out of the app and asserts that every authenticated
 * route appears in `SCOPED_ROUTES` or `FIRST_PARTY_ONLY_ROUTES`. That is what makes the
 * guarantee hold for routes nobody has written yet: adding an endpoint without deciding
 * its scope fails here rather than shipping unguarded.
 */

import { FakeLlm } from '@photographic/core/testing';
import { createMemoryServices } from '@photographic/services-memory';
import type { PersonId, Services } from '@photographic/core';
import {
  DEFAULT_SCOPE,
  SCOPE_MEMORY_READ,
  SCOPE_MEMORY_WRITE,
  SCOPE_PROFILE_READ,
  SCOPE_ROOMS_READ,
} from '@photographic/auth';
import { beforeAll, describe, expect, it } from 'vitest';

import { createApp } from './app.js';
import { resolveConfig } from './config.js';
import { createLogger } from './logger.js';
import { FIRST_PARTY_CLIENT_ID, type OAuthProvider, type TokenClaims } from './oauth-contract.js';
import { FIRST_PARTY_ONLY_ROUTES, SCOPED_ROUTES } from './scoped-routes.js';

const API = 'http://api.test';

/**
 * Tokens as bare scope strings, so a test can say what a client may do without running
 * an OAuth flow. `flow.test.ts` and `connect-flow.test.ts` cover the real issuance.
 */
function fakeOAuth(personId: () => PersonId): OAuthProvider {
  const claimsFor = (token: string): TokenClaims | null => {
    if (!token.startsWith('scoped:')) return null;
    const [, clientId, scope] = token.split(':');
    return {
      personId: personId(),
      sessionId: null,
      agentClient: 'claude-desktop',
      clientId: clientId || 'pgm_client_test',
      scopes: (scope ?? '').split(',').filter(Boolean),
      roomScope: [],
      expiresAt: null,
    };
  };

  const notImplemented = async () => ({ status: 501 });
  return {
    introspect: async (token) => claimsFor(token),
    authorize: notImplemented,
    token: notImplemented,
    register: notImplemented,
    revoke: notImplemented,
  };
}

let services: Services;
let personId: PersonId;
let app: ReturnType<typeof createApp>;

beforeAll(async () => {
  const wired = createMemoryServices({ baseUrl: API, llm: new FakeLlm() });
  services = wired.services;
  const registered = await services.identity.register({ email: 'scope@photographic.test' });
  personId = registered.person.id;

  app = createApp({
    services,
    config: resolveConfig({ publicUrl: API, environment: 'test' }),
    logger: createLogger({ level: 'error' }),
    oauth: fakeOAuth(() => personId),
    clientGrants: {
      list: async () => [],
      rename: async () => true,
      revoke: async () => true,
    },
    revokeClientTokens: async () => 1,
  });
});

const token = (scopes: string[], clientId = 'pgm_client_test') =>
  `scoped:${clientId}:${scopes.join(',')}`;

const call = (
  path: string,
  init: RequestInit & { scopes?: string[]; clientId?: string } = {},
) => {
  const { scopes = DEFAULT_SCOPE.split(' '), clientId, ...rest } = init;
  return app.fetch(
    new Request(`${API}${path}`, {
      ...rest,
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${token(scopes, clientId)}`,
        ...(rest.headers as Record<string, string> | undefined),
      },
    }),
  );
};

describe('the default scope is a read-only connection', () => {
  it('lets a client that asked for nothing read the profile', async () => {
    // The good consequence of DEFAULT_SCOPE omitting memory.write: connecting a new AI
    // to see what it can do is a small decision rather than a large one.
    expect(DEFAULT_SCOPE).not.toContain(SCOPE_MEMORY_WRITE);

    const response = await call('/v1/profile');
    expect(response.status).toBe(200);
  });

  it('refuses a write from that same connection', async () => {
    const response = await call('/v1/memory', {
      method: 'POST',
      body: JSON.stringify({ body: 'allergisk mot ketchup' }),
    });

    expect(response.status).toBe(403);
    const body = (await response.json()) as { error: { code: string; required: string[] } };
    expect(body.error.code).toBe('insufficient_scope');
    expect(body.error.required).toContain(SCOPE_MEMORY_WRITE);
  });

  it('says which scope is missing in the challenge header, so a client can re-authorize', async () => {
    // A 403 with no indication of what was missing leaves a client retrying a request
    // that will never work.
    const response = await call('/v1/memory', {
      method: 'POST',
      body: JSON.stringify({ body: 'x' }),
    });

    const challenge = response.headers.get('www-authenticate') ?? '';
    expect(challenge).toContain('error="insufficient_scope"');
    expect(challenge).toContain(SCOPE_MEMORY_WRITE);
  });
});

describe('insufficient scope is not a 404', () => {
  it('reports 403 rather than hiding behind the not-found answer', async () => {
    // Permission denials are 404 because "exists but not yours" must be
    // indistinguishable from "does not exist". A scope refusal is a different fact and
    // not a confidential one: it is about the token the caller already holds.
    const response = await call('/v1/memory', {
      method: 'POST',
      body: JSON.stringify({ body: 'x' }),
    });
    expect(response.status).toBe(403);
  });
});

describe('per-route scopes', () => {
  it('allows a write once the token carries memory.write', async () => {
    const response = await call('/v1/memory', {
      method: 'POST',
      body: JSON.stringify({ body: 'allergisk mot ketchup' }),
      scopes: [SCOPE_MEMORY_WRITE, SCOPE_MEMORY_READ, SCOPE_ROOMS_READ, SCOPE_PROFILE_READ],
    });

    expect([200, 201, 202]).toContain(response.status);
  });

  it('separates reading a room from writing to it on the same path', async () => {
    const readOnly = [SCOPE_MEMORY_READ, SCOPE_ROOMS_READ, SCOPE_PROFILE_READ];

    const listed = await call('/v1/rooms', { scopes: readOnly });
    expect(listed.status).toBe(200);

    const created = await call('/v1/rooms', {
      method: 'POST',
      body: JSON.stringify({ title: 'Nytt rum' }),
      scopes: readOnly,
    });
    expect(created.status).toBe(403);
  });

  it('refuses search without memory.read even when the token can write', async () => {
    const response = await call('/v1/search?q=ketchup', {
      scopes: [SCOPE_MEMORY_WRITE, SCOPE_PROFILE_READ],
    });
    expect(response.status).toBe(403);
  });

  it('lets a read-only client mark a room seen', async () => {
    // Requiring write here would leave a read-only client re-reporting the same room as
    // unread forever.
    const rooms = (await (await call('/v1/rooms')).json()) as {
      rooms: Array<{ roomId: string }>;
    };
    const roomId = rooms.rooms[0]?.roomId as string;

    const response = await call(`/v1/rooms/${roomId}/seen`, {
      method: 'POST',
      scopes: [SCOPE_ROOMS_READ, SCOPE_PROFILE_READ],
    });
    expect(response.status).toBe(204);
  });
});

describe('managing the clients themselves', () => {
  it('refuses one AI client renaming another, whatever its scopes', async () => {
    // No scope is the right key here. A scope that permitted this would be held by every
    // client holding it, so the first thing a compromised AI would do is revoke the rest.
    const response = await call('/v1/clients/pgm_client_other', {
      method: 'PATCH',
      body: JSON.stringify({ displayName: 'Inte min klient' }),
      scopes: [SCOPE_MEMORY_WRITE, SCOPE_MEMORY_READ, SCOPE_ROOMS_READ, SCOPE_PROFILE_READ],
    });

    expect(response.status).toBe(403);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe('forbidden');
  });

  it('refuses one AI client disconnecting another', async () => {
    const response = await call('/v1/clients/pgm_client_other', {
      method: 'DELETE',
      scopes: [SCOPE_MEMORY_WRITE, SCOPE_PROFILE_READ],
    });
    expect(response.status).toBe(403);
  });

  it('allows it from the person’s own browser session', async () => {
    const response = await call('/v1/clients/pgm_client_other', {
      method: 'PATCH',
      body: JSON.stringify({ displayName: 'Claude på jobbdatorn' }),
      clientId: FIRST_PARTY_CLIENT_ID,
    });

    expect(response.status).toBe(200);
  });
});

describe('every authenticated route has decided its scope', () => {
  /**
   * Hono exposes its routes, so this reads the app rather than a list someone maintains
   * alongside the app. A route added without a scope shows up here as a name.
   */
  function authenticatedRoutes(): Array<{ method: string; path: string }> {
    const routes = (app as unknown as { routes: Array<{ method: string; path: string; handler: unknown }> })
      .routes;

    const seen = new Map<string, { method: string; path: string }>();
    for (const route of routes) {
      if (!route.path.startsWith('/v1/')) continue;
      // Middleware registrations, not endpoints.
      if (route.method === 'ALL') continue;
      if (route.path.includes('*')) continue;
      seen.set(`${route.method} ${route.path}`, { method: route.method, path: route.path });
    }
    return [...seen.values()];
  }

  const guarded = new Set(
    [...SCOPED_ROUTES, ...FIRST_PARTY_ONLY_ROUTES].map(
      ([method, path]) => `${method} /v1${path}`,
    ),
  );

  /**
   * Routes outside the scope model, each for a stated reason.
   *
   * Sign-up and the connect flow run before a token exists, and the import surface is
   * part of that same first-run path. An allowlist rather than a path prefix, so adding
   * a route under one of those prefixes is still a decision someone makes on purpose.
   */
  const exempt = new Set([
    'POST /v1/signup/request',
    'POST /v1/signup/verify',
    'GET /v1/connect',
    'GET /v1/invites/:token',
    'POST /v1/import/preview',
    'POST /v1/import',
    'GET /v1/connect/verify',
    'POST /v1/connect/verify',
  ]);

  it('leaves no authenticated route unguarded', () => {
    const unguarded = authenticatedRoutes()
      .map(({ method, path }) => `${method} ${path}`)
      .filter((key) => !guarded.has(key) && !exempt.has(key));

    expect(unguarded).toEqual([]);
  });

  it('names no route that does not exist', () => {
    // The other direction: a stale entry here is a scope check nobody runs, which reads
    // as coverage and is not.
    const live = new Set(
      authenticatedRoutes().map(({ method, path }) => `${method} ${path}`),
    );
    const stale = [...guarded].filter((key) => !live.has(key));

    expect(stale).toEqual([]);
  });
});
