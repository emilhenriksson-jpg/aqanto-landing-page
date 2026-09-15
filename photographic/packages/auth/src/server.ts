/**
 * The authorization server, assembled.
 *
 * Every handler takes an `AuthRequest` and returns an `AuthResponse`, so this package
 * never imports a web framework and `apps/rest` adapts hono to two plain types. That is
 * not tidiness: it means the security-critical code has no reason to change when the
 * framework does, and every one of these handlers is testable by calling it.
 *
 * Two endpoints here are not in any RFC. `GET /oauth/authorize/request` and
 * `POST /oauth/authorize/approve` exist because Photographic has no passwords — see
 * `authorize.ts` for why the flow has to split in half around a login page.
 */

import type { AgentClient, PersonId, RoomId, SessionId } from '@photographic/core';

import {
  approveAuthorization,
  describeAuthorization,
  startAuthorization,
} from './authorize.js';
import { registerClient, registrationResponse } from './clients.js';
import type { AuthServerConfig, AuthServerConfigInput } from './config.js';
import { resolveAuthConfig } from './config.js';
import type {
  AuthCodeStore,
  AuthLogger,
  Clock,
  OAuthClientStore,
  PendingAuthorizationStore,
  PersonLookup,
  RateLimiter,
  SessionTokenVerifier,
  TokenStore,
} from './deps.js';
import { silentLogger } from './deps.js';
import type { AuthRequest, AuthResponse } from './http.js';
import {
  cacheableJson,
  formParams,
  hasDuplicateParams,
  json,
  jsonBody,
  parseBasicAuth,
  queryParams,
  redirect,
} from './http.js';
import { authorizationServerMetadata, protectedResourceMetadata } from './metadata.js';
import { resolveActor } from './actor.js';
import { TokenService } from './tokens.js';
import { handleTokenRequest } from './token.js';

export interface AuthServerDeps {
  clients: OAuthClientStore;
  codes: AuthCodeStore;
  pending: PendingAuthorizationStore;
  tokens: TokenStore;
  people: PersonLookup;
  sessions: SessionTokenVerifier;
  config: AuthServerConfigInput;
  /** Guards the two endpoints a stranger can call: registration and authorize. */
  rateLimiter?: RateLimiter;
  now?: Clock;
  logger?: AuthLogger;
}

/** What a valid access token proves. Mirrors the shape `apps/rest` expects. */
export interface AccessTokenClaims {
  personId: PersonId;
  sessionId: SessionId | null;
  agentClient: AgentClient | null;
  clientId: string;
  scopes: string[];
  roomScope: RoomId[];
  expiresAt: Date | null;
}

export interface AuthServer {
  config: AuthServerConfig;
  tokens: TokenService;

  /** Resolves a bearer token, or null for unknown, revoked and expired alike. */
  introspect(token: string): Promise<AccessTokenClaims | null>;

  authorize(request: AuthRequest): Promise<AuthResponse>;
  token(request: AuthRequest): Promise<AuthResponse>;
  register(request: AuthRequest): Promise<AuthResponse>;
  revoke(request: AuthRequest): Promise<AuthResponse>;

  /** What the login page needs to show the person what they are approving. */
  describeRequest(request: AuthRequest): Promise<AuthResponse>;
  /** Called by the login page once the person is signed in and has answered. */
  approve(request: AuthRequest): Promise<AuthResponse>;

  authorizationServerMetadata(): AuthResponse;
  protectedResourceMetadata(): AuthResponse;
}

