import { createHash } from 'node:crypto';
import { readSignedSession } from '@photographic/connect';

export interface SessionRevocations {
  has(hash: string): Promise<boolean>;
  add(hash: string, expiresAt: Date): Promise<void>;
}

/** Development-only persistence, selected alongside the other in-memory services. */
export class MemorySessionRevocations implements SessionRevocations {
  private readonly entries = new Map<string, Date>();
  async has(hash: string): Promise<boolean> {
    return (this.entries.get(hash)?.getTime() ?? 0) > Date.now();
  }
  async add(hash: string, expiresAt: Date): Promise<void> {
    this.entries.set(hash, expiresAt);
    for (const [key, expiry] of this.entries) {
      if (expiry.getTime() <= Date.now()) this.entries.delete(key);
    }
  }
}

const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');

/** Every consumer, including OAuth consent, checks the same persistent revocation. */
export function browserSessions(secret: string, revocations: SessionRevocations) {
  return {
    async verify(token: string): Promise<string | null> {
      const personId = readSignedSession(token, secret);
      if (!personId || await revocations.has(hashToken(token))) return null;
      return personId;
    },
    async revoke(token: string): Promise<void> {
      // Invalid/expired cookies can still be cleared. Never persist attacker input.
      if (!readSignedSession(token, secret)) return;
      const expiresAt = new Date(Number(token.split('.')[4]));
      await revocations.add(hashToken(token), expiresAt);
    },
  };
}
