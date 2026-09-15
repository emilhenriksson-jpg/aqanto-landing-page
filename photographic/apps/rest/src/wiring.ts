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
import type {
  AuthCodeStore,
  AuthServer,
  OAuthClientStore,
  PendingAuthorizationStore,
  PersonLookup,
  SessionTokenVerifier,
  TokenStore,
} from '@photographic/auth';
import {
  MemoryAuthCodeStore,
  MemoryClientStore,
  MemoryPendingAuthorizationStore,
  MemoryTokenStore,
} from '@photographic/auth/testing';
import type { ConnectDeps } from '@photographic/connect';
import { generateCode } from '@photographic/connect';
import { MemoryCodeStore, MemorySessionIssuer } from '@photographic/connect/testing';
import { createCodeSenderFromEnv, inertChannelDetail } from '@photographic/delivery';
import type { Actor, PersonId, Services, SessionId } from '@photographic/core';
import {
  createPool,
  createPostgresServices,
  defaultBlobRoot,
  describeDatabaseTls,
  PgAccounts,
  PgAuthCodeStore,
  PgClientGrants,
  PgOAuthClientStore,
  PgExports,
  PgPendingAuthorizationStore,
  PgTokenStore,
} from '@photographic/db';
import type { BlobStore } from '@photographic/documents';
import { createS3BlobStore, LocalBlobStore } from '@photographic/documents';
import { createLlmFromEnv } from '@photographic/llm';
import { createMcpApp, defaultConfig } from '@photographic/mcp';
import { createMemoryServices } from '@photographic/services-memory';
import {
  describeSupabase,
  looksLikeSupabase,
  supabaseConfigFromEnv,
  supabasePoolConfig,
  SupabaseStorageBlobStore,
} from '@photographic/supabase';
import type { Hono } from 'hono';

import { createApp } from './app.js';
import type { RestConfig } from './config.js';
import type { AppEnv } from './context.js';
import type { Logger } from './logger.js';
import { createOAuthProvider } from './oauth.js';
import { FIRST_PARTY_CLIENT_ID } from './oauth-contract.js';
import type { OAuthProvider, TokenClaims } from './oauth-contract.js';

export interface Wiring {
  app: Hono<AppEnv>;
  services: Services;
  auth: AuthServer;
  oauth: OAuthProvider;
  /**
   * Per-person, per-client grants — what `Klienter` lists, renames and revokes.
   *
   * Null without a database. Not a degraded version of the screen but the absence of
   * one: registrations that vanish on restart cannot be revoked in any sense a person
   * would recognise, and offering a revoke button that lasts until the next deploy
   * would be worse than offering none.
   */
  clientGrants: PgClientGrants | null;
  /** Export and account deletion. Null without a database; see `WiredServices`. */
  exports: PgExports | null;
  accounts: PgAccounts | null;
  /** Background work, run by whoever owns the schedule. */
  runJobs(): Promise<unknown>;
  purgeTrash(): Promise<number>;
  /**
   * The account lifecycle sweep: build queued exports, expire old archives, carry out
   * deletions whose freeze has run out.
   *
   * Separate from `runJobs` because it is not a projection rebuild and must not share
   * their cadence. An export reads a whole log and a deletion is irreversible; running
   * either every second would be wrong in opposite directions.
   */
  runAccountJobs(): Promise<{ exportsBuilt: number; archivesExpired: number; accountsDeleted: number }>;
  /** Closes whatever the chosen backend holds open (a Postgres pool; nothing for memory). */
  close(): Promise<void>;
}

/**
 * Where the authorization server keeps its state.
 *
 * Bundled together rather than passed as four arguments because they have to come from
 * the same place. A Postgres token store beside an in-memory client store would resolve
 * tokens that survived a restart against registrations that did not, and the failure
 * would look like every client suddenly being unknown.
 */
interface AuthStores {
  clients: OAuthClientStore;
  codes: AuthCodeStore;
  pending: PendingAuthorizationStore;
  tokens: TokenStore;
  /** Absent on the in-memory path: there is no Klienter screen without a database. */
  grants: PgClientGrants | null;
}

interface WiredServices {
  services: Services;
  authStores: AuthStores;
  /**
   * Export and account deletion. Null without a database: an export that cannot be
   * produced and a deletion that cannot be carried out are worse offered than withheld.
   */
  exports: PgExports | null;
  accounts: PgAccounts | null;
  runJobs(): Promise<unknown>;
  purgeTrash(): Promise<number>;
  close(): Promise<void>;
  llmKind: 'fake' | 'openai';
  persistence: 'postgres' | 'memory';
  /** Which `BlobStore` document originals land in. See `resolveBlobStore`. */
  storageKind: string;
}

