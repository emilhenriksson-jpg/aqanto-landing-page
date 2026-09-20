/**
 * OAuth state in Postgres.
 *
 * `@photographic/auth/testing`'s in-memory stores are the reference these have to match,
 * and the thing they have to match is not the happy path — it is the atomicity. Both
 * `consume` methods are the difference between an authorization code that can be
 * redeemed once and one that can be redeemed twice under concurrency, which is exactly
 * what an intercepted redirect races for. In the memory stores single-threaded
 * JavaScript makes that free. Here it has to be one statement with a `WHERE ... IS NULL`
 * and a row count, and a read-then-write would be a security bug that passes every test
 * that does not run two requests at once.
 *
 * Why this is worth moving off the memory stores at all: tokens and registrations in
 * process memory vanish on restart, so every revocation is temporary until the next
 * deploy, and per-client permissions are a fiction. That makes this a prerequisite for
 * anything that claims a person can disconnect an AI from their memory.
 */

import type {
  AuthCodeStore,
  AuthorizationCodeRecord,
  NewAuthorizationCode,
  NewOAuthClient,
  NewPendingAuthorization,
  NewToken,
  OAuthClientRecord,
  OAuthClientStore,
  OAuthTokenRecord,
  PendingAuthorizationRecord,
  PendingAuthorizationStore,
  RegisteredVia,
  TokenEndpointAuthMethod,
  TokenStore,
} from '@photographic/auth';
import type { AgentClient, PersonId, RoomId } from '@photographic/core';
import type { Pool } from 'pg';

import { execute, queryOne, queryRows } from '../pool.js';

// ---------------------------------------------------------------------------
// Clients
// ---------------------------------------------------------------------------

interface ClientRow {
  client_id: string;
  client_secret_hash: string | null;
  client_name: string;
  redirect_uris: string[];
  grant_types: string[];
  token_endpoint_auth: string;
  registered_via: string;
  cimd_url: string | null;
  client_label: string;
  agent_client: string;
  label_source: string;
  created_at: Date;
}

const CLIENT_COLUMNS = `client_id, client_secret_hash, client_name, redirect_uris, grant_types,
                        token_endpoint_auth, registered_via, cimd_url, client_label, agent_client,
                        label_source, created_at`;

function toClient(row: ClientRow): OAuthClientRecord {
  return {
    clientId: row.client_id,
    clientSecretHash: row.client_secret_hash,
    clientName: row.client_name,
    redirectUris: row.redirect_uris,
    grantTypes: row.grant_types,
    tokenEndpointAuth: row.token_endpoint_auth as TokenEndpointAuthMethod,
    registeredVia: row.registered_via as RegisteredVia,
    cimdUrl: row.cimd_url,
    clientLabel: row.client_label,
    agentClient: row.agent_client as AgentClient,
    labelSource: row.label_source as OAuthClientRecord['labelSource'],
    createdAt: row.created_at,
  };
}

export class PgOAuthClientStore implements OAuthClientStore {
  constructor(private readonly pool: Pool) {}

  async findByClientId(clientId: string): Promise<OAuthClientRecord | null> {
    const row = await queryOne<ClientRow>(
      this.pool,
      `SELECT ${CLIENT_COLUMNS} FROM app.oauth_client WHERE client_id = $1`,
      [clientId],
    );
    return row ? toClient(row) : null;
  }

  async create(input: NewOAuthClient): Promise<OAuthClientRecord> {
    const row = await queryOne<ClientRow>(
      this.pool,
      `INSERT INTO app.oauth_client
         (client_id, client_secret_hash, client_name, redirect_uris, grant_types,
          token_endpoint_auth, registered_via, cimd_url, client_label, agent_client, label_source)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       RETURNING ${CLIENT_COLUMNS}`,
      [
        input.clientId,
        input.clientSecretHash,
        input.clientName,
        input.redirectUris,
        input.grantTypes,
        input.tokenEndpointAuth,
        input.registeredVia,
        input.cimdUrl,
        input.clientLabel,
        input.agentClient,
        input.labelSource,
      ],
    );
    return toClient(row!);
  }
}

