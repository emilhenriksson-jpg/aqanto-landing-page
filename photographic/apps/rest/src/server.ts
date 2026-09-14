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
import type { PersonId, SessionId } from '@photographic/core';
import {
  MemoryCodeSender,
  MemoryCodeStore,
  MemorySessionIssuer,
} from '@photographic/connect/testing';
import type { ConnectDeps } from '@photographic/connect';
import { createMemoryServices } from '@photographic/services-memory';

import { createApp } from './app.js';
import { loadConfigFromEnv } from './config.js';
import { createLogger } from './logger.js';
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
 * Development-only token issuing.
 *
 * Every session token the sign-up flow mints is accepted as a bearer token here, so the
 * onboarding app can complete the whole flow against a real API. This exists only while
 * `@photographic/auth` is missing and the process refuses to start in production, because
 * an OAuth provider that trusts a token it minted without checking anything is precisely
 * the bug that makes a memory layer readable by anyone.
 */
function createDevOAuthProvider(): OAuthProvider {
  if (config.environment === 'production') {
    throw new Error('Utvecklingsautentisering får aldrig köra i produktion.');
  }

  const notImplemented = async () => ({
    status: 501,
    body: { error: 'temporarily_unavailable', error_description: 'OAuth är inte inkopplad ännu.' },
  });

  return {
    introspect: async (token: string): Promise<TokenClaims | null> => {
      // `session-<personId>-<n>`, the shape `MemorySessionIssuer` mints.
      const personId = token.match(/^session-(.+)-\d+$/)?.[1];
      if (!personId) return null;
      if (!(await wired.services.identity.findById(personId as PersonId))) return null;

      const session = await wired.services.sessions.start({
        personId: personId as PersonId,
        agentClient: 'web',
        transport: 'rest',
      });

      return {
        personId: personId as PersonId,
        sessionId: session.id as SessionId,
        agentClient: 'web',
        clientId: 'dev',
        scopes: ['memory.read', 'memory.write', 'rooms.read', 'rooms.write'],
        roomScope: [],
        expiresAt: null,
      };
    },
    authorize: notImplemented,
    token: notImplemented,
    register: notImplemented,
    revoke: notImplemented,
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

const app = createApp({
  services: wired.services,
  config,
  logger,
  oauth: createDevOAuthProvider(),
  connect: { deps: connectDeps },
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
