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

import type { PersonId, Services } from '@photographic/core';
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
  firstPartyOnly,
  requireScope,
} from './middleware.js';
import { FIRST_PARTY_ONLY_ROUTES, SCOPED_ROUTES } from './scoped-routes.js';
import type { OAuthProvider } from './oauth-contract.js';
import {
  createStubOAuthProvider,
  defaultAuthorizationServerMetadata,
  defaultProtectedResourceMetadata,
  OAUTH_PATHS,
} from './oauth-contract.js';
import { connectRoutes, publicConnectRoutes } from './routes/connect.js';
import { contextRoutes, type ClientGrants } from './routes/context.js';
import { documentRoutes } from './routes/documents.js';
import { historyRoutes } from './routes/history.js';
import { memoryRoutes } from './routes/memory.js';
import { oauthRoutes } from './routes/oauth.js';
import { publicInviteRoutes, roomRoutes } from './routes/rooms.js';
import { trashRoutes } from './routes/trash.js';
import { mountWebApp } from './web-app.js';

export interface AppDeps {
  services: Services;
  config?: RestConfig;
  logger?: Logger;
  /** Falls back to a stub that answers metadata and refuses every flow with 501. */
  oauth?: OAuthProvider;
  /** Sign-up needs a code store and a sender; omit to leave those routes unmounted. */
  connect?: { deps: ConnectDeps; config?: Partial<ConnectConfig> };
  /**
   * The MCP endpoint, mounted at `/mcp`.
   *
   * Passed in as a bare fetch handler rather than imported, so this app does not depend
   * on the MCP server and can be tested without one. The two surfaces share a process
   * because they have to share an origin: a client discovers the authorisation server
   * from the MCP endpoint's own metadata, and splitting the hosts means maintaining two
   * OAuth deployments to serve one login.
   */
  mcp?: { fetch(request: Request): Promise<Response> };

  /**
   * Per-person client registrations, for the `Klienter` screen.
   *
   * Optional because the in-memory deployment has none: registrations that vanish on
   * restart cannot honestly be listed as "AIs that can reach your memory", and the
   * routes answer 503 rather than an empty list.
   */
  clientGrants?: ClientGrants | null;

  /** Revokes every token one client holds for one person. See `ContextRouteDeps`. */
  revokeClientTokens?: (input: { personId: PersonId; clientId: string }) => Promise<number>;
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
  // MCP
  // ---------------------------------------------------------------------------

  // Mounted outside `authenticate`: MCP carries its own bearer token and has to answer an
  // unauthenticated request with a 401 that names its metadata document, which is how a
  // client discovers the login on its own. Routing it through this app's auth middleware
  // would return a 401 without that header, and every client would need setting up by
  // hand. The handler receives the request unmodified and matches on the path suffix, so
  // the prefix lives here and in no second place.
  if (deps.mcp) {
    const mcp = deps.mcp;
    app.all('/mcp', (c) => mcp.fetch(c.req.raw));
    app.all('/mcp/*', (c) => mcp.fetch(c.req.raw));
    // RFC 9728 puts the metadata for a resource at `/mcp` under this path, and it is what
    // the endpoint's own 401 points at. The API's document, one segment up, describes the
    // API — a client following the MCP challenge must not land on it and read a `resource`
    // it never asked for.
    app.get(`${OAUTH_PATHS.protectedResourceMetadata}/*`, (c) => mcp.fetch(c.req.raw));
  }

  // ---------------------------------------------------------------------------
  // OAuth
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

  // Registration and authorize are the two endpoints a stranger can reach, so they get
  // the tighter budget. Rate limiting them here rather than inside the auth package keeps
  // one limiter in the process, counting the same way for every route.
  app.use(OAUTH_PATHS.register, rateLimit({
    rule: config.rateLimits.register,
    key: (c) => `dcr:${clientAddress(c)}`,
  }));
  app.use(OAUTH_PATHS.authorize, rateLimit({
    rule: config.rateLimits.unauthenticated,
    key: (c) => `authorize:${clientAddress(c)}`,
  }));

  app.route('/', oauthRoutes(oauth));

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

  // Derived from config alone, and needed whether or not sign-up is mounted: the client
  // health lights describe the same clients the connect screen offers.
  const connectConfig: ConnectConfig = {
    mcpUrl: `${config.publicUrl}/mcp`,
    connectPageUrl: `${config.webUrl}/connect`,
    ...deps.connect?.config,
  };

  if (deps.connect) {
    app.use('/v1/signup/*', rateLimit({
      rule: config.rateLimits.signup,
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

  /**
   * Which scope each route needs, in one list.
   *
   * One list rather than a check at the top of each handler, because the interesting
   * question about scope enforcement is not "is this route covered" but "is any route
   * *not* covered" — and that is only answerable if the answers are in one place a
   * reviewer can read top to bottom.
   *
   * Registered per method, because the method is half of the answer: reading a room and
   * writing to it are the same path.
   */
  for (const [method, path, ...scopes] of SCOPED_ROUTES) {
    authenticated.on(method, path, requireScope(...scopes));
  }
  for (const [method, path] of FIRST_PARTY_ONLY_ROUTES) {
    authenticated.on(method, path, firstPartyOnly());
  }

  authenticated.route(
    '/',
    contextRoutes({
      connect: connectConfig,
      clientGrants: deps.clientGrants ?? null,
      ...(deps.revokeClientTokens ? { revokeClientTokens: deps.revokeClientTokens } : {}),
    }),
  );
  authenticated.route('/', memoryRoutes());
  authenticated.route('/', trashRoutes());
  authenticated.route('/', historyRoutes());
  authenticated.route('/', roomRoutes());
  authenticated.route('/', documentRoutes());

  app.route('/v1', authenticated);

  // ---------------------------------------------------------------------------
  // The browser app
  // ---------------------------------------------------------------------------

  // Last, so it can only answer paths the API did not claim, and only when there is a
  // build to serve. This is what lets one hostname carry the API, the MCP endpoint and
  // the login page an authorization request redirects to.
  if (config.webDist) mountWebApp(app, { dist: config.webDist });

  app.notFound((c) =>
    c.json({ error: { code: 'not_found', message: 'Den vägen finns inte.' } }, 404),
  );

  return app;
}
