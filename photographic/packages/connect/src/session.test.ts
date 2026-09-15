import { describe, expect, it } from 'vitest';

import { readSignedSession, SignedSessionIssuer } from './session.js';

const SECRET = 'test-signing-secret';

describe('signed browser sessions', () => {
  it('reads back the person a token was issued for', async () => {
    const issuer = new SignedSessionIssuer(SECRET);
    const { token } = await issuer.issue({ personId: 'p-abc-123' });

    expect(readSignedSession(token, SECRET)).toBe('p-abc-123');
  });

  it('refuses the old unsigned shape, which is what made forgery possible', async () => {
    // The bug this closes: `session-<personId>-<n>` was accepted on shape alone, so knowing
    // a person's id — which a shared room hands out — was enough to become them.
    expect(readSignedSession('session-p-abc-123-1', SECRET)).toBeNull();
    expect(readSignedSession('session-p-abc-123-999', SECRET)).toBeNull();
  });

  it('refuses a token signed with a different key', async () => {
    const { token } = await new SignedSessionIssuer('someone-elses-key').issue({
      personId: 'p-abc-123',
    });

    expect(readSignedSession(token, SECRET)).toBeNull();
  });

  it('refuses a token whose person has been swapped for another', async () => {
    const issuer = new SignedSessionIssuer(SECRET);
    const { token } = await issuer.issue({ personId: 'p-victim' });
    const [scheme, , nonce, signature] = token.split('.');

    const swapped = [
      scheme,
      Buffer.from('p-attacker', 'utf8').toString('base64url'),
      nonce,
      signature,
    ].join('.');

    expect(readSignedSession(swapped, SECRET)).toBeNull();
  });

  it('refuses malformed tokens rather than throwing', () => {
    for (const token of ['', '.', 'ps1', 'ps1.a.b', 'ps1.a.b.c.d', 'ps2.a.b.c', 'not a token']) {
      expect(readSignedSession(token, SECRET)).toBeNull();
    }
  });

  it('gives two sessions for the same person different tokens', async () => {
    const issuer = new SignedSessionIssuer(SECRET);
    const first = await issuer.issue({ personId: 'p-abc-123' });
    const second = await issuer.issue({ personId: 'p-abc-123' });

    expect(first.token).not.toBe(second.token);
    expect(readSignedSession(first.token, SECRET)).toBe('p-abc-123');
    expect(readSignedSession(second.token, SECRET)).toBe('p-abc-123');
  });

  it('survives a person id containing the characters the old reader split on', async () => {
    // The previous reader matched `^session-(.+)-\d+$`, so a hyphenated id was only read
    // correctly by luck of greediness. Encoding removes the guesswork.
    const issuer = new SignedSessionIssuer(SECRET);
    const personId = 'p-a-b-c-42';
    const { token } = await issuer.issue({ personId });

    expect(readSignedSession(token, SECRET)).toBe(personId);
  });

  it('refuses to be constructed without a secret, rather than signing with nothing', () => {
    expect(() => new SignedSessionIssuer('')).toThrow(/secret/i);
  });

  it('expires on its own schedule', async () => {
    const now = new Date('2026-09-15T12:00:00Z');
    const issuer = new SignedSessionIssuer(SECRET, { ttlMs: 60_000, clock: () => now });

    const { expiresAt } = await issuer.issue({ personId: 'p-abc-123' });

    expect(expiresAt.toISOString()).toBe('2026-09-15T12:01:00.000Z');
  });
});
