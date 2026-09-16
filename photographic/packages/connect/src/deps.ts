/**
 * The narrow surface sign-up and verification need. Deliberately smaller than
 * `Services`, so this package can be tested with in-memory doubles and no database.
 */

import type {
  IdentityPort,
  InvitePort,
  MemberRole,
  Person,
  Room,
  SessionPort,
} from '@photographic/core';

export type SignupChannel = 'email' | 'sms';

/**
 * A pending one-time code. `codeHash` is an HMAC over a server-side secret, never the
 * code itself and never a bare hash: six digits is small enough to brute force offline
 * if the table ever leaks, and the secret is what makes that not matter.
 */
export interface PendingCode {
  id: string;
  channel: SignupChannel;
  destination: string;
  codeHash: string;
  createdAt: Date;
  expiresAt: Date;
  attempts: number;
  consumedAt: Date | null;
  /** Set when the person arrived from a room invite rather than the front page. */
  inviteToken: string | null;
}

export interface CodeStore {
  insert(record: PendingCode): Promise<void>;
  findById(id: string): Promise<PendingCode | null>;
  recordAttempt(id: string): Promise<void>;
  /** Single-use: returns false if another request consumed it first. */
  consume(id: string, at: Date): Promise<boolean>;
  countSince(destination: string, since: Date): Promise<number>;
  /**
   * Forgets a record entirely, rate-limit history included.
   *
   * For one caller: a code that was stored and then could not be delivered. The row has
   * to exist before the send, or a provider that delivers while we fail to store leaves
   * a person holding a code that cannot be verified — so the insert cannot simply move
   * after the send. This is the other half of that ordering: when delivery fails, the
   * attempt is undone rather than left to count against the person.
   */
  discard(id: string): Promise<void>;
}

export interface CodeSender {
  send(input: { channel: SignupChannel; destination: string; code: string }): Promise<void>;
}

export interface SessionIssuer {
  /** Mints the browser session that the web app holds after verification. */
  issue(input: { personId: string }): Promise<{ token: string; expiresAt: Date }>;
}

export interface ConnectDeps {
  identity: IdentityPort;
  invites: InvitePort;
  sessions: SessionPort;
  codes: CodeStore;
  sender: CodeSender;
  issuer: SessionIssuer;
  /** HMAC key for code hashing. Rotating it invalidates codes in flight, which is fine. */
  codeSecret: string;
  clock: () => Date;
  /** Injected so tests are deterministic. Production uses a CSPRNG. */
  randomCode: () => string;
  randomId: () => string;
  /**
   * Registers a new person and accepts a room invite as one atomic step, when the
   * backing store can offer that. `verifyCode` uses this instead of calling
   * `identity.register` and `invites.accept` one after the other whenever both a new
   * person and an invite are involved — that sequence is exactly how a reused, expired
   * or otherwise invalid invite used to manufacture an account nobody ever agreed to and
   * no session was ever handed to: `register` committed on its own before `accept` had
   * any chance to refuse.
   *
   * Optional because the in-memory reference implementation has no transaction to offer
   * and nothing in that harness needs one — it is a test double, not a deployment. The
   * Postgres composition root always provides it; see
   * `PostgresServices.registerWithInvite`.
   */
  registerWithInvite?(
    input: { email?: string; phone?: string },
    inviteToken: string,
  ): Promise<{ person: Person; personalRoom: Room; joinedRoom: { room: Room; role: MemberRole } }>;
}
