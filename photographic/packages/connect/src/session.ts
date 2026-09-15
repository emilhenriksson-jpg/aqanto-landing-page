/**
 * The browser session token, signed.
 *
 * What this replaces mattered: the token used to be `session-<personId>-<n>`, and the only
 * check on it was that the shape matched and the person existed. No store, no signature —
 * so anyone who knew a `personId` could mint that person's session by hand. `personId` is
 * not a secret and was never treated as one: a shared room hands out its members' ids, so
 * the people the product exists to let collaborate were exactly the people who could
 * authenticate as each other.
 *
 * A signature closes forgery without needing a store: the token still carries who it is
 * for, but only the holder of `CODE_SECRET` can produce a valid one. What it deliberately
 * does *not* give is revocation — nothing here can be withdrawn before it expires, which
 * is why a stored, revocable session is the next step and why sign-out needs that step
 * rather than this one. A sign-out built on this would clear the cookie and leave the
 * credential live.
 */

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

import type { SessionIssuer } from './deps.js';

/**
 * Version marker, so the shape can change again without a token from the old scheme ever
 * being mistaken for a valid one. Tokens minted before signing existed do not carry it and
 * are rejected on that alone.
 */
const SCHEME = 'ps1';

/**
 * How a caller tells a browser session apart from an OAuth access token before verifying
 * either. Exported because the dispatch and the minting must agree: when this was the bare
 * literal `session-` written out in both places, changing one silently routed every session
 * to the wrong verifier, which fails as "your token is invalid" rather than as a mismatch.
 */
export const SESSION_TOKEN_PREFIX = `${SCHEME}.`;

const DEFAULT_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * `base64url` rather than the raw id, because `personId` contains hyphens and the previous
 * reader split on them with a greedy match. Encoding removes the ambiguity instead of
 * relying on a pattern to resolve it.
 */
function encodeSegment(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64url');
}

function decodeSegment(value: string): string | null {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return null;
  const decoded = Buffer.from(value, 'base64url').toString('utf8');
  // Round-trip check: `base64url` decoding is lenient, and a token whose id does not
  // re-encode to the bytes we were given is not one we issued.
  return encodeSegment(decoded) === value ? decoded : null;
}

function sign(payload: string, secret: string): string {
  return createHmac('sha256', secret).update(payload).digest('base64url');
}

function signatureMatches(expected: string, candidate: string): boolean {
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(candidate, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export interface SignedSessionIssuerOptions {
  ttlMs?: number;
  clock?: () => Date;
}

export class SignedSessionIssuer implements SessionIssuer {
  private readonly ttlMs: number;
  private readonly clock: () => Date;

  constructor(
    private readonly secret: string,
    options: SignedSessionIssuerOptions = {},
  ) {
    if (!secret) throw new Error('SignedSessionIssuer requires a signing secret.');
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.clock = options.clock ?? (() => new Date());
  }

  async issue(input: { personId: string }): Promise<{ token: string; expiresAt: Date }> {
    // A nonce so two sessions for the same person are different strings. It buys no
    // security on its own here — the signature does that — but it means a token is not a
    // pure function of the person, so one leaking does not describe every other.
    const payload = `${SCHEME}.${encodeSegment(input.personId)}.${randomBytes(16).toString('base64url')}`;
    return {
      token: `${payload}.${sign(payload, this.secret)}`,
      expiresAt: new Date(this.clock().getTime() + this.ttlMs),
    };
  }
}

/**
 * The person a token was issued for, or `null` — including for every token this scheme did
 * not mint. The caller still has to confirm the person exists; this only answers whether
 * the token is genuine.
 */
export function readSignedSession(token: string, secret: string): string | null {
  const parts = token.split('.');
  if (parts.length !== 4) return null;

  const [scheme, encodedPersonId, nonce, signature] = parts;
  if (scheme !== SCHEME) return null;
  if (!encodedPersonId || !nonce || !signature) return null;

  if (!signatureMatches(sign(`${scheme}.${encodedPersonId}.${nonce}`, secret), signature)) {
    return null;
  }

  return decodeSegment(encodedPersonId);
}
