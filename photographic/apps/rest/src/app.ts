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

import { BREAK_GLASS_PATH, breakGlassPage } from './break-glass-page.js';
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
import { calendarRoutes } from './routes/calendar.js';
import { connectRoutes, publicConnectRoutes } from './routes/connect.js';
import {
  accountRoutes,
  deletionRoutes,
  publicExportRoutes,
  type AccountService,
  type ExportService,
} from './routes/account.js';
import { contextRoutes, type ClientGrants } from './routes/context.js';
import { documentRoutes } from './routes/documents.js';
import { historyRoutes } from './routes/history.js';
import { memoryRoutes } from './routes/memory.js';
import { oauthRoutes } from './routes/oauth.js';
import { opsRoutes, type QueueSource } from './routes/ops.js';
import { personRoutes } from './routes/person.js';
import { publicInviteRoutes, roomRoutes } from './routes/rooms.js';
import { sessionRoutes } from './routes/session.js';
import { trashRoutes } from './routes/trash.js';
import {
  APEX_ROOT_ROUTES,
  AUTH_APP_ROUTES,
  mountWebApp,
  PRODUCT_APP_ROUTES,
  requestHost,
} from './web-app.js';

export interface AppDeps {
  services: Services;
  config?: RestConfig;
  logger?: Logger;
  /**
   * What `/health` asks before answering, and what it reports.
   *
   * Passed in rather than imported so this app still does not depend on the database.
   * Omitted — in tests and without a database — `/health` reports the persistence kind
   * and nothing about a round trip, which is honest rather than green.
   */
  health?: {
    persistence: 'postgres' | 'memory';
    /** `SELECT 1`, essentially. Resolves or throws. */
    checkDatabase?: () => Promise<void>;
  };
  /** Falls back to a stub that answers metadata and refuses every flow with 501. */
  oauth?: OAuthProvider;
  /** Sign-up needs a code store and a sender; omit to leave those routes unmounted. */
  connect?: {
    deps: ConnectDeps;
    config?: Partial<ConnectConfig>;
    /**
     * The key `scripts/break-glass-signin.ts` signs with. Read from the environment by the
     * composition root and passed in, never read here. Absent means the break-glass
     * exchange accepts nothing — which is the state every deployment is in until someone
     * sets the secret deliberately.
     */
    breakGlassSecret?: string | null;
  };
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

  /**
   * Export and account deletion. Absent without a database, where both answer 503
   * rather than pretending: an export that cannot be produced and a deletion that
   * cannot be carried out are worse offered than withheld.
   */
  exports?: ExportService | null;
  accounts?: AccountService | null;

  /**
   * Queue depth, stuck claims and failures, for `GET /v1/ops/queue`.
   *
   * Absent without a database: the in-memory queue is this process's own array, and
   * reporting its depth would answer a question about the harness rather than about the
   * product.
   */
  queue?: QueueSource | null;
}

