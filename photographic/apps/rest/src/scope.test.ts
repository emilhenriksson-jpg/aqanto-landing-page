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
import type { ConnectDeps } from '@photographic/connect';
import {
  MemoryCodeSender,
  MemoryCodeStore,
  MemorySessionIssuer,
} from '@photographic/connect/testing';
import {
  DEFAULT_SCOPE,
  SCOPE_MEMORY_READ,
  SCOPE_MEMORY_WRITE,
  SCOPE_PROFILE_READ,
  SCOPE_ROOMS_READ,
  SUPPORTED_SCOPES,
} from '@photographic/auth';
import { beforeAll, describe, expect, it } from 'vitest';

import { createApp } from './app.js';
import { resolveConfig } from './config.js';
import { createLogger } from './logger.js';
import { FIRST_PARTY_CLIENT_ID, type OAuthProvider, type TokenClaims } from './oauth-contract.js';
import {
  FIRST_PARTY_ONLY_ROUTES,
  HUMAN_DECISION_ROUTES,
  SCOPED_ROUTES,
} from './scoped-routes.js';

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

  // Sign-up and import are mounted only when `connect` is supplied, and the whole point of
  // the route-table assertions below is that they see every route the real app has. Without
  // these deps the import routes were absent, so the exemptions covering them could not have
  // been contradicted by anything this file checked.
  const connectDeps: ConnectDeps = {
    identity: services.identity,
    invites: services.invites,
    sessions: services.sessions,
    codes: new MemoryCodeStore(),
    sender: new MemoryCodeSender(),
    issuer: new MemorySessionIssuer(),
    codeSecret: 'scope-test-secret',
    clock: () => new Date(),
    randomCode: () => '424242',
    randomId: () => `scope-${Math.random()}`,
  };

  app = createApp({
    services,
    config: resolveConfig({ publicUrl: API, environment: 'test', notFoundFloorMs: 0 }),
    logger: createLogger({ level: 'error' }),
    oauth: fakeOAuth(() => personId),
    connect: { deps: connectDeps },
    clientGrants: {
      list: async () => [],
      rename: async () => true,
      setChatgptPlugin: async () => true,
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

  it('refuses an import from a read-only connection', async () => {
    // The route that escaped this table. It is authenticated and it calls `ingest.propose`
    // once per parsed candidate, so a token issued without `memory.write` — which is what
    // `DEFAULT_SCOPE` deliberately gives a client that asks for nothing — used to answer 201
    // with three proposals queued. Nothing was ever saved without approval, so the
    // containment held; what a read-only connection gained was the ability to fill the
    // approval queue with text of its choosing.
    const response = await call('/v1/import', {
      method: 'POST',
      body: JSON.stringify({ text: '- Allergisk mot selleri\n- Bor i Stockholm' }),
    });

    expect(response.status).toBe(403);
    const body = (await response.json()) as { error: { code: string; required: string[] } };
    expect(body.error.code).toBe('insufficient_scope');
    expect(body.error.required).toContain(SCOPE_MEMORY_WRITE);
  });

  it('queues nothing when the import is refused', async () => {
    // The control the reproduction relied on: proving the refusal is a refusal and not a
    // 403 rendered after the work was already done.
    const before = await services.ingest.listProposals({
      personId,
      agentClient: 'api',
      sessionId: null,
      roomScope: [],
    });

    await call('/v1/import', {
      method: 'POST',
      body: JSON.stringify({ text: '- Allergisk mot selleri' }),
    });

    const after = await services.ingest.listProposals({
      personId,
      agentClient: 'api',
      sessionId: null,
      roomScope: [],
    });
    expect(after.length).toBe(before.length);
  });

  it('allows the import once the token carries memory.write', async () => {
    const response = await call('/v1/import', {
      method: 'POST',
      body: JSON.stringify({ text: '- Allergisk mot selleri' }),
      scopes: [SCOPE_MEMORY_WRITE, SCOPE_MEMORY_READ, SCOPE_PROFILE_READ],
    });

    expect(response.status).toBe(201);
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
  it('only lets the browser bind a private ChatGPT app, with strict link validation', async () => {
    const link = 'https://chatgpt.com/plugins/plugin_asdk_app_0123456789abcdef0123456789abcdef';
    const route = '/v1/clients/pgm_client_other/chatgpt-launch';
    expect((await call(route, { method: 'PATCH', body: JSON.stringify({ link }), scopes: [SCOPE_MEMORY_WRITE, SCOPE_PROFILE_READ] })).status).toBe(403);
    const saved = await call(route, { method: 'PATCH', body: JSON.stringify({ link }), clientId: FIRST_PARTY_CLIENT_ID });
    expect(saved.status).toBe(200);
    expect(await saved.json()).toMatchObject({ chatgptPluginId: 'dev-0123456789abcdef0123456789abcdef@openai-curated-remote' });
    expect((await call(route, { method: 'PATCH', body: JSON.stringify({ link: link.replace('chatgpt.com', 'evil.test') }), clientId: FIRST_PARTY_CLIENT_ID })).status).toBe(400);
  });

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
   * Routes outside the scope model.
   *
   * This list used to be a `Set` of paths under one shared prose comment saying they "run
   * before a token exists". That was true of sign-up and the invite preview and false of
   * `POST /v1/import`, which `app.ts` had always put behind `authenticate` and which calls
   * `ingest.propose` per candidate — so a token issued deliberately *without*
   * `memory.write` could queue proposals into somebody's Godkänn queue. The exemption
   * survived every review because it carried a plausible sentence that nobody re-checked
   * against the route table, and `scope.test.ts` was satisfied by an exemption exactly as
   * well as by a guard.
   *
   * So an entry now names the mechanism that guards it instead of sharing a reason, and the
   * claim is checked rather than read: `reachableWithoutToken` is asserted below by calling
   * the route with no `Authorization` header and requiring the answer not to be a 401. On
   * the day `/v1/import` was added to this list, that assertion would have failed.
   */
  const exempt: ReadonlyArray<{
    key: string;
    method: string;
    path: string;
    /** True when the route is genuinely part of the pre-token path. Asserted, not asserted-to. */
    reachableWithoutToken: boolean;
    guardedBy: string;
  }> = [
    {
      key: 'POST /v1/signup/request',
      method: 'POST',
      path: '/v1/signup/request',
      reachableWithoutToken: true,
      guardedBy: 'per-address and per-IP rate limits in @photographic/connect; creates no memory',
    },
    {
      key: 'POST /v1/signup/verify',
      method: 'POST',
      path: '/v1/signup/verify',
      reachableWithoutToken: true,
      guardedBy: 'the six-digit code and its attempt budget; this is where a session begins',
    },
    {
      key: 'GET /v1/connect',
      method: 'GET',
      path: '/v1/connect',
      reachableWithoutToken: true,
      guardedBy: 'contains no secrets — one shared MCP URL, identity resolved at connect time',
    },
    {
      key: 'GET /v1/invites/:token',
      method: 'GET',
      path: '/v1/invites/aaaaaaaaaaaaaaaa',
      reachableWithoutToken: true,
      guardedBy: 'the invite token itself, plus the tightest rate limit in the app',
    },
    {
      // The archive is delivered by email and the browser that opens the link may never have
      // had a session, so requiring one would make the link useless. Minting the link *is*
      // gated — `HUMAN_DECISION_ROUTES` — which is where the decision lives.
      key: 'GET /v1/export/download/:token',
      method: 'GET',
      path: '/v1/export/download/aaaaaaaaaaaaaaaa',
      reachableWithoutToken: true,
      guardedBy: 'a signed, expiring token in the path; POST /v1/export/:id/link is first-party only',
    },
    {
      // Deliberately available without a valid token: a stale browser cookie is one of the
      // cases this route repairs. It changes no server-side state and clears only the
      // caller's host-only cookie; matching Origin and Host keeps another site from
      // forcing that change in their browser.
      key: 'POST /v1/session/logout',
      method: 'POST',
      path: '/v1/session/logout',
      reachableWithoutToken: true,
      guardedBy: 'same-origin Origin/Host check; only clears the caller’s browser cookie',
    },
    {
      /**
       * The break-glass sign-in, and the one exemption that is the point rather than a
       * concession. A recovery path that required a token would require you to already be
       * recovered — it exists for the day nobody can sign in at all, so it cannot sit
       * behind the thing that is broken.
       *
       * What guards it instead is that the token is minted on the machine, by someone who
       * already has `fly ssh console`, under a secret that never leaves the process. The
       * endpoint answers identically whether or not `BREAK_GLASS_SECRET` is set, so
       * probing it tells an attacker nothing about whether the path is armed.
       */
      key: 'POST /v1/signup/break-glass',
      method: 'POST',
      path: '/v1/signup/break-glass',
      reachableWithoutToken: true,
      guardedBy:
        'a single-use HMAC token minted only on the machine under BREAK_GLASS_SECRET, ten minute expiry, plus the signup rate limit',
    },
  ];

  const exemptKeys = new Set(exempt.map((entry) => entry.key));

  it('leaves no authenticated route unguarded', () => {
    const unguarded = authenticatedRoutes()
      .map(({ method, path }) => `${method} ${path}`)
      .filter((key) => !guarded.has(key) && !exemptKeys.has(key));

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

  it('exempts no route that does not exist either', () => {
    // Same rule for the other list. `GET /v1/connect/verify` sat here for a route that has
    // never existed, which is how much attention the entries were getting.
    const live = new Set(
      authenticatedRoutes().map(({ method, path }) => `${method} ${path}`),
    );
    const stale = exempt.map((entry) => entry.key).filter((key) => !live.has(key));

    expect(stale).toEqual([]);
  });

  it.each(exempt)('$key really is reachable without a token', async (entry) => {
    // The claim each exemption rests on, checked. A 401 means the route needs a token after
    // all, and a route that needs a token belongs in the scope table.
    expect(entry.reachableWithoutToken).toBe(true);

    const response = await app.fetch(
      new Request(`${API}${entry.path}`, {
        method: entry.method,
        headers: { 'content-type': 'application/json' },
        ...(entry.method === 'POST' ? { body: '{}' } : {}),
      }),
    );

    /**
     * A 401 from the *auth middleware* means the route needs a token after all, and a
     * route that needs a token belongs in the scope table. A 401 from the route's own
     * handler is a different thing — break-glass answers one uniform refusal for every
     * reason, deliberately, so that probing it cannot reveal whether the path is armed.
     *
     * `WWW-Authenticate` is what separates them: `unauthorized()` in `middleware.ts`
     * always sets it, because RFC 9728 is how an MCP client discovers where to
     * authenticate, and a route throwing `AuthError` never does. So this still fails for
     * the case it exists to catch, without forcing a route to pick a weaker status than
     * the one it means.
     */
    const fromAuthMiddleware =
      response.status === 401 && response.headers.get('www-authenticate') !== null;

    expect(
      fromAuthMiddleware,
      `${entry.key} was refused by the auth middleware; guardedBy claims: ${entry.guardedBy}`,
    ).toBe(false);
  });
});

/**
 * The decisions reserved for a human, checked as a class.
 *
 * The bug this exists for was not any one route: it was that the rule had been applied to
 * three of five decision routes, each omission looking reasonable on its own. Answering a
 * proposal was moved because someone noticed; settling a dispute was not, and confirming a
 * share was a boolean in a request body rather than a route at all.
 *
 * Two assertions, neither of which restates the list. Every entry must exist in the live
 * route table, so this cannot rot into a list of imaginary routes the way the exemptions
 * did. And every entry must actually refuse a token holding *every* supported scope, which
 * is the property being claimed — the realistic attacker here is a stolen or over-scoped
 * token rather than prompt injection, since no MCP tool reaches any of these.
 */
describe('decisions only a person may make', () => {
  function liveRoutes(): Set<string> {
    const routes = (app as unknown as { routes: Array<{ method: string; path: string }> }).routes;
    return new Set(
      routes
        .filter((route) => route.method !== 'ALL' && !route.path.includes('*'))
        .map((route) => `${route.method} ${route.path}`),
    );
  }

  it('are all routes that exist', () => {
    const live = liveRoutes();
    const missing = HUMAN_DECISION_ROUTES.map(
      ([method, path]) => `${method} /v1${path}`,
    ).filter((key) => !live.has(key));

    expect(missing).toEqual([]);
  });

  it('are none of them reachable by scope', () => {
    // A route in both tables would be gated by `firstPartyOnly` *and* a scope, and the
    // second one reads as if a scope were sufficient. It never is for these.
    const scoped = new Set(SCOPED_ROUTES.map(([method, path]) => `${method} ${path}`));
    const alsoScoped = HUMAN_DECISION_ROUTES.map(
      ([method, path]) => `${method} ${path}`,
    ).filter((key) => scoped.has(key));

    expect(alsoScoped).toEqual([]);
  });

  /**
   * Named explicitly rather than derived from the list, because a test that iterates a list
   * disappears when someone shortens the list. `trust-and-permissions.md` 2.2 is the source
   * for this one: a dispute is settled "aldrig av en modell, och aldrig av ett MCP-anrop".
   * The absence of an MCP tool was the only thing enforcing that, and a token talking to the
   * REST API does not need a tool.
   */
  it('refuses settling a dispute from a token holding every scope', async () => {
    const response = await call('/v1/memory/disputes/resolve', {
      method: 'POST',
      body: JSON.stringify({ winnerShortId: 'p-7k2m', loserShortId: 'p-8k3n' }),
      scopes: [...SUPPORTED_SCOPES],
    });

    expect(response.status).toBe(403);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe('forbidden');
  });

  /** Same reasoning, for the decision that used to be a boolean instead of a route. */
  it('refuses answering a proposal from a token holding every scope', async () => {
    const response = await call('/v1/memory/proposals/00000000-0000-4000-8000-000000000000', {
      method: 'POST',
      body: JSON.stringify({ accept: true }),
      scopes: [...SUPPORTED_SCOPES],
    });

    expect(response.status).toBe(403);
  });

  it.each(HUMAN_DECISION_ROUTES.map((route) => ({ method: route[0], path: route[1] })))(
    'refuses $method $path from a token holding every scope',
    async ({ method, path }) => {
      // A concrete id for every parameter, so the request reaches the guard rather than
      // failing validation on the way there.
      const concrete = path.replace(/:[A-Za-z]+/g, '00000000-0000-4000-8000-000000000000');

      const response = await call(`/v1${concrete}`, {
        method,
        scopes: [...SUPPORTED_SCOPES],
        ...(method === 'POST' ? { body: JSON.stringify({}) } : {}),
      });

      expect(response.status).toBe(403);
      const body = (await response.json()) as { error: { code: string } };
      expect(body.error.code).toBe('forbidden');
    },
  );
});
