/**
 * In-memory doubles so this package's suite runs with no database, no network and no
 * clock of its own.
 */

import type {
  Actor,
  AgentClient,
  ClientSession,
  DeliveryMethod,
  InvitePort,
  IdentityPort,
  MemberRole,
  Person,
  PersonId,
  Room,
  RoomId,
  SessionId,
  SessionPort,
  Transport,
} from '@photographic/core';
import { AuthError, NotFoundError } from '@photographic/core';

import type { CodeSender, CodeStore, ConnectDeps, PendingCode, SessionIssuer, SignupChannel } from '../deps.js';

export class MemoryCodeStore implements CodeStore {
  private readonly rows = new Map<string, PendingCode>();
  /** Every insert ever, so rate-limit windows can be asserted. */
  readonly history: PendingCode[] = [];

  async insert(record: PendingCode): Promise<void> {
    this.rows.set(record.id, { ...record });
    this.history.push({ ...record });
  }

  async findById(id: string): Promise<PendingCode | null> {
    const row = this.rows.get(id);
    return row ? { ...row } : null;
  }

  async recordAttempt(id: string): Promise<void> {
    const row = this.rows.get(id);
    if (row) row.attempts += 1;
  }

  async consume(id: string, at: Date): Promise<boolean> {
    const row = this.rows.get(id);
    if (!row || row.consumedAt) return false;
    row.consumedAt = at;
    return true;
  }

  async countSince(destination: string, since: Date): Promise<number> {
    return this.history.filter((r) => r.destination === destination && r.createdAt >= since).length;
  }

  async discard(id: string): Promise<void> {
    this.rows.delete(id);
    // Out of `history` too, which is what `countSince` reads — leaving it there is the
    // whole bug this exists to prevent.
    const at = this.history.findIndex((r) => r.id === id);
    if (at !== -1) this.history.splice(at, 1);
  }

  /** Test-only: the raw codes never live in the store, so the sender records them. */
  raw(id: string): PendingCode | undefined {
    return this.rows.get(id);
  }
}

export class MemoryCodeSender implements CodeSender {
  readonly sent: Array<{ channel: SignupChannel; destination: string; code: string }> = [];

  async send(input: { channel: SignupChannel; destination: string; code: string }): Promise<void> {
    this.sent.push({ ...input });
  }

  get lastCode(): string | undefined {
    return this.sent.at(-1)?.code;
  }
}

export class MemorySessionIssuer implements SessionIssuer {
  private counter = 0;

  async issue(input: { personId: string }): Promise<{ token: string; expiresAt: Date }> {
    this.counter += 1;
    return {
      token: `session-${input.personId}-${this.counter}`,
      expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
    };
  }
}

export class MemoryIdentity implements IdentityPort {
  private readonly people = new Map<string, Person>();
  private readonly personalRooms = new Map<string, Room>();
  private counter = 0;

  async register(input: {
    email?: string;
    phone?: string;
    displayName?: string;
    locale?: string;
  }): Promise<{ person: Person; personalRoom: Room }> {
    this.counter += 1;
    const id = `person-${this.counter}` as PersonId;
    const person: Person = {
      id,
      handle: null,
      displayName: input.displayName ?? null,
      email: input.email ?? null,
      phone: input.phone ?? null,
      locale: input.locale ?? 'sv-SE',
      createdAt: new Date(),
    };
    const personalRoom: Room = {
      id: `room-personal-${this.counter}` as RoomId,
      kind: 'personal',
      slug: `personal-${this.counter}`,
      title: input.displayName ?? 'Mitt rum',
      description: null,
      sensitivity: 'normal',
      createdBy: id,
      createdAt: new Date(),
      archivedAt: null,
    };
    this.people.set(id, person);
    this.personalRooms.set(id, personalRoom);
    return { person, personalRoom };
  }

  async findById(id: PersonId): Promise<Person | null> {
    return this.people.get(id) ?? null;
  }

  async findByEmail(email: string): Promise<Person | null> {
    return [...this.people.values()].find((p) => p.email === email) ?? null;
  }

  async findByPhone(phone: string): Promise<Person | null> {
    return [...this.people.values()].find((p) => p.phone === phone) ?? null;
  }

  async personalRoomOf(id: PersonId): Promise<Room> {
    const room = this.personalRooms.get(id);
    if (!room) throw new NotFoundError('no personal room');
    return room;
  }

  /**
   * Test-only: undoes a `register()`, for a `registerWithInvite` double that needs to
   * roll one back when the invite acceptance that was meant to follow it fails. Not part
   * of `IdentityPort` — nothing in production calls this directly, because the Postgres
   * composition root gets its atomicity from a real transaction instead. See
   * `signup.test.ts`.
   */
  forget(id: PersonId): void {
    this.people.delete(id);
    this.personalRooms.delete(id);
  }
}