export function createApp(deps: AppDeps): Hono<AppEnv> {
  const config = deps.config ?? loadConfigFromEnv();
  const logger =
    deps.logger ??
    createLogger({
      level: config.logLevel,
      revealSignupCode: config.environment !== 'production',
    });
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

  /**
   * Health, meaning "the memory is real", not "the process is listening".
   *
   * This returned `{ok:true}` unconditionally, which made it useless for the failure it
   * most needed to catch: with `DATABASE_URL` unset the process runs the in-memory
   * implementation, answers every route correctly, and loses everything on restart —
   * and Fly, which restarts a machine that stops answering *this*, was told all was
   * well. Two very different systems behind one green light.
   *
   * So it round-trips the database when there is one, and says which implementation is
   * answering either way. `persistence` is in the body so the difference is visible to
   * anyone looking, not only to whoever reads the boot log once.
   */
  app.get('/health', async (c) => {
    const persistence = deps.health?.persistence ?? 'memory';
    const check = deps.health?.checkDatabase;

    if (!check) return c.json({ ok: true, persistence, environment: config.environment });

    try {
      await check();
      return c.json({ ok: true, persistence, database: 'ok', environment: config.environment });
    } catch (error) {
      logger.error('health_database_unreachable', {
        detail: error instanceof Error ? error.message : String(error),
      });
      // 503, so Fly's own health check restarts the machine instead of leaving it in the
      // pool answering requests it cannot serve.
      return c.json(
        { ok: false, persistence, database: 'unreachable', environment: config.environment },
        503,
      );
    }
  });

  // ---------------------------------------------------------------------------
  // MCP
  // ---------------------------------------------------------------------------

  // Mounted outside `authenticate`: MCP carries its own bearer token and has to answer an
  // unauthenticated request with a 401 that names its metadata document, which is how a
  // client discovers the login on its own. Routing it through this app's auth middleware
  // would return a 401 without that header, and every client would need setting up by
  // hand. The handler receives the request unmodified and matches on the path suffix, so
  // the prefix lives here and in no second place.
  /**
   * One OAuth origin, and it is `mcp.`.
   *
   * The apex answers on the same process, so without this it would serve `/oauth/*`,
   * `/mcp` and both metadata documents too — a second origin for the same authorization
   * server, reached by a hostname the issuer never mentions. That is not a cosmetic
   * duplication: the issuer, the registered redirect URIs and the `resource` a client
   * sends all derive from `PUBLIC_URL`, so a client that discovered the apex would
   * authorize against one origin and hold tokens minted for another, and the mismatch
   * would surface as an intermittent auth failure rather than as a misconfiguration.
   *
   * 404 rather than a redirect, deliberately. A redirect would make the apex a working
   * alias and invite clients to keep using it; the point is that exactly one name is the
   * endpoint. `/v1/*` and `/health` are untouched, because the product served on the apex
   * calls them same-origin and signing in there depends on it.
   */
  if (config.apexHost) {
    const apexHost = config.apexHost;
    const oauthOnly = [
      '/oauth',
      '/mcp',
      OAUTH_PATHS.protectedResourceMetadata,
      OAUTH_PATHS.authorizationServerMetadata,
    ];

    app.use('*', async (c, next) => {
      const path = c.req.path;
      const claimed = oauthOnly.some(
        (prefix) => path === prefix || path.startsWith(`${prefix}/`),
      );
      if (claimed && requestHost(c.req.header('host'), c.req.url) === apexHost) {
        return c.json(
          {
            error: {
              code: 'not_found',
              message: `Den vägen finns bara på ${new URL(config.publicUrl).host}.`,
            },
          },
          404,
        );
      }
      return next();
    });
  }

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

  /**
   * The signed export download, before the authenticated group.
   *
   * Mounted here and not after it, because `authenticated.use('*')` becomes middleware
   * on `/v1/*` once the sub-app is routed in — so a "public" route registered later is
   * still behind auth, and the only symptom is a 401 on a link that should work.
   *
   * Rate limited like the invite preview: it is the other endpoint a stranger can
   * present a token to, and the token is the whole authority.
   */
  app.use('/v1/export/download/*', rateLimit({
    rule: config.rateLimits.invitePreview,
    key: (c) => `export-download:${clientAddress(c)}`,
  }));
  app.route('/v1', publicExportRoutes({ exports: deps.exports ?? null }));
  // Browser sign-out must work even when the cookie is stale. It owns no data and
  // clears only the cookie, while the route itself still rejects cross-site requests.
  app.route('/v1', sessionRoutes());

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
    app.route(
      '/v1',
      publicConnectRoutes({
        connect: deps.connect.deps,
        config: connectConfig,
        breakGlassSecret: deps.connect.breakGlassSecret ?? null,
      }),
    );

    /**
     * The page that spends a break-glass token, on the origin the token is for.
     *
     * Registered here rather than left to the browser apps: it must render on a
     * deployment where a bundle failed to build, which is precisely the kind of day
     * someone needs it. Static, secretless, and `no-store` so a shared machine's cache
     * does not keep the page that was mid-sign-in.
     */
    app.get(BREAK_GLASS_PATH, (c) => {
      c.header('cache-control', 'no-store');
      c.header('x-robots-tag', 'noindex, nofollow');
      return c.html(breakGlassPage());
    });

    // The authenticated half of the connect flow is *not* mounted here. It goes on the
    // `authenticated` sub-app below, which is the only place `requireScope` is attached
    // (see the comment there). Registering it here with a bare `authenticate` — which is
    // what this branch originally did, before the scope table covered these routes —
    // authenticates the caller and then runs no scope check at all, so a read-only
    // connection could queue proposals through `POST /v1/import`. Both mounts existed for
    // a moment during this merge and the outer one won, which is exactly how the hole
    // reappears.
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
  /**
   * The authenticated half of the connect flow, inside this group rather than beside it.
   *
   * `/v1/import`, `/v1/import/preview` and `/v1/connect/*` had their own
   * `app.use(..., authenticate(oauth))` and were routed straight onto `app`, so the
   * `SCOPED_ROUTES` loop above — registered on this sub-app — never covered them. They were
   * authenticated and unscoped, which is how a token deliberately issued without
   * `memory.write` could queue proposals through `POST /v1/import`.
   *
   * Mounting them here means one authentication, one rate limit and one scope table for
   * every authenticated route, so "is any route not covered" has a single answer again.
   * `publicConnectRoutes` stays above, where sign-up and the connect screen belong: those
   * genuinely run before a token exists.
   */
  if (deps.connect) {
    authenticated.route('/', connectRoutes({ connect: deps.connect.deps, config: connectConfig }));
  }

  authenticated.route('/', memoryRoutes());
  authenticated.route('/', trashRoutes());
  authenticated.route('/', historyRoutes());
  authenticated.route('/', calendarRoutes());
  authenticated.route('/', roomRoutes());
  authenticated.route('/', documentRoutes());
  authenticated.route('/', personRoutes());

  // First-party only, like client management: no OAuth scope should let a connected AI
  // export a person's whole memory or delete their account.
  authenticated.route('/', accountRoutes({ exports: deps.exports ?? null }));
  authenticated.route('/', deletionRoutes({ accounts: deps.accounts ?? null }));

  // First-party too, though for a different reason: it says nothing about anyone's
  // memory, and there is no client that has any business asking.
  authenticated.route('/', opsRoutes({ queue: deps.queue ?? null }));

  app.route('/v1', authenticated);

  // ---------------------------------------------------------------------------
  // The browser app
  // ---------------------------------------------------------------------------

  /**
   * The short invite link, redirected to the landing that actually accepts an invite.
   *
   * There were two invite screens: the one every generated link points at
   * (`/invite/:token`, served by the auth app, which signs the person up and accepts the
   * invite) and a copy in the product app at `/i/:token` whose "Gå med" only set React
   * state — it showed a success page and joined nothing. The copy is deleted rather than
   * finished, because two versions of the first thing a person ever sees of this product
   * will drift, and the dead one is the one someone eventually improves. The path stays
   * as a redirect so a short link that was ever shared still works.
   */
  app.get('/i/:token', (c) =>
    c.redirect(`/invite/${encodeURIComponent(c.req.param('token'))}`, 302),
  );

  // Last, so they can only answer paths the API did not claim, and only where there is a
  // build to serve. This is what lets one hostname carry the API, the MCP endpoint, the
  // login page an authorization request redirects to, and the product itself.
  //
  // The auth app is listed first so it stays authoritative for `/login` even if the
  // product app were ever given an overlapping route: the OAuth round trip depends on
  // that page and nothing else should be able to take it.
  // The apex serves the auth bundle at `/` and the product everywhere else, so a person
  // typing `photographic.space` meets sign-in rather than a screen that needs a session.
  // Listed before the product mount because the first mount owning a path wins, and both
  // claim `/`; the host filter is what keeps `mcp.` answering there with the product.
  mountWebApp(
    app,
    ...(config.webDist && config.apexHost
      ? [
          {
            name: 'onboarding-apex',
            dist: config.webDist,
            routes: APEX_ROOT_ROUTES,
            hosts: [config.apexHost],
          },
        ]
      : []),
    ...(config.webDist
      ? [{ name: 'onboarding', dist: config.webDist, routes: AUTH_APP_ROUTES }]
      : []),
    ...(config.appDist
      ? [{ name: 'web', dist: config.appDist, routes: PRODUCT_APP_ROUTES }]
      : []),
  );

  app.notFound((c) =>
    c.json({ error: { code: 'not_found', message: 'Den vägen finns inte.' } }, 404),
  );

  return app;
}