/**
 * Picks the backend. The only place in the process that reads `DATABASE_URL`, so
 * `wiring.ts` stays the one seam where "which database" is decided.
 *
 * OAuth state moves with it. It used to be in-memory unconditionally, which meant every
 * token and every client registration vanished on restart — so a person revoking a
 * client's access was really revoking it until the next deploy, and per-client
 * permissions were a fiction. With `DATABASE_URL` set, registrations, codes, pending
 * authorizations and tokens all live in `app.oauth_*`.
 */
async function createServices(config: RestConfig): Promise<WiredServices> {
  const databaseUrl = process.env.DATABASE_URL;
  const { kind: llmKind, llm } = createLlmFromEnv();
  // Logged by the caller once wiring exists; kept as a return field so server.ts can
  // say which brain is answering without re-reading the environment.
  void llmKind;

  const { blobs, storageKind } = resolveBlobStore();

  if (databaseUrl) {
    // Supabase Postgres is Postgres, so this is a re-point rather than a rewrite: the
    // same migrations, the same seeds, the same suites.
    //
    // TLS is not composed here. `createPool` resolves it for every connection through
    // `resolveDatabaseTls`, which is also what `pnpm db:migrate` goes through — the
    // whole reason the boot migration could not reach Supabase was that this function
    // knew about the CA and that one did not. `supabasePoolConfig` still contributes the
    // pooler quirk, which is genuinely Supabase-specific.
    const pool = createPool(
      looksLikeSupabase(databaseUrl)
        ? supabasePoolConfig({ connectionString: databaseUrl }).config
        : { connectionString: databaseUrl },
    );

    // Resolved here rather than left to `createPostgresServices` to default, because
    // export and deletion need the same store the documents do — two defaults that
    // could disagree would mean an export reading from one place and uploads writing to
    // another.
    const effectiveBlobs = blobs ?? new LocalBlobStore({ root: defaultBlobRoot() });

    const wired = await createPostgresServices({
      pool,
      baseUrl: config.publicUrl,
      llm,
      blobs: effectiveBlobs,
    });
    return {
      services: wired.services,
      authStores: {
        clients: new PgOAuthClientStore(pool),
        codes: new PgAuthCodeStore(pool),
        pending: new PgPendingAuthorizationStore(pool),
        tokens: new PgTokenStore(pool),
        grants: new PgClientGrants(pool),
      },
      // Both take the storage port directly: an export writes its archive through it
      // and a deletion removes files through it, and neither is a read or write of
      // memory, so neither belongs on `Services`.
      exports: new PgExports(pool, effectiveBlobs),
      accounts: new PgAccounts(pool, effectiveBlobs),
      runJobs: () => wired.runJobsToCompletion(),
      purgeTrash: () => wired.services.trash.purgeExpired(),
      close: () => wired.close(),
      llmKind,
      persistence: 'postgres',
      storageKind,
    };
  }

  const wired = createMemoryServices({ baseUrl: config.publicUrl, llm });
  return {
    services: wired.services,
    authStores: {
      clients: new MemoryClientStore(),
      codes: new MemoryAuthCodeStore(),
      pending: new MemoryPendingAuthorizationStore(),
      tokens: new MemoryTokenStore(),
      grants: null,
    },
    exports: null,
    accounts: null,
    runJobs: () => wired.jobs.runOnce(),
    purgeTrash: () => wired.services.trash.purgeExpired(),
    close: async () => {
      // Nothing to release: the reference implementation holds no handles.
    },
    llmKind,
    persistence: 'memory',
    storageKind,
  };
}

/**
 * Where document originals go, decided in one place.
 *
 * The order is deliberate. An explicit S3 configuration wins, because someone who set
 * one meant it; then Supabase, because that is the platform default; then local disk,
 * which is right for a laptop and wrong for a container, where a restart loses the
 * files while the rows still reference them.
 *
 * Every branch returns a `BlobStore` and nothing below this line knows which. That is
 * the promise from the build plan made concrete: replacing Supabase Storage with R2 is
 * this function and nothing else.
 */
function resolveBlobStore(): { blobs: BlobStore | null; storageKind: string } {
  const s3BaseUrl = process.env.BLOB_S3_BASE_URL;
  if (s3BaseUrl && process.env.BLOB_S3_ACCESS_KEY_ID && process.env.BLOB_S3_SECRET_ACCESS_KEY) {
    return {
      blobs: createS3BlobStore({
        baseUrl: s3BaseUrl,
        accessKeyId: process.env.BLOB_S3_ACCESS_KEY_ID,
        secretAccessKey: process.env.BLOB_S3_SECRET_ACCESS_KEY,
        ...(process.env.BLOB_S3_REGION ? { region: process.env.BLOB_S3_REGION } : {}),
        ...(process.env.BLOB_S3_PREFIX ? { prefix: process.env.BLOB_S3_PREFIX } : {}),
      }),
      storageKind: 's3',
    };
  }

  const supabase = supabaseConfigFromEnv();
  if (supabase?.serviceRoleKey) {
    return {
      blobs: new SupabaseStorageBlobStore({
        url: supabase.url,
        serviceRoleKey: supabase.serviceRoleKey,
        bucket: supabase.storageBucket,
      }),
      storageKind: 'supabase',
    };
  }

  // Null hands the choice back to `createPostgresServices`, which defaults to
  // `LocalBlobStore`. Said here rather than constructed here so there is one default
  // rather than two that can disagree.
  return { blobs: null, storageKind: 'local' };
}

