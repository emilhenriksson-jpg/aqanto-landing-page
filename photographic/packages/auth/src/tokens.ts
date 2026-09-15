/**
 * Token issuance, verification, rotation and revocation.
 *
 * Tokens are opaque high-entropy strings, not JWTs. That is a deliberate trade: a JWT
 * would save a database read per request, but it cannot be revoked before it expires,
 * and "remove this model's access to my memory, now" has to be instant to be honest.
 *
 * Only SHA-256 hashes are stored. A dump of `app.oauth_token` is not a set of bearer
 * credentials.
 */

import { AuthError } from '@photographic/core';
import type { PersonId, RoomId } from '@photographic/core';

import type { AuthServerConfig } from './config.js';
import { constantTimeEqual, fingerprint, randomToken, sha256Hex } from './crypto.js';
import type { AuthLogger, Clock, OAuthTokenRecord, TokenStore } from './deps.js';
import { silentLogger } from './deps.js';
import { hasScope, narrowScope, roomScopeOf, SCOPE_OFFLINE_ACCESS } from './scopes.js';

export const ACCESS_TOKEN_PREFIX = 'pgm_at_';
export const REFRESH_TOKEN_PREFIX = 'pgm_rt_';
export const AUTH_CODE_PREFIX = 'pgm_ac_';

/** 32 bytes of CSPRNG output, base64url. Prefixed so leaked strings are recognisable. */
export function newAccessToken(): string {
  return ACCESS_TOKEN_PREFIX + randomToken(32);
}

export function newRefreshToken(): string {
  return REFRESH_TOKEN_PREFIX + randomToken(32);
}

export function newAuthorizationCode(): string {
  return AUTH_CODE_PREFIX + randomToken(32);
}

/** The stored form of any credential in this package. */
export function hashSecret(raw: string): string {
  return sha256Hex(raw);
}

/** The only form of a credential that may be logged. */
export const tokenFingerprint = fingerprint;

export interface IssuedTokens {
  /** Raw access token. Returned to the client exactly once and never stored. */
  accessToken: string;
  /** Raw refresh token, or null when `offline_access` was not granted. */
  refreshToken: string | null;
  expiresInSeconds: number;
  scope: string;
  record: OAuthTokenRecord;
}

export interface TokenServiceOptions {
  tokens: TokenStore;
  config: AuthServerConfig;
  now?: Clock;
  logger?: AuthLogger;
}

export class TokenService {
  private readonly tokens: TokenStore;
  private readonly config: AuthServerConfig;
  private readonly now: Clock;
  private readonly logger: AuthLogger;

  constructor(options: TokenServiceOptions) {
    this.tokens = options.tokens;
    this.config = options.config;
    this.now = options.now ?? (() => new Date());
    this.logger = options.logger ?? silentLogger;
  }

  async issue(input: {
    clientId: string;
    personId: PersonId;
    scope: string;
    /**
     * Explicit room narrowing. Defaults to the `room:` selectors in `scope`; an empty
     * array means "all rooms the person belongs to", resolved per request.
     */
    roomScope?: RoomId[];
  }): Promise<IssuedTokens> {
    const issuedAt = this.now();
    const accessToken = newAccessToken();
    const withRefresh = hasScope(input.scope, SCOPE_OFFLINE_ACCESS);
    const refreshToken = withRefresh ? newRefreshToken() : null;

    const record = await this.tokens.create({
      tokenHash: hashSecret(accessToken),
      refreshHash: refreshToken === null ? null : hashSecret(refreshToken),
      clientId: input.clientId,
      personId: input.personId,
      scope: input.scope,
      roomScope: input.roomScope ?? roomScopeOf(input.scope),
      expiresAt: new Date(issuedAt.getTime() + this.config.accessTokenTtlSeconds * 1000),
    });

    this.logger.info('oauth.token.issued', {
      clientId: input.clientId,
      personId: input.personId,
      tokenId: record.id,
      accessTokenFingerprint: tokenFingerprint(accessToken),
      scope: input.scope,
    });

    return {
      accessToken,
      refreshToken,
      expiresInSeconds: this.config.accessTokenTtlSeconds,
      scope: record.scope,
      record,
    };
  }

  /**
   * Resolves a raw access token to its row, rejecting unknown, revoked and expired ones.
   * Throws `AuthError` so adapters render 401 with no detail about which case it was.
   */
  async verifyAccessToken(raw: string): Promise<OAuthTokenRecord> {
    if (raw.trim() === '') throw new AuthError('missing token');
    const record = await this.tokens.findByAccessHash(hashSecret(raw));
    if (record === null) {
      this.logger.warn('oauth.token.unknown', { accessTokenFingerprint: tokenFingerprint(raw) });
      throw new AuthError('unknown token');
    }
    if (record.revokedAt !== null) {
      this.logger.warn('oauth.token.revoked_use', { tokenId: record.id });
      throw new AuthError('token revoked');
    }
    const now = this.now();
    if (record.expiresAt.getTime() <= now.getTime()) {
      throw new AuthError('token expired');
    }
    await this.tokens.touch(record.id, now);
    return record;
  }

