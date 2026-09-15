/**
 * The composition root.
 *
 * Everything the process needs, constructed and handed back — but not started. Nothing
 * here listens on a port or sets a timer, which is the point: the wiring is the part
 * most likely to be wrong, and a test can only cover it if building it has no side
 * effects. `server.ts` is then a short script that reads `process.env`, builds this and
 * serves it.
 *
 * Which `Services` this builds depends on `DATABASE_URL`. Unset, it is the reference
 * implementation from `@photographic/services-memory` — what makes `pnpm dev` work on a
 * laptop with nothing installed, so the web and voice clients can be built against a
 * real HTTP API before Postgres exists. Set, it is `@photographic/db`'s
 * `createPostgresServices`, behind the exact same `Services` shape: nothing downstream
 * of this function — the app, the OAuth provider, the MCP mount — knows or needs to know
 * which one it is talking to.
 */

import { randomUUID } from 'node:crypto';

import { createAuthServer, createInMemoryRateLimiter } from '@photographic/auth';
import type { AuthServer, PersonLookup, SessionTokenVerifier } from '@photographic/auth';
import {
  MemoryAuthCodeStore,
  MemoryClientStore,
  MemoryPendingAuthorizationStore,
  MemoryTokenStore,
} from '@photographic/auth/testing';
import type { ConnectDeps } from '@photographic/connect';
import {
  MemoryCodeSender,
  MemoryCodeStore,
  MemorySessionIssuer,
} from '@photographic/connect/testing';
import type { Actor, PersonId, Services, SessionId } from '@photographic/core';
import { createPool, createPostgresServices } from '@photographic/db';
import { createMcpApp, defaultConfig } from '@photographic/mcp';
import { createMemoryServices } from '@photographic/services-memory';
import type { Hono } from 'hono';

import { createApp } from './app.js';
import type { RestConfig } from './config.js';
import type { AppEnv } from './context.js';
import type { Logger } from './logger.js';
import { createOAuthProvider } from './oauth.js';
import type { OAuthProvider, TokenClaims } from './oauth-contract.js';

export interface Wiring {
  app: Hono<AppEnv>;
  services: Services;
  auth: AuthServer;
  oauth: OAuthProvider;
  /** Background work, run by whoever owns the schedule. */
  runJobs(): Promise<unknown>;
  purgeTrash(): Promise<number>;
  /** Closes whatever the chosen backend holds open (a Postgres pool; nothing for memory). */
  close(): Promise<void>;
}

interface WiredServices {
  services: Services;
  runJobs(): Promise<unknown>;
  purgeTrash(): Promise<number>;
  close(): Promise<void>;
}

/**
 * Picks the backend. The only place in the process that reads `DATABASE_URL`, so
 * `wiring.ts` stays the one seam where "which database" is decided.
 */
async function createServices(config: RestConfig): Promise<WiredServices> {
  const databaseUrl = process.env.DATABASE_URL;

  if (databaseUrl) {
    const pool = createPool({ connectionString: databaseUrl });
    const wired = await createPostgresServices({ pool, baseUrl: config.publicUrl });
    return {
      services: wired.services,
      runJobs: () => wired.runJobsToCompletion(),
      purgeTrash: () => wired.services.trash.purgeExpired(),
      close: () => wired.close(),
    };
  }

  const wired = createMemoryServices({ baseUrl: config.publicUrl });
  return {
    services: wired.services,
    runJobs: () => wired.jobs.runOnce(),
    purgeTrash: () => wired.services.trash.purgeExpired(),
    close: async () => {
      // Nothing to release: the reference implementation holds no handles.
    },
  };
}

