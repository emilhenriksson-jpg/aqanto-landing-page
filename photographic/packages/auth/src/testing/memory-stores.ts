/**
 * In-memory stores.
 *
 * Two jobs. They let the whole authorization server run with nothing installed, which is
 * what makes a real MCP client able to complete a real OAuth flow against `pnpm dev`. And
 * they are the reference the Postgres implementation has to match, which is worth more
 * than a prose spec — the atomicity in `consume` is the security property, and here it is
 * written as code that either returns false the second time or does not.
 *
 * Everything is `Map`-backed and process-local. Restarting loses every token, which is
 * correct for development and is exactly why this is not exported from the package root.
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

import type {
  AuthorizationCodeRecord,
  AuthCodeStore,
  NewAuthorizationCode,
  NewOAuthClient,
  NewPendingAuthorization,
  NewToken,
  OAuthClientRecord,
  OAuthClientStore,
  OAuthTokenRecord,
  PendingAuthorizationRecord,
  PendingAuthorizationStore,
  PersonLookup,
  SessionHealthRow,
  SessionStore,
  TokenStore,
} from '../deps.js';

export class MemoryClientStore implements OAuthClientStore {
  readonly byId = new Map<string, OAuthClientRecord>();

  constructor(private readonly now: () => Date = () => new Date()) {}

  async findByClientId(clientId: string): Promise<OAuthClientRecord | null> {
    return this.byId.get(clientId) ?? null;
  }

  async create(input: NewOAuthClient): Promise<OAuthClientRecord> {
    const record: OAuthClientRecord = { ...input, createdAt: this.now() };
    this.byId.set(record.clientId, record);
    return record;
  }
}

export class MemoryAuthCodeStore implements AuthCodeStore {
  readonly byHash = new Map<string, AuthorizationCodeRecord>();

  constructor(private readonly now: () => Date = () => new Date()) {}

  async create(input: NewAuthorizationCode): Promise<void> {
    this.byHash.set(input.codeHash, { ...input, consumedAt: null, createdAt: this.now() });
  }

  async findByHash(codeHash: string): Promise<AuthorizationCodeRecord | null> {
    return this.byHash.get(codeHash) ?? null;
  }

  /**
   * The atomic one.
   *
   * Single-threaded JavaScript makes this trivially atomic here, and that is the point:
   * the Postgres version must be one statement with `WHERE consumed_at IS NULL`, because
   * a read-then-write across two statements is a code that can be redeemed twice under
   * concurrency — which is exactly what an intercepted redirect races for.
   */
  async consume(codeHash: string, at: Date): Promise<boolean> {
    const record = this.byHash.get(codeHash);
    if (!record || record.consumedAt !== null) return false;
    record.consumedAt = at;
    return true;
  }
}

export class MemoryPendingAuthorizationStore implements PendingAuthorizationStore {
  readonly byId = new Map<string, PendingAuthorizationRecord>();

  constructor(private readonly now: () => Date = () => new Date()) {}

  async create(input: NewPendingAuthorization): Promise<PendingAuthorizationRecord> {
    const record: PendingAuthorizationRecord = {
      ...input,
      consumedAt: null,
      createdAt: this.now(),
    };
    this.byId.set(record.id, record);
    return record;
  }

  async find(id: string): Promise<PendingAuthorizationRecord | null> {
    return this.byId.get(id) ?? null;
  }

  async consume(id: string, at: Date): Promise<boolean> {
    const record = this.byId.get(id);
    if (!record || record.consumedAt !== null) return false;
    record.consumedAt = at;
    return true;
  }
}

export class MemoryTokenStore implements TokenStore {
  readonly byId = new Map<string, OAuthTokenRecord>();
  private seq = 0;

  constructor(private readonly now: () => Date = () => new Date()) {}

  async create(input: NewToken): Promise<OAuthTokenRecord> {
    const record: OAuthTokenRecord = {
      ...input,
      id: `tok-${(this.seq += 1)}`,
      roomScope: [...input.roomScope],
      revokedAt: null,
      lastUsedAt: null,
      createdAt: this.now(),
    };
    this.byId.set(record.id, record);
    return record;
  }