  /**
   * Refresh token grant with rotation.
   *
   * A refresh token is single-use: rotating it revokes the row it belonged to. Presenting
   * an already-rotated (therefore revoked) refresh token means either a replay or a stolen
   * token, and there is no way to tell which -- so the whole family is revoked and the
   * person's clients have to re-authorize. That is the RFC 6819 answer and it is the only
   * safe one.
   */
  async rotateRefreshToken(input: {
    clientId: string;
    refreshToken: string;
    requestedScope?: string | undefined;
  }): Promise<IssuedTokens> {
    const refreshHash = hashSecret(input.refreshToken);
    const record = await this.tokens.findByRefreshHash(refreshHash);
    if (record === null) {
      this.logger.warn('oauth.refresh.unknown', {
        clientId: input.clientId,
        refreshFingerprint: tokenFingerprint(input.refreshToken),
      });
      throw new AuthError('invalid refresh token');
    }

    const now = this.now();

    // A refresh token presented by a different client than it was issued to is either a
    // confused client or a stolen credential. Treat it as theft.
    if (!constantTimeEqual(record.clientId, input.clientId)) {
      await this.tokens.revokeFamily({ clientId: record.clientId, personId: record.personId }, now);
      this.logger.warn('oauth.refresh.client_mismatch', {
        tokenId: record.id,
        expectedClientId: record.clientId,
        presentedClientId: input.clientId,
      });
      throw new AuthError('invalid refresh token');
    }

    if (record.revokedAt !== null) {
      const revoked = await this.tokens.revokeFamily(
        { clientId: record.clientId, personId: record.personId },
        now,
      );
      this.logger.warn('oauth.refresh.reuse_detected', {
        tokenId: record.id,
        personId: record.personId,
        clientId: record.clientId,
        revokedCount: revoked,
      });
      throw new AuthError('refresh token reuse detected');
    }

    const refreshExpiresAt = new Date(
      record.createdAt.getTime() + this.config.refreshTokenTtlSeconds * 1000,
    );
    if (refreshExpiresAt.getTime() <= now.getTime()) {
      await this.tokens.revoke(record.id, now);
      throw new AuthError('refresh token expired');
    }

    const narrowed = narrowScope(record.scope, input.requestedScope);
    if (!narrowed.ok) throw new AuthError(narrowed.reason);

    // Rotate: the presented row dies before the replacement is handed out, so a crash
    // between the two leaves the person needing to re-authorize rather than leaving a
    // live token nobody can see.
    await this.tokens.revoke(record.id, now);

    return this.issue({
      clientId: record.clientId,
      personId: record.personId,
      scope: narrowed.scope,
      // Narrowing the scope on refresh must narrow the rooms with it, but an empty
      // room_scope stays empty: it is resolved per request, never frozen here.
      roomScope: record.roomScope.length === 0 ? [] : intersectRooms(record.roomScope, narrowed.scope),
    });
  }

  /**
   * RFC 7009. Revokes an access or refresh token. Revoking a refresh token takes the
   * whole family with it, which is what a person clicking "koppla bort" expects.
   */
  async revokeRawToken(input: {
    token: string;
    clientId: string;
    tokenTypeHint?: string | undefined;
  }): Promise<boolean> {
    const hash = hashSecret(input.token);
    const hint = input.tokenTypeHint;
    const order: Array<'access' | 'refresh'> =
      hint === 'refresh_token' ? ['refresh', 'access'] : ['access', 'refresh'];

    for (const kind of order) {
      const record =
        kind === 'access'
          ? await this.tokens.findByAccessHash(hash)
          : await this.tokens.findByRefreshHash(hash);
      if (record === null) continue;
      // RFC 7009 section 2.1: a token that does not belong to the caller is not an error
      // to report, it is a request to ignore.
      if (!constantTimeEqual(record.clientId, input.clientId)) return false;

      const now = this.now();
      if (kind === 'refresh') {
        await this.tokens.revokeFamily({ clientId: record.clientId, personId: record.personId }, now);
      } else if (record.revokedAt === null) {
        await this.tokens.revoke(record.id, now);
      }
      this.logger.info('oauth.token.revoked', { tokenId: record.id, kind });
      return true;
    }
    return false;
  }

  /** Used by authorization-code replay handling and by "disconnect this client". */
  async revokeFamily(family: { clientId: string; personId: PersonId }): Promise<number> {
    return this.tokens.revokeFamily(family, this.now());
  }
}

function intersectRooms(current: readonly RoomId[], scope: string): RoomId[] {
  const requested = roomScopeOf(scope);
  if (requested.length === 0) return [...current];
  return requested.filter((room) => current.includes(room));
}
