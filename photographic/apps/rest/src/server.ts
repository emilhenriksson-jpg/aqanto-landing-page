/**
 * The process.
 *
 * Runs the API against the reference implementation when no database is configured,
 * which is what makes `pnpm dev` work on a laptop with nothing installed. The point of
 * that is not convenience: it means the web and voice clients can be built and reviewed
 * against a real HTTP API before the Postgres layer exists.
 *
 * `DATABASE_URL` will select the real services once `@photographic/db` implements the
 * ports, and until then setting it is an error rather than a silent downgrade — being
 * told the database is not wired up is useful, believing you are talking to it when you
 * are not is not.
 */

import { randomUUID } from 'node:crypto';

import { serve } from '@hono/node-server';
import type { Actor, PersonId, SessionId } from '@photographic/core';
import { createAuthServer, createInMemoryRateLimiter } from '@photographic/auth';
import type { PersonLookup, SessionTokenVerifier } from '@photographic/auth';
import {
  MemoryAuthCodeStore,
  MemoryClientStore,
  MemoryPendingAuthorizationStore,
  MemoryTokenStore,
} from '@photographic/auth/testing';
import {
  MemoryCodeSender,
  MemoryCodeStore,
  MemorySessionIssuer,
} from '@photographic/connect/testing';
import type { ConnectDeps } from '@photographic/connect';
import { createMcpApp, defaultConfig } from '@photographic/mcp';
import { createMemoryServices } from '@photographic/services-memory';

import { createApp } from './app.js';
import { loadConfigFromEnv } from './config.js';
import { createLogger } from './logger.js';
import { createOAuthProvider } from './oauth.js';
import type { OAuthProvider, TokenClaims } from './oauth-contract.js';

const config = loadConfigFromEnv();
const logger = createLogger({ level: config.logLevel });

if (process.env.DATABASE_URL) {
  logger.error('database_not_wired', {
    detail: 'DATABASE_URL är satt men @photographic/db implementerar inte portarna ännu.',
  });
  process.exit(1);
}

logger.warn('using_reference_implementation', {
  detail: 'Inget DATABASE_URL: kör mot minnesimplementationen. Data försvinner vid omstart.',
});

const wired = createMemoryServices({ baseUrl: config.publicUrl });

/**
 * Turns the browser session token from the sign-up flow into a person.
 *
 * `MemorySessionIssuer` mints `session-<personId>-<n>`, and this is the only place that
 * shape is known. It exists as a named dependency rather than a regex inline because the
 * authorization server needs it too: `/oauth/authorize/approve` identifies the person
 * from their session token, so an authorization code is minted for whoever this returns.
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
    // The MCP endpoint, not the origin. RFC 8707 audience binding is only worth anything
    // if the audience names what the token is actually used against.
    resource: `${config.publicUrl}/mcp`,
    loginUrl: `${config.publicUrl}/login`,
  },
});

/**
 * The first-party browser credential, alongside real OAuth.
 *
 * The onboarding and web clients hold a session token, not an access token: they sign a
 * person in with a code sent to their email and never run an OAuth flow, because
 * redirecting our own app to our own authorization server to get back to our own API
 * would be ceremony with no security to show for it. So the API accepts both, and this
 * decides which is which by shape.
 *
 * What it must never become is a provider that trusts a token because it looks familiar.
 * Every session token is checked against a real person, and an access token is handed
 * straight to the authorization server, which is the only thing that can validate one.
 */
function withFirstPartySessions(oauth: OAuthProvider): OAuthProvider {
  // One session per person rather than one per request. A fresh session on every call
  // would leave the client health screen reading from a session that never received
  // anything, so the web client would show as red seconds after it worked.
  const webSessions = new Map<PersonId, SessionId>();

  return {
    ...oauth,
    introspect: async (token: string): Promise<TokenClaims | null> => {
      if (!token.startsWith('session-')) return oauth.introspect(token);

      const personId = await sessionTokens.verify(token);
      if (!personId) return null;

      let sessionId = webSessions.get(personId);
      if (!sessionId) {
        const session = await wired.services.sessions.start({
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
        scopes: ['memory.read', 'memory.write', 'rooms.read', 'rooms.write', 'documents.write'],
        roomScope: [],
        expiresAt: null,
      };
    },
  };
}

const codes = new MemoryCodeStore();
const sender = new MemoryCodeSender();
let codeSeq = 0;

const connectDeps: ConnectDeps = {
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

// No email or SMS provider in development, so the code goes to the log. Printed
// deliberately and only here: `MemoryCodeSender` is why it is reachable at all, and it
// is not wired in production.
const originalSend = sender.send.bind(sender);
sender.send = async (input) => {
  await originalSend(input);
  logger.warn('signup_code', { channel: input.channel, code: input.code });
};

const oauth = withFirstPartySessions(createOAuthProvider(auth));

/**
 * The MCP endpoint, on the same origin as the API.
 *
 * It resolves its own actor rather than reusing the API's auth middleware, and the actor
 * it gets has no session: MCP opens one per connection, at initialize, and keeping it for
 * the life of that connection is what makes the client health screen meaningful. A
 * session per request would show the person a green light that went out again immediately.
 */
const mcp = createMcpApp({
  services: wired.services,
  config: defaultConfig({ publicUrl: config.publicUrl }),
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
  connect: { deps: connectDeps },
  mcp,
});

// Background work runs on a timer rather than a separate worker process, which is right
// for development and is the first thing to split out when there is more than one
// instance: two processes sweeping the same queue would each rebuild every projection.
const jobTimer = setInterval(() => {
  void wired.jobs.runOnce().catch((error: unknown) => {
    logger.error('job_failed', { error: error instanceof Error ? error.message : String(error) });
  });
}, 1000);

const purgeTimer = setInterval(() => {
  void wired.services.trash.purgeExpired().then((count) => {
    if (count > 0) logger.info('trash_purged', { count });
  });
}, 60_000);

const server = serve({ fetch: app.fetch, hostname: config.host, port: config.port }, (info) => {
  logger.info('listening', { port: info.port, publicUrl: config.publicUrl });
});

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    clearInterval(jobTimer);
    clearInterval(purgeTimer);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), config.shutdownGraceMs).unref();
  });
}
