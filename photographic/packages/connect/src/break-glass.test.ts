/**
 * The break-glass token, tested against what it has to withstand rather than against
 * what it does.
 *
 * The two cases that matter most are the ones the signed-session work got wrong: an
 * expiry that the verifier never reads, and a test that asserts on the minting side's
 * return value instead of the verifying side's answer. Every expiry assertion here goes
 * through `verifyBreakGlassToken`, so none of them can pass while expiry is unenforced.
 */

import { describe, expect, it } from 'vitest';

import {
  BREAK_GLASS_SECRET_MIN_LENGTH,
  BREAK_GLASS_TTL_MS,
  mintBreakGlassToken,
  verifyBreakGlassToken,
} from './break-glass.js';

const secret = 'a'.repeat(BREAK_GLASS_SECRET_MIN_LENGTH);
const other = 'b'.repeat(BREAK_GLASS_SECRET_MIN_LENGTH);
const personId = '0f1d4a9c-3f9b-4a1f-9c0e-2b7c6d5e4f30';
const now = new Date('2026-09-15T08:00:00.000Z');

describe('mintBreakGlassToken', () => {
  it('names the person, and only under the right key', () => {
    const { token } = mintBreakGlassToken({ personId, secret, now });

    expect(verifyBreakGlassToken({ token, secret, now })?.personId).toBe(personId);
    expect(verifyBreakGlassToken({ token, secret: other, now })).toBeNull();
  });

  it('refuses to sign with a secret that is not one', () => {
    expect(() => mintBreakGlassToken({ personId, secret: 'kort', now })).toThrow(
      /BREAK_GLASS_SECRET/,
    );
  });

  it('never mints the same token twice for the same person', () => {
    const first = mintBreakGlassToken({ personId, secret, now });
    const second = mintBreakGlassToken({ personId, secret, now });

    expect(first.token).not.toBe(second.token);
    expect(first.jti).not.toBe(second.jti);
  });
});

describe('verifyBreakGlassToken', () => {
  it('stops working when the token expires, judged by the verifier', () => {
    const { token, expiresAt } = mintBreakGlassToken({ personId, secret, now });

    expect(expiresAt.getTime() - now.getTime()).toBe(BREAK_GLASS_TTL_MS);
    expect(verifyBreakGlassToken({ token, secret, now: new Date(expiresAt.getTime() - 1) })).not.toBeNull();
    expect(verifyBreakGlassToken({ token, secret, now: expiresAt })).toBeNull();
    expect(
      verifyBreakGlassToken({ token, secret, now: new Date(expiresAt.getTime() + 1000) }),
    ).toBeNull();
  });

  it('cannot have its expiry extended, because the expiry is signed', () => {
    const { token } = mintBreakGlassToken({ personId, secret, now });
    const [version, pid, expiry, jti, signature] = token.split('.');
    expect(Number(expiry)).toBeGreaterThan(now.getTime());

    const extended = [version, pid, String(now.getTime() + 10 * 365 * 24 * 3600_000), jti, signature].join('.');

    expect(verifyBreakGlassToken({ token: extended, secret, now })).toBeNull();
  });

  it('cannot be repointed at another person', () => {
    const { token } = mintBreakGlassToken({ personId, secret, now });
    const [version, , expiry, jti, signature] = token.split('.');
    const someoneElse = Buffer.from('11111111-2222-3333-4444-555555555555').toString('base64url');

    expect(
      verifyBreakGlassToken({
        token: [version, someoneElse, expiry, jti, signature].join('.'),
        secret,
        now,
      }),
    ).toBeNull();
  });

  it('refuses every shape that is not a token', () => {
    for (const token of [
      '',
      'bg1',
      'bg1.a.b.c',
      'bg1.a.b.c.d.e',
      `bg2.${Buffer.from(personId).toString('base64url')}.${now.getTime() + 1000}.x.y`,
      'session-0f1d4a9c-3f9b-4a1f-9c0e-2b7c6d5e4f30-1',
    ]) {
      expect(verifyBreakGlassToken({ token, secret, now }), token).toBeNull();
    }
  });

  it('verifies nothing at all when no secret is configured', () => {
    // The endpoint is mounted whether or not the secret is set, so this is the case that
    // keeps a deployment without break-glass from having a second front door.
    const { token } = mintBreakGlassToken({ personId, secret, now });

    expect(verifyBreakGlassToken({ token, secret: null, now })).toBeNull();
    expect(verifyBreakGlassToken({ token, secret: '', now })).toBeNull();
    expect(verifyBreakGlassToken({ token, secret: 'too-short', now })).toBeNull();
  });

  it('carries the jti through, so the log can name the token that was used', () => {
    const minted = mintBreakGlassToken({ personId, secret, now });

    expect(verifyBreakGlassToken({ token: minted.token, secret, now })?.jti).toBe(minted.jti);
  });
});