export function createAuthServer(deps: AuthServerDeps): AuthServer {
  const config = resolveAuthConfig(deps.config);
  const logger = deps.logger ?? silentLogger;
  const now = deps.now ?? (() => new Date());

  const tokenService = new TokenService({ tokens: deps.tokens, config, now, logger });

  const flow = {
    clients: deps.clients,
    pending: deps.pending,
    codes: deps.codes,
    sessions: deps.sessions,
    people: deps.people,
    config,
    now,
    logger,
  };

  async function overBudget(request: AuthRequest, bucket: string): Promise<boolean> {
    if (!deps.rateLimiter) return false;
    return !(await deps.rateLimiter.take(`${bucket}:${request.ip ?? 'unknown'}`));
  }

  return {
    config,
    tokens: tokenService,

    introspect: async (raw) => {
      try {
        const resolved = await resolveActor(raw, {
          tokens: tokenService,
          clients: deps.clients,
          people: deps.people,
          logger,
        });

        return {
          personId: resolved.actor.personId,
          sessionId: resolved.actor.sessionId,
          agentClient: resolved.actor.agentClient,
          clientId: resolved.clientId,
          scopes: resolved.scope.split(' ').filter((scope) => scope !== ''),
          roomScope: resolved.actor.roomScope,
          expiresAt: null,
        };
      } catch {
        // One answer for every failure. The caller renders a 401 with no detail, which is
        // the only response that does not tell a holder of a bad token why it is bad.
        return null;
      }
    },

    authorize: async (request) => {
      // A duplicated OAuth parameter is not a request to interpret. Which copy a server
      // picks is the whole of parameter-pollution, and the answer is to pick neither.
      if (hasDuplicateParams(request)) {
        return json(400, {
          error: 'invalid_request',
          error_description: 'En parameter förekommer flera gånger.',
        });
      }

      if (await overBudget(request, 'authorize')) {
        return json(429, { error: 'temporarily_unavailable' });
      }

      const params = queryParams(request);
      const result = await startAuthorization(params, flow);

      if (result.kind === 'redirect') return redirect(result.url);

      // Shown to the person rather than redirected, because we have just decided this
      // redirect URI is not one we will send anything to.
      return json(400, { error: result.error, error_description: result.description });
    },

    token: async (request) => {
      const form = formParams(request);
      const basic = parseBasicAuth(request);

      const presented = {
        clientId: basic?.clientId ?? form['client_id'] ?? null,
        clientSecret: basic?.clientSecret ?? form['client_secret'] ?? null,
      };

      const result = await handleTokenRequest(form, presented, {
        clients: deps.clients,
        codes: deps.codes,
        tokens: tokenService,
        people: deps.people,
        config,
        now,
        logger,
      });

      if (result.ok) return json(200, result.body);

      return json(
        result.status,
        { error: result.error, error_description: result.description },
        // RFC 6749 section 5.2: a 401 from the token endpoint carries a challenge.
        result.status === 401 ? { 'www-authenticate': 'Basic realm="photographic"' } : {},
      );
    },

    register: async (request) => {
      if (await overBudget(request, 'register')) {
        return json(429, { error: 'temporarily_unavailable' });
      }

      try {
        const result = await registerClient(jsonBody(request), {
          clients: deps.clients,
          config,
          now,
        });

        logger.info('oauth.client.registered', {
          clientId: result.record.clientId,
          clientName: result.record.clientName,
          public: result.clientSecret === null,
        });

        return json(201, registrationResponse(result));
      } catch (error) {
        return json(400, {
          error: 'invalid_client_metadata',
          error_description: error instanceof Error ? error.message : 'invalid registration',
        });
      }
    },

    revoke: async (request) => {
      const form = formParams(request);
      const basic = parseBasicAuth(request);
      const clientId = basic?.clientId ?? form['client_id'];
      const token = form['token'];

      // RFC 7009 section 2.2: an unknown token is a success. The caller wanted it gone and
      // it is gone; saying "no such token" only confirms which tokens exist.
      if (!clientId || !token) return json(200, {});

      await tokenService.revokeRawToken({
        token,
        clientId,
        tokenTypeHint: form['token_type_hint'],
      });

      return json(200, {});
    },

    describeRequest: async (request) => {
      const requestId = queryParams(request)['auth_request'];
      if (!requestId) {
        return json(400, { error: 'invalid_request', error_description: 'auth_request saknas.' });
      }

      const view = await describeAuthorization(requestId, { pending: deps.pending, now });
      if (!view) {
        return json(404, {
          error: 'invalid_request',
          error_description: 'Förfrågan finns inte eller har gått ut. Börja om från din AI-klient.',
        });
      }

      return json(200, {
        requestId: view.requestId,
        clientName: view.clientName,
        scopes: view.scopes,
        expiresAt: view.expiresAt.toISOString(),
      });
    },

    approve: async (request) => {
      const body = jsonBody(request);
      const requestId = typeof body['requestId'] === 'string' ? body['requestId'] : '';
      const approved = body['approved'] !== false;

      const header = request.headers['authorization'];
      const sessionToken = header?.replace(/^Bearer\s+/i, '').trim() ?? '';

      if (!requestId || !sessionToken) {
        return json(400, {
          error: 'invalid_request',
          error_description: 'requestId och inloggning krävs.',
        });
      }

      const result = await approveAuthorization({ requestId, sessionToken, approved }, flow);

      if (!result.ok) {
        return json(result.error === 'access_denied' ? 401 : 400, {
          error: result.error,
          error_description: result.description,
        });
      }

      // The redirect is returned rather than performed: the login page is a single-page
      // app holding the session token in memory, so it has to do the navigation itself.
      return json(200, { redirectUrl: result.redirectUrl, approved });
    },

    authorizationServerMetadata: () => cacheableJson(authorizationServerMetadata(config)),
    protectedResourceMetadata: () => cacheableJson(protectedResourceMetadata(config)),
  };
}