// ---------------------------------------------------------------------------
// Authorization codes
// ---------------------------------------------------------------------------

interface CodeRow {
  code_hash: string;
  client_id: string;
  person_id: string;
  redirect_uri: string;
  code_challenge: string;
  code_challenge_method: string;
  scope: string;
  expires_at: Date;
  consumed_at: Date | null;
  created_at: Date;
}

export class PgAuthCodeStore implements AuthCodeStore {
  constructor(private readonly pool: Pool) {}

  async create(input: NewAuthorizationCode): Promise<void> {
    await execute(
      this.pool,
      `INSERT INTO app.oauth_authorization
         (code_hash, client_id, person_id, redirect_uri, code_challenge,
          code_challenge_method, scope, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        input.codeHash,
        input.clientId,
        input.personId,
        input.redirectUri,
        input.codeChallenge,
        input.codeChallengeMethod,
        input.scope,
        input.expiresAt,
      ],
    );
  }

  /** Returns consumed and expired rows too: replay detection has to be able to see them. */
  async findByHash(codeHash: string): Promise<AuthorizationCodeRecord | null> {
    const row = await queryOne<CodeRow>(
      this.pool,
      `SELECT code_hash, client_id, person_id, redirect_uri, code_challenge,
              code_challenge_method, scope, expires_at, consumed_at, created_at
       FROM app.oauth_authorization WHERE code_hash = $1`,
      [codeHash],
    );
    if (!row) return null;

    return {
      codeHash: row.code_hash,
      clientId: row.client_id,
      personId: row.person_id as PersonId,
      redirectUri: row.redirect_uri,
      codeChallenge: row.code_challenge,
      codeChallengeMethod: row.code_challenge_method as 'S256',
      scope: row.scope,
      expiresAt: row.expires_at,
      consumedAt: row.consumed_at,
      createdAt: row.created_at,
    };
  }

  /**
   * One statement. The `WHERE consumed_at IS NULL` is the security property: two
   * requests redeeming the same code race on this update and exactly one of them gets a
   * row count of 1.
   */
  async consume(codeHash: string, at: Date): Promise<boolean> {
    const updated = await execute(
      this.pool,
      `UPDATE app.oauth_authorization SET consumed_at = $2
       WHERE code_hash = $1 AND consumed_at IS NULL`,
      [codeHash, at],
    );
    return updated === 1;
  }
}

// ---------------------------------------------------------------------------
// Pending authorizations
// ---------------------------------------------------------------------------

interface PendingRow {
  id: string;
  client_id: string;
  client_name: string;
  redirect_uri: string;
  code_challenge: string;
  scope: string;
  state: string | null;
  resource: string | null;
  expires_at: Date;
  consumed_at: Date | null;
  created_at: Date;
}

const PENDING_COLUMNS = `id, client_id, client_name, redirect_uri, code_challenge, scope,
                         state, resource, expires_at, consumed_at, created_at`;

function toPending(row: PendingRow): PendingAuthorizationRecord {
  return {
    id: row.id,
    clientId: row.client_id,
    clientName: row.client_name,
    redirectUri: row.redirect_uri,
    codeChallenge: row.code_challenge,
    scope: row.scope,
    state: row.state,
    resource: row.resource,
    expiresAt: row.expires_at,
    consumedAt: row.consumed_at,
    createdAt: row.created_at,
  };
}

export class PgPendingAuthorizationStore implements PendingAuthorizationStore {
  constructor(private readonly pool: Pool) {}

  async create(input: NewPendingAuthorization): Promise<PendingAuthorizationRecord> {
    const row = await queryOne<PendingRow>(
      this.pool,
      `INSERT INTO app.oauth_pending_authorization
         (id, client_id, client_name, redirect_uri, code_challenge, scope, state, resource, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING ${PENDING_COLUMNS}`,
      [
        input.id,
        input.clientId,
        input.clientName,
        input.redirectUri,
        input.codeChallenge,
        input.scope,
        input.state,
        input.resource,
        input.expiresAt,
      ],
    );
    return toPending(row!);
  }

  async find(id: string): Promise<PendingAuthorizationRecord | null> {
    const row = await queryOne<PendingRow>(
      this.pool,
      `SELECT ${PENDING_COLUMNS} FROM app.oauth_pending_authorization WHERE id = $1`,
      [id],
    );
    return row ? toPending(row) : null;
  }

  /** Single statement, like the code store: approving twice is one code, not two. */
  async consume(id: string, at: Date): Promise<boolean> {
    const updated = await execute(
      this.pool,
      `UPDATE app.oauth_pending_authorization SET consumed_at = $2
       WHERE id = $1 AND consumed_at IS NULL`,
      [id, at],
    );
    return updated === 1;
  }
}

// ---------------------------------------------------------------------------
// Tokens
// ---------------------------------------------------------------------------

interface TokenRow {
  id: string;
  token_hash: string;
  refresh_hash: string | null;
  client_id: string;
  person_id: string;
  scope: string;
  room_scope: string[];
  expires_at: Date;
  revoked_at: Date | null;
  last_used_at: Date | null;
  created_at: Date;
}

const TOKEN_COLUMNS = `id, token_hash, refresh_hash, client_id, person_id, scope, room_scope,
                       expires_at, revoked_at, last_used_at, created_at`;

function toToken(row: TokenRow): OAuthTokenRecord {
  return {
    id: row.id,
    tokenHash: row.token_hash,
    refreshHash: row.refresh_hash,
    clientId: row.client_id,
    personId: row.person_id as PersonId,
    scope: row.scope,
    roomScope: row.room_scope as RoomId[],
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at,
    lastUsedAt: row.last_used_at,
    createdAt: row.created_at,
  };
}

export class PgTokenStore implements TokenStore {
  constructor(private readonly pool: Pool) {}

  async create(input: NewToken): Promise<OAuthTokenRecord> {
    const row = await queryOne<TokenRow>(
      this.pool,
      `INSERT INTO app.oauth_token
         (token_hash, refresh_hash, client_id, person_id, scope, room_scope, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6::uuid[], $7)
       RETURNING ${TOKEN_COLUMNS}`,
      [
        input.tokenHash,
        input.refreshHash,
        input.clientId,
        input.personId,
        input.scope,
        input.roomScope,
        input.expiresAt,
      ],
    );
    return toToken(row!);
  }

  async findByAccessHash(tokenHash: string): Promise<OAuthTokenRecord | null> {
    const row = await queryOne<TokenRow>(
      this.pool,
      `SELECT ${TOKEN_COLUMNS} FROM app.oauth_token WHERE token_hash = $1`,
      [tokenHash],
    );
    return row ? toToken(row) : null;
  }

  /**
   * Must return revoked rows as well. A rotated refresh token *is* a revoked row, and
   * recognising it is the whole of reuse detection — filtering them out here would turn
   * a stolen-token signal into "invalid refresh token" and lose the family revocation.
   */
  async findByRefreshHash(refreshHash: string): Promise<OAuthTokenRecord | null> {
    const row = await queryOne<TokenRow>(
      this.pool,
      `SELECT ${TOKEN_COLUMNS} FROM app.oauth_token WHERE refresh_hash = $1`,
      [refreshHash],
    );
    return row ? toToken(row) : null;
  }

  async revoke(id: string, at: Date): Promise<void> {
    await execute(
      this.pool,
      `UPDATE app.oauth_token SET revoked_at = $2 WHERE id = $1 AND revoked_at IS NULL`,
      [id, at],
    );
  }

  /**
   * A family is one client's chain of rotations for one person, since the frozen schema
   * has no family column. Used by reuse detection, by authorization-code replay, and by
   * a person clicking "koppla bort" on one client.
   */
  async revokeFamily(
    family: { clientId: string; personId: PersonId },
    at: Date,
  ): Promise<number> {
    return execute(
      this.pool,
      `UPDATE app.oauth_token SET revoked_at = $3
       WHERE client_id = $1 AND person_id = $2 AND revoked_at IS NULL`,
      [family.clientId, family.personId, at],
    );
  }

  async touch(id: string, at: Date): Promise<void> {
    await execute(this.pool, `UPDATE app.oauth_token SET last_used_at = $2 WHERE id = $1`, [
      id,
      at,
    ]);
  }

  /**
   * Revokes every live token a person holds, across every client.
   *
   * Not part of `TokenStore`: this is the account-deletion and "lock me out now" path,
   * where the point is that the account stops being reachable in the same second rather
   * than that one client was disconnected.
   */
  async revokeAllForPerson(personId: PersonId, at: Date): Promise<number> {
    return execute(
      this.pool,
      `UPDATE app.oauth_token SET revoked_at = $2
       WHERE person_id = $1 AND revoked_at IS NULL`,
      [personId, at],
    );
  }

  /** Expired and long-revoked rows, swept by a job. Hashes are not worth keeping forever. */
  async deleteExpiredBefore(cutoff: Date): Promise<number> {
    return execute(
      this.pool,
      `DELETE FROM app.oauth_token
       WHERE expires_at < $1 AND (revoked_at IS NULL OR revoked_at < $1)`,
      [cutoff],
    );
  }
}

// ---------------------------------------------------------------------------
// Grants: the Klienter screen
// ---------------------------------------------------------------------------

export interface ClientGrantRow {
  clientId: string;
  chatgptPluginId: string | null;
  /** The person's own name for it, when they have set one. */
  displayName: string | null;
  /** The frozen label, derived at registration. */
  clientLabel: string;
  agentClient: AgentClient;
  scope: string;
  firstSeenAt: Date;
  lastSeenAt: Date;
  revokedAt: Date | null;
  /** Writes counted today, for the budget the screen shows. */
  writesToday: number;
}

/**
 * Per person per client, which is what a person means by "a client".
 *
 * Keyed on both because a per-install client like Claude Desktop registers once per
 * machine while a hosted client is one registration for everybody. One table is correct
 * in both cases, and a rename or a revocation by one person can never reach another
 * person's view of the same registration — which it would if `display_name` lived on
 * `oauth_client`.
 */
export class PgClientGrants {
  constructor(private readonly pool: Pool) {}

  /** Called when a token is issued. Upserts, because a re-authorization is not a new client. */
  async record(input: { personId: PersonId; clientId: string; scope: string }): Promise<void> {
    await execute(
      this.pool,
      `INSERT INTO app.client_grant (person_id, client_id, scope)
       VALUES ($1, $2, $3)
       ON CONFLICT (person_id, client_id) DO UPDATE
         SET scope = $3,
             last_seen_at = now(),
             -- Authorizing again is how a person undoes a revocation. Anything else
             -- would leave a client they just re-approved silently disconnected.
             revoked_at = NULL`,
      [input.personId, input.clientId, input.scope],
    );
  }

  async list(personId: PersonId): Promise<ClientGrantRow[]> {
    const rows = await queryRows<{
      client_id: string;
      chatgpt_plugin_id: string | null;
      display_name: string | null;
      client_label: string;
      agent_client: string;
      scope: string;
      first_seen_at: Date;
      last_seen_at: Date;
      revoked_at: Date | null;
      writes_today: string | number | null;
    }>(
      this.pool,
      `SELECT g.client_id,
              g.chatgpt_plugin_id,
              g.display_name,
              c.client_label,
              c.agent_client,
              g.scope,
              g.first_seen_at,
              g.last_seen_at,
              g.revoked_at,
              coalesce(w.writes, 0) AS writes_today
       FROM app.client_grant g
       JOIN app.oauth_client c ON c.client_id = g.client_id
       LEFT JOIN app.client_write_counter w
         ON w.person_id = g.person_id
        AND w.client_id = g.client_id
        AND w.day = (now() AT TIME ZONE 'UTC')::date
       WHERE g.person_id = $1
       ORDER BY g.last_seen_at DESC`,
      [personId],
    );

    return rows.map((row) => ({
      clientId: row.client_id,
      chatgptPluginId: row.chatgpt_plugin_id,
      displayName: row.display_name,
      clientLabel: row.client_label,
      agentClient: row.agent_client as AgentClient,
      scope: row.scope,
      firstSeenAt: row.first_seen_at,
      lastSeenAt: row.last_seen_at,
      revokedAt: row.revoked_at,
      writesToday: Number(row.writes_today ?? 0),
    }));
  }

  /**
   * The person's own name for a client. `null` hands it back to the frozen label.
   *
   * Scoped to the grant, never to `oauth_client`: the label there is immutable by
   * trigger precisely so that renaming is a thing a person does and not a thing a client
   * can do to itself.
   */
  async rename(input: {
    personId: PersonId;
    clientId: string;
    displayName: string | null;
  }): Promise<boolean> {
    const updated = await execute(
      this.pool,
      `UPDATE app.client_grant SET display_name = $3
       WHERE person_id = $1 AND client_id = $2`,
      [input.personId, input.clientId, input.displayName],
    );
    return updated === 1;
  }

  /** First-party launch preference, isolated by both person and active provider grant. */
  async setChatgptPlugin(input: { personId: PersonId; clientId: string; pluginId: string }): Promise<boolean> {
    const updated = await execute(this.pool,
      `UPDATE app.client_grant g SET chatgpt_plugin_id = $3
       FROM app.oauth_client c
       WHERE g.person_id = $1 AND g.client_id = $2 AND g.revoked_at IS NULL
         AND c.client_id = g.client_id AND c.agent_client = 'chatgpt-web'`,
      [input.personId, input.clientId, input.pluginId]);
    return updated === 1;
  }

  /** Marks the grant revoked. The caller revokes the tokens; this is what makes it stick. */
  async revoke(input: { personId: PersonId; clientId: string }): Promise<boolean> {
    const updated = await execute(
      this.pool,
      `UPDATE app.client_grant SET revoked_at = now()
       WHERE person_id = $1 AND client_id = $2 AND revoked_at IS NULL`,
      [input.personId, input.clientId],
    );
    return updated === 1;
  }

  async isRevoked(input: { personId: PersonId; clientId: string }): Promise<boolean> {
    const row = await queryOne<{ revoked: boolean }>(
      this.pool,
      `SELECT revoked_at IS NOT NULL AS revoked FROM app.client_grant
       WHERE person_id = $1 AND client_id = $2`,
      [input.personId, input.clientId],
    );
    return row?.revoked ?? false;
  }

  /**
   * Counts a write against the client's daily budget and says whether it fit.
   *
   * Counts first, then reports. A client that suddenly writes a thousand memories is
   * either broken or taken over, and the budget bounds the damage between that starting
   * and the person noticing — it is not what stops a single injected memory, which is
   * the approval queue's job.
   */
  async recordWrite(input: {
    personId: PersonId;
    clientId: string;
    limit: number;
  }): Promise<{ allowed: boolean; writes: number }> {
    const row = await queryOne<{ allowed: boolean; counted_writes: number }>(
      this.pool,
      `SELECT allowed, counted_writes FROM app.record_client_write($1, $2, $3)`,
      [input.personId, input.clientId, input.limit],
    );
    return { allowed: row?.allowed ?? true, writes: Number(row?.counted_writes ?? 0) };
  }
}
