/**
 * The narrow persistence surface this package needs.
 *
 * `@photographic/db` implements these against the frozen `app.oauth_*` and
 * `app.client_session` tables. They are declared here rather than imported so that the
 * authorization server can be built, tested and reasoned about without a database, and
 * so that the only thing db owes us is five small interfaces.
 *
 * Mapping to the frozen schema:
 *   OAuthClientStore -> app.oauth_client
 *   AuthCodeStore    -> app.oauth_authorization
 *   TokenStore       -> app.oauth_token
 *   SessionStore     -> app.client_session
 *   PersonLookup     -> app.person + app.accessible_room_ids(person_id)
 */

import type {
  AgentClient,
  ClientSession,
  DeliveryMethod,
  PersonId,
  RoomId,
  SessionId,
  Transport,
} from '@photographic/core';

/** Injected so that expiry and rotation are testable without waiting. */
export type Clock = () => Date;

export type TokenEndpointAuthMethod =
  | 'none'
  | 'client_secret_basic'
  | 'client_secret_post'
  | 'private_key_jwt';

export type RegisteredVia = 'dcr' | 'cimd' | 'manual';

export interface OAuthClientRecord {
  clientId: string;
  /** Null for public clients, which must use PKCE. Never the secret itself. */
  clientSecretHash: string | null;
  clientName: string;
  redirectUris: string[];
  grantTypes: string[];
  tokenEndpointAuth: TokenEndpointAuthMethod;
  registeredVia: RegisteredVia;
  /** Set when `clientId` is an HTTPS Client ID Metadata Document URL. */
  cimdUrl: string | null;
  createdAt: Date;
}

export interface NewOAuthClient {
  clientId: string;
  clientSecretHash: string | null;
  clientName: string;
  redirectUris: string[];
  grantTypes: string[];
  tokenEndpointAuth: TokenEndpointAuthMethod;
  registeredVia: RegisteredVia;
  cimdUrl: string | null;
}

export interface OAuthClientStore {
  findByClientId(clientId: string): Promise<OAuthClientRecord | null>;
  create(input: NewOAuthClient): Promise<OAuthClientRecord>;
}

export interface AuthorizationCodeRecord {
  codeHash: string;
  clientId: string;
  personId: PersonId;
  redirectUri: string;
  codeChallenge: string;
  codeChallengeMethod: 'S256';
  scope: string;
  expiresAt: Date;
  consumedAt: Date | null;
  createdAt: Date;
}

export interface NewAuthorizationCode {
  codeHash: string;
  clientId: string;
  personId: PersonId;
  redirectUri: string;
  codeChallenge: string;
  codeChallengeMethod: 'S256';
  scope: string;
  expiresAt: Date;
}

export interface AuthCodeStore {
  create(input: NewAuthorizationCode): Promise<void>;
  /** Returns consumed and expired rows too: replay detection needs to see them. */
  findByHash(codeHash: string): Promise<AuthorizationCodeRecord | null>;
  /**
   * Atomically marks a code consumed. Returns false when it was already consumed,
   * which is a replay and must be handled as an attack, not as a retry.
   *
   * Implementations must do this in one statement:
   *   UPDATE app.oauth_authorization SET consumed_at = $2
   *   WHERE code_hash = $1 AND consumed_at IS NULL
   */
  consume(codeHash: string, at: Date): Promise<boolean>;
}

export interface OAuthTokenRecord {
  id: string;
  tokenHash: string;
  refreshHash: string | null;
  clientId: string;
  personId: PersonId;
  scope: string;
  /**
   * Empty means "all rooms this person belongs to", resolved per request. It is never
   * expanded into the stored row: a token that cached its memberships would keep access
   * after the person left a room.
   */
  roomScope: RoomId[];
  expiresAt: Date;
  revokedAt: Date | null;
  lastUsedAt: Date | null;
  createdAt: Date;
}

export interface NewToken {
  tokenHash: string;
  refreshHash: string | null;
  clientId: string;
  personId: PersonId;
  scope: string;
  roomScope: RoomId[];
  expiresAt: Date;
}

export interface TokenStore {
  create(input: NewToken): Promise<OAuthTokenRecord>;
  findByAccessHash(tokenHash: string): Promise<OAuthTokenRecord | null>;
  /**
   * Must also return revoked rows. A refresh token that has already been rotated is a
   * revoked row, and recognising it is the whole of reuse detection.
   */
  findByRefreshHash(refreshHash: string): Promise<OAuthTokenRecord | null>;
  revoke(id: string, at: Date): Promise<void>;
  /**
   * Revokes every live token in a refresh family.
   *
   * The frozen schema has no family column, so a family is defined as
   * (client_id, person_id): one client's chain of rotations for one person. Reuse
   * detection and authorization-code replay both call this.
   */
  revokeFamily(family: { clientId: string; personId: PersonId }, at: Date): Promise<number>;
  touch(id: string, at: Date): Promise<void>;
}

export interface PersonLookup {
  exists(personId: PersonId): Promise<boolean>;
  /**
   * Current memberships, straight from `app.accessible_room_ids`. Called on every token
   * resolution for narrowed tokens; the result is never stored on the token.
   */
  accessibleRoomIds(personId: PersonId): Promise<RoomId[]>;
}

export interface SessionHealthRow {
  agentClient: AgentClient;
  lastSeenAt: Date;
  profileDelivered: boolean;
  deliveryMethod: DeliveryMethod | null;
}

export interface SessionStore {
  create(input: { personId: PersonId; agentClient: AgentClient; transport: Transport }): Promise<ClientSession>;
  findById(sessionId: SessionId): Promise<ClientSession | null>;
  recordDelivery(input: {
    sessionId: SessionId;
    method: DeliveryMethod;
    profileVersion: number;
    at: Date;
  }): Promise<void>;
  touch(sessionId: SessionId, at: Date): Promise<void>;
  /** One row per agent client, newest session wins. Drives the green/red light per client. */
  latestPerClient(personId: PersonId): Promise<SessionHealthRow[]>;
}

/**
 * Coarse abuse control for the open endpoints (DCR, CIMD fetches).
 * `take` returns false when the caller is over budget.
 */
export interface RateLimiter {
  take(key: string): Promise<boolean>;
}

/**
 * A Client ID Metadata Document fetcher (CIMD). Injected so that no test touches the
 * network and so that SSRF protection lives in one auditable place.
 */
export interface ClientMetadataFetcher {
  fetch(url: string): Promise<unknown>;
}

/**
 * Logging contract. Implementations must assume every value they receive is safe to
 * write down, because this package only ever passes fingerprints and prefixes.
 */
export interface AuthLogger {
  warn(event: string, detail?: Record<string, unknown>): void;
  info(event: string, detail?: Record<string, unknown>): void;
}

export const silentLogger: AuthLogger = {
  warn: () => {},
  info: () => {},
};