export async function createWiring(input: { config: RestConfig; logger: Logger }): Promise<Wiring> {
  const { config, logger } = input;
  const wired = await createServices(config);
  logger.info('llm_selected', { kind: wired.llmKind });
  // Worth a line at boot: "tokens survive a restart" and "they do not" are the same
  // process with one environment variable different, and nothing else says which.
  logger.info('oauth_persistence', { kind: wired.persistence });
  logger.info('blob_storage', { kind: wired.storageKind });

  // The first line to read on a deploy: it says which CA is in use, and therefore
  // whether the database connection is authenticated rather than merely encrypted.
  // Logged here rather than inside `createServices` because that function has no
  // logger, and a TLS decision nobody can see is how the original bug survived.
  if (process.env.DATABASE_URL) {
    for (const note of describeDatabaseTls(process.env.DATABASE_URL).notes) {
      logger.info('database_tls', { detail: note });
    }
  }

  // Said at boot rather than discovered later. A Supabase project that is configured for
  // Postgres but not for Storage is a normal state and not an error — but it is one an
  // operator should know about before someone uploads a file.
  const supabase = supabaseConfigFromEnv();
  if (supabase) {
    const readiness = describeSupabase(supabase);
    logger.info('supabase', { storage: readiness.storage, auth: readiness.auth });
    for (const note of readiness.missing) logger.warn('supabase_incomplete', { note });
  }

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

  const grants = wired.authStores.grants;

  const auth = createAuthServer({
    clients: wired.authStores.clients,
    codes: wired.authStores.codes,
    pending: wired.authStores.pending,
    tokens: grants
      ? recordingGrants(wired.authStores.tokens, grants, logger)
      : wired.authStores.tokens,
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

  /**
   * How a sign-up code reaches a person: a real provider when one is configured, the
   * log otherwise. `createCodeSenderFromEnv` is the only thing that reads the mail
   * environment, and it refuses to start half-configured rather than quietly logging
   * codes it was told to email.
   */
  const delivery = createCodeSenderFromEnv(process.env, { logger });
  // `mailProvider`, not `email`: the logger redacts any field called `email`, so this
  // line used to print the provider name as `[redacted]` and the one question it exists
  // to answer — "is this process actually delivering codes, or writing them to me?" —
  // could not be answered from it. The values are `log`/`resend`/`46elks`, never an
  // address.
  logger.info('code_delivery_selected', {
    mailProvider: delivery.email,
    smsProvider: delivery.sms,
  });

  // `error`, on every boot, once per inert channel.
  //
  // This is what stands in for refusing to start. A channel with no provider in
  // production does not deliver — it refuses at send time (see `RefusingCodeSender` for
  // why that is preferred over taking the whole site down over a signup setting) — and
  // the cost of that choice is that a broken channel could otherwise go unnoticed for
  // weeks. So it is said at the loudest level available, with the fix in the line, every
  // single boot, rather than once in a warning nobody reads twice.
  for (const channel of delivery.inert) {
    logger.error('code_delivery_inert', { channel, detail: inertChannelDetail(channel) });
  }

  if (!process.env.CODE_SECRET) {
    // Codes are HMACed under this key, so a fresh one per boot invalidates every code in
    // flight. Harmless on a laptop, and a restart mid-signup on a shared instance that a
    // person cannot explain.
    logger.warn('code_secret_ephemeral', {
      detail: 'CODE_SECRET är inte satt: koder i omlopp slutar gälla vid omstart.',
    });
  }

  const connect: ConnectDeps = {
    identity: wired.services.identity,
    invites: wired.services.invites,
    sessions: wired.services.sessions,
    codes,
    sender: delivery.sender,
    issuer: new MemorySessionIssuer(),
    codeSecret: process.env.CODE_SECRET ?? randomUUID(),
    clock: () => new Date(),
    // The CSPRNG from `@photographic/connect`, not a counter. This was
    // `100000 + (codeSeq += 1)`, which was survivable while the code only ever reached a
    // development log and is not survivable now that it reaches an inbox: sequential
    // codes mean watching one signup tells you the next person's code.
    randomCode: generateCode,
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
        actor: {
          personId: claims.personId,
          agentClient: claims.agentClient ?? 'unknown',
          sessionId: null,
          roomScope: claims.roomScope,
        },
        // Carried through rather than dropped here. Without them the MCP endpoint had no
        // way to tell a read-only connection from a full one, so every tool was offered
        // to every token and `DEFAULT_SCOPE` omitting `memory.write` meant nothing.
        scopes: claims.scopes,
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
    clientGrants: grants,
    exports: wired.exports,
    accounts: wired.accounts,
    // Straight to the store rather than through the authorization server's RFC 7009
    // endpoint: that one authenticates the *client* presenting a token, and this is the
    // person revoking a client that is not asking to be revoked.
    revokeClientTokens: (input) =>
      wired.authStores.tokens.revokeFamily(
        { clientId: input.clientId, personId: input.personId },
        new Date(),
      ),
  });

  return {
    app,
    services: wired.services,
    auth,
    oauth,
    clientGrants: wired.authStores.grants,
    exports: wired.exports,
    accounts: wired.accounts,
    runJobs: () => wired.runJobs(),
    purgeTrash: () => wired.purgeTrash(),
    runAccountJobs: () => runAccountJobs(wired, logger),
    close: () => wired.close(),
  };
}

/**
 * One pass of the account lifecycle.
 *
 * Bounded per pass rather than draining: an export can take minutes and a deletion is
 * irreversible, so a sweep that tried to finish everything would hold a connection open
 * and make a bad batch worse. Each pass takes a few and the next one takes a few more.
 *
 * Failures are logged and swallowed per item. One person's export failing must not stop
 * another person's deletion from being carried out on the day they were promised.
 */
async function runAccountJobs(
  wired: WiredServices,
  logger: Logger,
): Promise<{ exportsBuilt: number; archivesExpired: number; accountsDeleted: number }> {
  const idle = { exportsBuilt: 0, archivesExpired: 0, accountsDeleted: 0 };
  if (!wired.exports || !wired.accounts) return idle;

  let exportsBuilt = 0;
  for (const job of await wired.exports.pending(2)) {
    try {
      const finished = await wired.exports.run(job.id);
      if (finished?.status === 'ready') exportsBuilt += 1;
      else if (finished?.status === 'failed') {
        logger.error('export_failed', { exportId: job.id, error: finished.error });
      }
    } catch (error) {
      logger.error('export_crashed', {
        exportId: job.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const archivesExpired = await wired.exports.expireOld().catch(() => 0);

  let accountsDeleted = 0;
  for (const due of await wired.accounts.dueDeletions(5)) {
    try {
      const done = await wired.accounts.executeDeletion(due.id);
      if (done?.status === 'completed') {
        accountsDeleted += 1;
        // Logged without the person id: the account is a tombstone now, and putting
        // the id in a log line would be keeping a reference we just promised to remove.
        logger.info('account_deleted', { deletionId: due.id, removed: done.removed });
      }
    } catch (error) {
      logger.error('account_deletion_failed', {
        deletionId: due.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return { exportsBuilt, archivesExpired, accountsDeleted };
}

/**
 * Records a grant whenever a token is issued.
 *
 * Wrapping the store rather than adding a callback to the authorization server, because
 * `TokenStore.create` already *is* the moment a client gains access to a person's
 * memory: it is called exactly once per issuance, with the client, the person and the
 * scope, and it cannot be reached any other way. A separate hook would be a second
 * definition of that moment, and the two would drift.
 *
 * Failures are swallowed. The grant row drives a management screen; a token that was
 * issued but not listed is a bad screen, while an issuance that fails because the
 * screen's bookkeeping failed is a person locked out of their own memory.
 */
function recordingGrants(tokens: TokenStore, grants: PgClientGrants, logger: Logger): TokenStore {
  // Delegated method by method rather than `{ ...tokens, create }`. Spreading copies own
  // enumerable properties only, so a class instance loses every prototype method and the
  // wrapper ends up with nothing but `create` — which fails as a 401 on the next request
  // rather than as a type error here.
  return {
    findByAccessHash: (hash) => tokens.findByAccessHash(hash),
    findByRefreshHash: (hash) => tokens.findByRefreshHash(hash),
    revoke: (id, at) => tokens.revoke(id, at),
    revokeFamily: (family, at) => tokens.revokeFamily(family, at),
    touch: (id, at) => tokens.touch(id, at),

    create: async (input) => {
      const record = await tokens.create(input);
      try {
        await grants.record({
          personId: input.personId,
          clientId: input.clientId,
          scope: input.scope,
        });
      } catch (error) {
        logger.warn('client_grant_record_failed', {
          clientId: input.clientId,
          message: error instanceof Error ? error.message : String(error),
        });
      }
      return record;
    },
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
        clientId: FIRST_PARTY_CLIENT_ID,
        scopes: [...input.scopes],
        roomScope: [],
        expiresAt: null,
      };
    },
  };
}
