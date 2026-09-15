/**
 * The token endpoint.
 *
 * Two grants: `authorization_code` and `refresh_token`. Rotation, reuse detection and
 * revocation all live in `TokenService`; this file is the part that decides whether a
 * presented code is genuine, and there are exactly four things it has to get right.
 *
 * The code is consumed atomically, before anything is issued. A code that can be redeemed
 * twice is two tokens from one authorization, and the second redemption is by definition
 * someone who intercepted the redirect.
 *
 * A replayed code revokes the whole family. It is indistinguishable from the legitimate
 * client retrying, and telling those apart is not possible — so the safe reading is that
 * the code leaked, and every token descended from it has to die (RFC 6819).
 *
 * The PKCE verifier is checked against the challenge recorded at authorize time, and
 * `plain` is not accepted at any point in this package.
 *
 * `redirect_uri` is compared against the one stored with the code, not against the
 * client's registered list. They can differ — a client may register several — and
 * comparing against the list would let a code issued for one be redeemed against another.
 */

import type { PersonId } from '@photographic/core';

import { authenticateClient } from './clients.js';
import type { AuthServerConfig } from './config.js';
import { verifyPkceS256 } from './crypto.js';
import type {
  AuthCodeStore,
  AuthLogger,
  Clock,
  OAuthClientStore,
  PersonLookup,
} from './deps.js';
import { silentLogger } from './deps.js';
import { hashSecret } from './tokens.js';
import type { TokenService } from './tokens.js';

export interface TokenEndpointDeps {
  clients: OAuthClientStore;
  codes: AuthCodeStore;
  tokens: TokenService;
  people: PersonLookup;
  config: AuthServerConfig;
  now?: Clock;
  logger?: AuthLogger;
}

export interface TokenRequest {
  grant_type?: string | undefined;
  code?: string | undefined;
  redirect_uri?: string | undefined;
  code_verifier?: string | undefined;
  refresh_token?: string | undefined;
  scope?: string | undefined;
  client_id?: string | undefined;
  client_secret?: string | undefined;
  resource?: string | undefined;
}

export type TokenResult =
  | {
      ok: true;
      body: {
        access_token: string;
        token_type: 'Bearer';
        expires_in: number;
        scope: string;
        refresh_token?: string;
      };
    }
  | { ok: false; status: number; error: string; description: string };

export async function handleTokenRequest(
  request: TokenRequest,
  presentedClient: { clientId: string | null; clientSecret: string | null },
  deps: TokenEndpointDeps,
): Promise<TokenResult> {
  const log = deps.logger ?? silentLogger;

  const auth = await authenticateClient(presentedClient, deps.clients);
  if (!auth.ok) {
    log.warn('oauth.token.client_rejected', {
      clientId: presentedClient.clientId,
      reason: auth.reason,
    });
    // 401 with `invalid_client`, per RFC 6749 section 5.2, and with no detail about which
    // of "unknown client" and "wrong secret" it was.
    return { ok: false, status: 401, error: 'invalid_client', description: 'Klienten avvisades.' };
  }

  const client = auth.client;

  if (!request.grant_type) {
    return badRequest('invalid_request', 'grant_type saknas.');
  }
  if (!client.grantTypes.includes(request.grant_type)) {
    return badRequest('unauthorized_client', `Klienten får inte använda ${request.grant_type}.`);
  }
  if (request.resource && trimSlash(request.resource) !== deps.config.resource) {
    return badRequest('invalid_target', 'resource matchar inte den här servern.');
  }

  if (request.grant_type === 'authorization_code') {
    return exchangeCode(request, client.clientId, deps);
  }

  if (request.grant_type === 'refresh_token') {
    if (!request.refresh_token) {
      return badRequest('invalid_request', 'refresh_token saknas.');
    }

    try {
      const issued = await deps.tokens.rotateRefreshToken({
        clientId: client.clientId,
        refreshToken: request.refresh_token,
        requestedScope: request.scope,
      });
      return success(issued);
    } catch {
      // Deliberately one answer for every failure: unknown, expired, reused, rotated by
      // another client. Distinguishing them tells an attacker holding a stolen token which
      // kind of stolen token they have.
      return badRequest('invalid_grant', 'Uppdateringstoken gäller inte.');
    }
  }

  return badRequest('unsupported_grant_type', `${request.grant_type} stöds inte.`);
}

async function exchangeCode(
  request: TokenRequest,
  clientId: string,
  deps: TokenEndpointDeps,
): Promise<TokenResult> {
  const log = deps.logger ?? silentLogger;
  const now = (deps.now ?? (() => new Date()))();

  if (!request.code) return badRequest('invalid_request', 'code saknas.');
  if (!request.code_verifier) return badRequest('invalid_request', 'code_verifier saknas.');

  const record = await deps.codes.findByHash(hashSecret(request.code));
  if (!record) {
    log.warn('oauth.code.unknown', { clientId });
    return badRequest('invalid_grant', 'Koden gäller inte.');
  }

  // A code presented by a different client than it was issued to is either a confused
  // client or an intercepted redirect. Both end here.
  if (record.clientId !== clientId) {
    log.warn('oauth.code.client_mismatch', { clientId, issuedTo: record.clientId });
    await deps.tokens.revokeFamily({ clientId: record.clientId, personId: record.personId });
    return badRequest('invalid_grant', 'Koden gäller inte.');
  }

  if (record.consumedAt !== null) {
    log.warn('oauth.code.replay', { clientId, personId: record.personId });
    await deps.tokens.revokeFamily({ clientId: record.clientId, personId: record.personId });
    return badRequest('invalid_grant', 'Koden är redan använd.');
  }

  if (record.expiresAt.getTime() <= now.getTime()) {
    return badRequest('invalid_grant', 'Koden har gått ut.');
  }

  if (!request.redirect_uri || request.redirect_uri !== record.redirectUri) {
    log.warn('oauth.code.redirect_mismatch', { clientId });
    return badRequest('invalid_grant', 'redirect_uri matchar inte koden.');
  }

  if (!verifyPkceS256(request.code_verifier, record.codeChallenge)) {
    log.warn('oauth.code.pkce_failed', { clientId, personId: record.personId });
    return badRequest('invalid_grant', 'code_verifier matchar inte.');
  }

  // Consumed before the token exists, and atomically. Two concurrent redemptions must
  // produce one token and one failure, and the order here is what decides that.
  if (!(await deps.codes.consume(record.codeHash, now))) {
    log.warn('oauth.code.race', { clientId, personId: record.personId });
    await deps.tokens.revokeFamily({ clientId: record.clientId, personId: record.personId });
    return badRequest('invalid_grant', 'Koden är redan använd.');
  }

  if (!(await deps.people.exists(record.personId as PersonId))) {
    return badRequest('invalid_grant', 'Kontot finns inte längre.');
  }

  return success(
    await deps.tokens.issue({
      clientId: record.clientId,
      personId: record.personId,
      scope: record.scope,
    }),
  );
}

function success(issued: {
  accessToken: string;
  refreshToken: string | null;
  expiresInSeconds: number;
  scope: string;
}): TokenResult {
  return {
    ok: true,
    body: {
      access_token: issued.accessToken,
      token_type: 'Bearer',
      expires_in: issued.expiresInSeconds,
      scope: issued.scope,
      ...(issued.refreshToken === null ? {} : { refresh_token: issued.refreshToken }),
    },
  };
}

function badRequest(error: string, description: string): TokenResult {
  return { ok: false, status: 400, error, description };
}

function trimSlash(value: string): string {
  return value.endsWith('/') ? value.slice(0, -1) : value;
}
