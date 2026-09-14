/**
 * The app.
 *
 * `createApp` takes everything it needs and constructs nothing itself: no database
 * pool, no OAuth provider, no clock. That is what makes it testable against the
 * reference implementation in `@photographic/services-memory` and deployable against
 * Postgres without a line changing here.
 *
 * Middleware order is load-bearing and stated once, below.
 */

import type { Services } from '@photographic/core';
import type { ConnectConfig, ConnectDeps } from '@photographic/connect';
import { Hono } from 'hono';

import type { RestConfig } from './config.js';
import { loadConfigFromEnv } from './config.js';
import type { AppEnv } from './context.js';
import type { Logger } from './logger.js';
import { createLogger } from './logger.js';
import {
  accessLog,
  authenticate,
  clientAddress,
  cors,
  handleError,
  rateLimit,
  requestContext,
} from './middleware.js';
import type { OAuthProvider } from './oauth-contract.js';
import {
  createStubOAuthProvider,
  defaultAuthorizationServerMetadata,
  defaultProtectedResourceMetadata,
  OAUTH_PATHS,
} from './oauth-contract.js';
import { connectRoutes, publicConnectRoutes } from './routes/connect.js';
import { contextRoutes } from './routes/context.js';
import { historyRoutes } from './routes/history.js';
import { memoryRoutes } from './routes/memory.js';
import { publicInviteRoutes, roomRoutes } from './routes/rooms.js';
import { trashRoutes } from './routes/trash.js';

export interface AppDeps {
  services: Services;
  config?: RestConfig;
  logger?: Logger;
  /** Falls back to a stub that answers metadata and refuses every flow with 501. */
  oauth?: OAuthProvider;
  /** Sign-up needs a code store and a sender; omit to leave those routes unmounted. */
  connect?: { deps: ConnectDeps; config?: Partial<ConnectConfig> };
}

export function createApp(deps: AppDeps): Hono<AppEnv> {
  const config = deps.config ?? loadConfigFromEnv();
  const logger = deps.logger ?? createLogger({ level: config.logLevel });
  const oauth = deps.oauth ?? createStubOAuthProvider();

  const app = new Hono<AppEnv>();

  // Order: context first so every later layer has a logger and a request id. CORS
  // before rate limiting so a preflight is never counted against a budget. Rate
  // limiting before auth so a flood costs no token lookups. Auth last, immediately in
  // front of the routes that require it.
  app.use('*', requestContext({ config, logger, services: deps.services }));
  app.use('*', accessLog());
  app.use('*', cors(config));

  // Not middleware. Hono catches handler errors inside its own dispatch and never
  // rethrows into the middleware chain, so a try/catch around `next()` would leave
  // every domain error as a 500. See `handleError`.
  app.onError(handleError);

  app.get('/health', (c) => c.json({ ok: true, environment: config.environment }));

  // ---------------------------------------------------------------------------
  // OAuth discovery
  // ---------------------------------------------------------------------------

  const metadataInput = { publicUrl: config.publicUrl, issuer: config.publicUrl };

  app.get(OAUTH_PATHS.protectedResourceMetadata, (c) =>
    c.json(
      oauth.protectedResourceMetadata?.(metadataInput) ??
        defaultProtectedResourceMetadata(metadataInput),
    ),
  );

  app.get(OAUTH_PATHS.authorizationServerMetadata, (c) =>
    c.json(
      oauth.authorizationServerMetadata?.(metadataInput) ??
        defaultAuthorizationServerMetadata(metadataInput),
    ),
  );

  // ---------------------------------------------------------------------------
  // Unauthenticated
  // ---------------------------------------------------------------------------

  const anonymous = rateLimit({
    rule: config.rateLimits.unauthenticated,
    key: (c) => `anon:${clientAddress(c)}`,
  });

  // Harder limit: the invite preview is the only endpoint a stranger can enumerate,
  // and the only one where guessing tokens would be worth anything.
  app.use('/v1/invites/*', rateLimit({
    rule: config.rateLimits.invitePreview,
    key: (c) => `invite:${clientAddress(c)}`,
  }));
  app.route('/v1', publicInviteRoutes());

  if (deps.connect) {
    const connectConfig: ConnectConfig = {
      mcpUrl: `${config.publicUrl}/mcp`,
      connectPageUrl: `${config.publicUrl}/connect`,
      ...deps.connect.config,
    };

    app.use('/v1/signup/*', rateLimit({
      rule: config.rateLimits.register,
      key: (c) => `signup:${clientAddress(c)}`,
    }));
    app.use('/v1/connect', anonymous);
    app.route('/v1', publicConnectRoutes({ connect: deps.connect.deps, config: connectConfig }));

    app.use('/v1/connect/*', authenticate(oauth));
    app.use('/v1/import', authenticate(oauth));
    app.use('/v1/import/*', authenticate(oauth));
    app.route('/v1', connectRoutes({ connect: deps.connect.deps, config: connectConfig }));
  }

  // ---------------------------------------------------------------------------
  // Authenticated
  // ---------------------------------------------------------------------------

  const authenticated = new Hono<AppEnv>();

  authenticated.use('*', authenticate(oauth));
  authenticated.use(
    '*',
    rateLimit({
      rule: config.rateLimits.authenticated,
      key: (c) => `person:${c.get('actor')?.personId ?? clientAddress(c)}`,
    }),
  );

  authenticated.route('/', contextRoutes());
  authenticated.route('/', memoryRoutes());
  authenticated.route('/', trashRoutes());
  authenticated.route('/', historyRoutes());
  authenticated.route('/', roomRoutes());

  app.route('/v1', authenticated);

  app.notFound((c) =>
    c.json({ error: { code: 'not_found', message: 'Den vägen finns inte.' } }, 404),
  );

  return app;
}
