/**
 * The narrow surface sign-up and verification need. Deliberately smaller than
 * `Services`, so this package can be tested with in-memory doubles and no database.
 */

import type { IdentityPort, InvitePort, SessionPort } from '@photographic/core';

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
}
