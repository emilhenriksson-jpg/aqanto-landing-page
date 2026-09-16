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
 * A signature prevents forgery. Production also checks a persistent hash revocation
 * store in the REST composition root before accepting a token, including for OAuth
 * consent. This reader only verifies the signature and lifetime; it is not by itself
 * an authentication decision. Logout revokes the browser credential without touching
 * any OAuth grant. Opaque stored session tokens remain a possible later format change.
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
 * How far ahead of us a token's `iat` may sit before we stop believing it.
 *
 * One process issues and verifies these today, so any skew is a clock stepping rather
 * than two machines disagreeing. Small enough that it cannot be used to stretch a
 * session, large enough to survive an NTP correction mid-request.
 */
const CLOCK_SKEW_MS = 60_000;

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
    const issuedAt = this.clock().getTime();
    const expiresAt = new Date(issuedAt + this.ttlMs);

    // A nonce so two sessions for the same person are different strings. It buys no
    // security on its own here — the signature does that — but it means a token is not a
    // pure function of the person, so one leaking does not describe every other.
    //
    // `exp` is *inside* the signed payload, which is the whole point of it being here
    // rather than only on the cookie. A cookie attribute is a request the browser may
    // honour; anything that matters has to be something the verifier reads and the
    // signature covers.
    const payload = [
      SCHEME,
      encodeSegment(input.personId),
      randomBytes(16).toString('base64url'),
      String(issuedAt),
      String(expiresAt.getTime()),
    ].join('.');

    return { token: `${payload}.${sign(payload, this.secret)}`, expiresAt };
  }
}

/**
 * The person a token was issued for, or `null` — including for every token this scheme did
 * not mint. The caller still has to confirm the person exists; this only answers whether
 * the token is genuine.
 */
export function readSignedSession(
  token: string,
  secret: string,
  options: { now?: Date } = {},
): string | null {
  const parts = token.split('.');
  if (parts.length !== 6) return null;

  const [scheme, encodedPersonId, nonce, issuedAt, expiresAt, signature] = parts;
  if (scheme !== SCHEME) return null;
  if (!encodedPersonId || !nonce || !issuedAt || !expiresAt || !signature) return null;

  const payload = [scheme, encodedPersonId, nonce, issuedAt, expiresAt].join('.');
  if (!signatureMatches(sign(payload, secret), signature)) return null;

  // Only after the signature, so the timestamps being read are ones we wrote. Checking
  // them first would be reading attacker-controlled numbers.
  const issued = Number(issuedAt);
  const expires = Number(expiresAt);
  if (!Number.isSafeInteger(issued) || !Number.isSafeInteger(expires)) return null;
  if (expires <= issued) return null;

  const now = (options.now ?? new Date()).getTime();
  if (now >= expires) return null;
  // A token claiming to be from the future is not one we issued on a clock we trust, and
  // accepting it would let a skewed or tampered `iat` extend a session indefinitely.
  if (issued > now + CLOCK_SKEW_MS) return null;

  return decodeSegment(encodedPersonId);
}