export class MemoryInvites implements InvitePort {
  readonly accepted: Array<{ token: string; personId: PersonId }> = [];
  private readonly rooms = new Map<string, Room>();

  /** Test setup: register a token that `accept` will honour. */
  seed(token: string, room: Room): void {
    this.rooms.set(token, room);
  }

  async create(): Promise<never> {
    throw new Error('not used in connect tests');
  }

  async peek(): Promise<null> {
    return null;
  }

  async accept(token: string, personId: PersonId): Promise<{ room: Room; role: MemberRole }> {
    const room = this.rooms.get(token);
    if (!room) throw new AuthError('invalid invite');
    this.accepted.push({ token, personId });
    return { room, role: 'editor' };
  }

  async revoke(): Promise<void> {
    // no-op
  }

  async listForRoom(): Promise<never[]> {
    return [];
  }

  async expireOverdue(): Promise<number> {
    return 0;
  }
}

export class MemorySessions implements SessionPort {
  private readonly rows: ClientSession[] = [];
  private counter = 0;

  async start(input: {
    personId: PersonId;
    agentClient: AgentClient;
    transport: Transport;
  }): Promise<ClientSession> {
    this.counter += 1;
    const session: ClientSession = {
      id: `session-${this.counter}` as SessionId,
      personId: input.personId,
      agentClient: input.agentClient,
      transport: input.transport,
      startedAt: new Date(),
      profileDelivered: false,
      profileVersion: null,
      deliveryMethod: null,
    };
    this.rows.push(session);
    return session;
  }

  async recordDelivery(
    sessionId: SessionId,
    method: DeliveryMethod,
    profileVersion: number,
  ): Promise<void> {
    const row = this.rows.find((r) => r.id === sessionId);
    if (!row) throw new NotFoundError('no session');
    row.profileDelivered = true;
    row.deliveryMethod = method;
    row.profileVersion = profileVersion;
  }

  async health(actor: Actor): Promise<
    Array<{
      agentClient: AgentClient;
      lastSeenAt: Date;
      profileDelivered: boolean;
      deliveryMethod: DeliveryMethod | null;
    }>
  > {
    const latest = new Map<AgentClient, ClientSession>();
    for (const row of this.rows) {
      if (row.personId !== actor.personId) continue;
      const seen = latest.get(row.agentClient);
      if (!seen || row.startedAt >= seen.startedAt) latest.set(row.agentClient, row);
    }
    return [...latest.values()].map((row) => ({
      agentClient: row.agentClient,
      lastSeenAt: row.startedAt,
      profileDelivered: row.profileDelivered,
      deliveryMethod: row.deliveryMethod,
    }));
  }

  /** Test helper: simulate a client connecting and receiving the profile. */
  async simulateDelivery(input: {
    personId: PersonId;
    agentClient: AgentClient;
    transport?: Transport;
    method: DeliveryMethod;
    at: Date;
  }): Promise<ClientSession> {
    this.counter += 1;
    const session: ClientSession = {
      id: `session-${this.counter}` as SessionId,
      personId: input.personId,
      agentClient: input.agentClient,
      transport: input.transport ?? 'mcp',
      startedAt: input.at,
      profileDelivered: true,
      profileVersion: 1,
      deliveryMethod: input.method,
    };
    this.rows.push(session);
    return session;
  }
}

export interface TestHarness {
  deps: ConnectDeps;
  identity: MemoryIdentity;
  invites: MemoryInvites;
  sessions: MemorySessions;
  codes: MemoryCodeStore;
  sender: MemoryCodeSender;
  setNow(date: Date): void;
  now(): Date;
}

export function createHarness(options: { fixedCode?: string } = {}): TestHarness {
  const identity = new MemoryIdentity();
  const invites = new MemoryInvites();
  const sessions = new MemorySessions();
  const codes = new MemoryCodeStore();
  const sender = new MemoryCodeSender();
  const issuer = new MemorySessionIssuer();

  let current = new Date('2026-09-15T08:00:00.000Z');
  let ids = 0;
  let codeSeq = 0;

  const deps: ConnectDeps = {
    identity,
    invites,
    sessions,
    codes,
    sender,
    issuer,
    codeSecret: 'test-secret',
    clock: () => current,
    randomCode: () => {
      if (options.fixedCode) return options.fixedCode;
      codeSeq += 1;
      return String(100000 + codeSeq);
    },
    randomId: () => {
      ids += 1;
      return `req-${ids}`;
    },
  };

  return {
    deps,
    identity,
    invites,
    sessions,
    codes,
    sender,
    setNow: (date: Date) => {
      current = date;
    },
    now: () => current,
  };
}