  async findByAccessHash(tokenHash: string): Promise<OAuthTokenRecord | null> {
    for (const record of this.byId.values()) {
      if (record.tokenHash === tokenHash) return record;
    }
    return null;
  }

  async findByRefreshHash(refreshHash: string): Promise<OAuthTokenRecord | null> {
    for (const record of this.byId.values()) {
      if (record.refreshHash === refreshHash) return record;
    }
    return null;
  }

  async revoke(id: string, at: Date): Promise<void> {
    const record = this.byId.get(id);
    if (record && record.revokedAt === null) record.revokedAt = at;
  }

  async revokeFamily(
    family: { clientId: string; personId: PersonId },
    at: Date,
  ): Promise<number> {
    let count = 0;
    for (const record of this.byId.values()) {
      if (record.clientId !== family.clientId) continue;
      if (record.personId !== family.personId) continue;
      if (record.revokedAt !== null) continue;
      record.revokedAt = at;
      count += 1;
    }
    return count;
  }

  async touch(id: string, at: Date): Promise<void> {
    const record = this.byId.get(id);
    if (record) record.lastUsedAt = at;
  }
}

export class MemoryPersonLookup implements PersonLookup {
  readonly rooms = new Map<PersonId, RoomId[]>();

  add(personId: PersonId, rooms: RoomId[] = []): void {
    this.rooms.set(personId, rooms);
  }

  async exists(personId: PersonId): Promise<boolean> {
    return this.rooms.has(personId);
  }

  async accessibleRoomIds(personId: PersonId): Promise<RoomId[]> {
    return this.rooms.get(personId) ?? [];
  }
}

export class MemorySessionStore implements SessionStore {
  readonly sessions = new Map<SessionId, ClientSession>();
  private readonly lastSeen = new Map<SessionId, Date>();
  private seq = 0;

  constructor(private readonly now: () => Date = () => new Date()) {}

  async create(input: {
    personId: PersonId;
    agentClient: AgentClient;
    transport: Transport;
  }): Promise<ClientSession> {
    const session: ClientSession = {
      id: `ses-${(this.seq += 1)}` as SessionId,
      personId: input.personId,
      agentClient: input.agentClient,
      transport: input.transport,
      startedAt: this.now(),
      profileDelivered: false,
      profileVersion: null,
      deliveryMethod: null,
    };
    this.sessions.set(session.id, session);
    this.lastSeen.set(session.id, session.startedAt);
    return session;
  }

  async findById(sessionId: SessionId): Promise<ClientSession | null> {
    return this.sessions.get(sessionId) ?? null;
  }

  async recordDelivery(input: {
    sessionId: SessionId;
    method: DeliveryMethod;
    profileVersion: number;
    at: Date;
  }): Promise<void> {
    const session = this.sessions.get(input.sessionId);
    if (!session) return;
    session.profileDelivered = true;
    session.deliveryMethod = input.method;
    session.profileVersion = input.profileVersion;
    this.lastSeen.set(input.sessionId, input.at);
  }

  async touch(sessionId: SessionId, at: Date): Promise<void> {
    if (this.sessions.has(sessionId)) this.lastSeen.set(sessionId, at);
  }

  async latestPerClient(personId: PersonId): Promise<SessionHealthRow[]> {
    const latest = new Map<AgentClient, { session: ClientSession; seenAt: Date }>();

    for (const session of this.sessions.values()) {
      if (session.personId !== personId) continue;
      const seenAt = this.lastSeen.get(session.id) ?? session.startedAt;
      const current = latest.get(session.agentClient);
      if (!current || seenAt > current.seenAt) latest.set(session.agentClient, { session, seenAt });
    }

    return [...latest.values()]
      .sort((a, b) => b.seenAt.getTime() - a.seenAt.getTime())
      .map(({ session, seenAt }) => ({
        agentClient: session.agentClient,
        lastSeenAt: seenAt,
        profileDelivered: session.profileDelivered,
        deliveryMethod: session.deliveryMethod,
      }));
  }
}