export async function createWiring(input: { config: RestConfig; logger: Logger }): Promise<Wiring> {
  const { config, logger } = input;
  const wired = await createServices(config);

  /**
   * Turns the browser session token from the sign-up flow into a person.
   *
   * `MemorySessionIssuer` mints `session-<personId>-<n>`, and this is the only place that
   * shape is known. It is a named dependency rather than a regex inline because the
   * authorization server needs it too: `/oauth/authorize/approve` identifies the person
   * from their session token, so whoever this returns is who the code is minted for.
   */
  const sessionTokens: SessionTokenVerifier = {
    verify: async (token) => {
      const personId = token.match(/^session-(.+)-\d+$/)?.[1] as PersonId | undefined;
      if (!personId) return null;
      return (await wired.services.identity.findById(personId)) ? personId : null;
    },
  };

  /**
   * Memberships, read fresh on every token resolution.
   *
   * Never cached onto a token: a token that remembered its rooms would keep reading one
   * after the person left it, and nothing would error.
   */
  const people: PersonLookup = {
    exists: async (personId) => (await wired.services.identity.findById(personId)) !== null,
    accessibleRoomIds: async (personId) => {
      const actor: Actor = { personId, agentClient: 'api', sessionId: null, roomScope: [] };
      const rooms = await wired.services.rooms.listForPerson(actor);
      return rooms.map((room) => room.roomId);
    },
  };

  const auth = createAuthServer({
    clients: new MemoryClientStore(),
    codes: new MemoryAuthCodeStore(),
    pending: new MemoryPendingAuthorizationStore(),
    tokens: new MemoryTokenStore(),
    people,
    sessions: sessionTokens,
    rateLimiter: createInMemoryRateLimiter({ limit: 30, windowSeconds: 60 }),
    logger,
    config: {
      issuer: config.publicUrl,
      // The MCP endpoint, not the origin. RFC 8707 audience binding is only worth
      // anything if the audience names what the token is actually used against.
      resource: `${config.publicUrl}/mcp`,
      // A page, so it belongs to the web app. The API origin serves no HTML.
      loginUrl: `${config.webUrl}/login`,
    },
  });

  const oauth = withFirstPartySessions({
    oauth: createOAuthProvider(auth),
    sessionTokens,
    services: wired.services,
    scopes: auth.config.scopesSupported,
  });

  const codes = new MemoryCodeStore();
  const sender = new MemoryCodeSender();
  let codeSeq = 0;

  // No email or SMS provider in development, so the code goes to the log. Printed
  // deliberately and only here: `MemoryCodeSender` is why it is reachable at all, and it
  // is not wired in production.
  const originalSend = sender.send.bind(sender);
  sender.send = async (message) => {
    await originalSend(message);
    logger.warn('signup_code', { channel: message.channel, code: message.code });
  };

  const connect: ConnectDeps = {
    identity: wired.services.identity,
    invites: wired.services.invites,
    sessions: wired.services.sessions,
    codes,
    sender,
    issuer: new MemorySessionIssuer(),
    codeSecret: process.env.CODE_SECRET ?? randomUUID(),
    clock: () => new Date(),
    randomCode: () => String(100000 + (codeSeq += 1)),
    randomId: () => randomUUID(),
  };

  /**
   * The MCP endpoint, on the same origin as the API.
   *
   * It resolves its own actor rather than reusing the API's auth middleware, and the
   * actor it gets has no session: MCP opens one per connection, at initialize, and
   * keeping it for the life of that connection is what makes the client health screen
   * meaningful. A session per request would show a green light that went out again
   * immediately.
   */
  const mcp = createMcpApp({
    services: wired.services,
    config: defaultConfig({
      publicUrl: config.publicUrl,
      scopesSupported: auth.config.scopesSupported,
    }),
    log: logger,
    authenticate: async (token) => {
      const claims = await oauth.introspect(token);
      if (!claims) return null;

      return {
        personId: claims.personId,
        agentClient: claims.agentClient ?? 'unknown',
        sessionId: null,
        roomScope: claims.roomScope,
      };
    },
  });

  const app = createApp({
    services: wired.services,
    config,
    logger,
    oauth,
    connect: { deps: connect },
    mcp,
  });

  return {
    app,
    services: wired.services,
    auth,
    oauth,
    runJobs: () => wired.runJobs(),
    purgeTrash: () => wired.purgeTrash(),
    close: () => wired.close(),
  };
}

/**
 * The first-party browser credential, alongside real OAuth.
 *
 * The onboarding and web clients hold a session token, not an access token: they sign a
 * person in with a code sent to their email and never run an OAuth flow, because
 * redirecting our own app to our own authorization server to get back to our own API
 * would be ceremony with no security to show for it. So the API accepts both, and this
 * decides which is which by shape.
 *
 * What it must never become is a provider that trusts a token for looking familiar. Every
 * session token is checked against a real person, and anything else goes straight to the
 * authorization server, which is the only thing that can validate an access token.
 */
function withFirstPartySessions(input: {
  oauth: OAuthProvider;
  sessionTokens: SessionTokenVerifier;
  services: Services;
  scopes: string[];
}): OAuthProvider {
  // One session per person rather than one per request. A fresh session on every call
  // would leave the client health screen reading from a session that never received
  // anything, so the web client would show as red seconds after it worked.
  const webSessions = new Map<PersonId, SessionId>();

  return {
    ...input.oauth,
    introspect: async (token: string): Promise<TokenClaims | null> => {
      if (!token.startsWith('session-')) return input.oauth.introspect(token);

      const personId = await input.sessionTokens.verify(token);
      if (!personId) return null;

      let sessionId = webSessions.get(personId);
      if (!sessionId) {
        const session = await input.services.sessions.start({
          personId,
          agentClient: 'web',
          transport: 'rest',
        });
        sessionId = session.id;
        webSessions.set(personId, sessionId);
      }

      return {
        personId,
        sessionId,
        agentClient: 'web',
        clientId: 'first-party',
        scopes: [...input.scopes],
        roomScope: [],
        expiresAt: null,
      };
    },
  };
}
