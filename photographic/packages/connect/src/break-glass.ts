/**
 * The way in when nothing else works.
 *
 * A one-time code normally reaches a person by SMS. When no provider is configured the
 * production process refuses to send rather than writing the code to the server log
 * (`RefusingCodeSender` in `@photographic/delivery`), which is right — a credential in a
 * log file is readable by every token that can read logs, and a read-only deploy token is
 * not supposed to be a way into someone's memory. But refusing leaves the owner with no
 * door at all on the day SMS is broken, and "the product is unreachable until a supplier
 * answers" is not an acceptable failure for a memory that is meant to last decades.
 *
 * So there is one other door, and its key is the machine. A token is minted by a script
 * run on the running machine (`scripts/break-glass-signin.ts`, over `fly ssh console`),
 * never by a request: this module has no HTTP surface and the secret it signs with is
 * only readable by the machine. Holding a token means someone already had a shell on the
 * host — which is deploy access, not read access — where the log route needed nothing but
 * the right to read logs.
 *
 * Three properties are load-bearing, and each of them is a mistake this codebase has
 * already made once:
 *
 * - **Expiry is inside the signature.** `expiresAtMs` is signed material, so it cannot be
 *   edited and no verifier can forget to check it. A signed session whose expiry lived
 *   outside the payload is exactly how PR #14 ended up with permanent tokens.
 * - **One purpose, one key.** `BREAK_GLASS_SECRET`, never `CODE_SECRET`. A key used for
 *   two things cannot be rotated for one of them without breaking the other.
 * - **The token is not a session.** It is exchanged for one, once, at
 *   `POST /v1/signup/break-glass`. Its own life is minutes, so a terminal scrollback left
 *   open is not a standing credential.
 */

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/** Minutes, not hours: long enough to paste a URL, short enough to be worthless later. */
export const BREAK_GLASS_TTL_MS = 10 * 60 * 1000;

/**
 * Below this the secret is not one. 32 hex characters is what `openssl rand -hex 32`
 * gives at half length, so the floor rejects a placeholder without rejecting anything a
 * person generated properly.
 */
export const BREAK_GLASS_SECRET_MIN_LENGTH = 32;

const VERSION = 'bg1';

export interface BreakGlassToken {
  token: string;
  expiresAt: Date;
  /** Recorded in the event log at mint time, so a token can be named after the fact. */
  jti: string;
}

/**
 * Signs one token for one person.
 *
 * Takes the person id the caller already resolved from a phone number rather than the
 * number itself: the number is how a human names the account, and `app.person.id` is what
 * a session is actually for. Resolving it is the script's job, and it is the step that
 * makes the script refuse when the named number has no account.
 */
export function mintBreakGlassToken(input: {
  personId: string;
  secret: string;
  now?: Date;
  ttlMs?: number;
}): BreakGlassToken {
  assertUsableSecret(input.secret);

  const now = input.now ?? new Date();
  const expiresAt = new Date(now.getTime() + (input.ttlMs ?? BREAK_GLASS_TTL_MS));
  const jti = randomBytes(9).toString('base64url');

  const signed = `${VERSION}.${encode(input.personId)}.${expiresAt.getTime()}.${jti}`;
  return { token: `${signed}.${sign(signed, input.secret)}`, expiresAt, jti };
}

export interface BreakGlassClaims {
  personId: string;
  expiresAt: Date;
  jti: string;
}

/**
 * The person a token names, or null.
 *
 * One `null` for every way a token can be unusable — wrong shape, wrong signature,
 * expired, no secret configured — because the endpoint that calls this is reachable
 * without credentials and anything that distinguishes those states describes the secret
 * to whoever is guessing at it.
 */
export function verifyBreakGlassToken(input: {
  token: string;
  secret: string | null;
  now?: Date;
}): BreakGlassClaims | null {
  const { token, secret } = input;
  if (!secret || secret.length < BREAK_GLASS_SECRET_MIN_LENGTH) return null;

  const parts = token.trim().split('.');
  if (parts.length !== 5) return null;

  const [version, encodedPersonId, expiry, jti, signature] = parts as [
    string,
    string,
    string,
    string,
    string,
  ];
  if (version !== VERSION) return null;

  const signed = `${version}.${encodedPersonId}.${expiry}.${jti}`;
  if (!signatureMatches(sign(signed, secret), signature)) return null;

  // After the signature, never before: an expiry check on unverified material would let a
  // guess be timed against a real token's lifetime.
  const expiresAtMs = Number(expiry);
  if (!Number.isSafeInteger(expiresAtMs)) return null;
  const now = input.now ?? new Date();
  if (expiresAtMs <= now.getTime()) return null;

  const personId = decode(encodedPersonId);
  if (!personId) return null;

  return { personId, expiresAt: new Date(expiresAtMs), jti };
}

/**
 * What the minting side refuses over, loudly, in the operator's language.
 *
 * Separate from `verifyBreakGlassToken`'s silence on purpose: the script is run by a
 * person on the machine who needs to know exactly what to fix, and the endpoint is
 * reachable by anyone and must say nothing at all.
 */
export function assertUsableSecret(secret: string | undefined | null): asserts secret is string {
  if (!secret || secret.length < BREAK_GLASS_SECRET_MIN_LENGTH) {
    throw new Error(
      `BREAK_GLASS_SECRET saknas eller är för kort (minst ${BREAK_GLASS_SECRET_MIN_LENGTH} tecken). ` +
        'Skapa en med `openssl rand -hex 32` och sätt den med `fly secrets set BREAK_GLASS_SECRET=...`.',
    );
  }
}

function sign(signed: string, secret: string): string {
  return createHmac('sha256', secret).update(signed).digest('base64url');
}

function signatureMatches(expected: string, candidate: string): boolean {
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(candidate, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function encode(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64url');
}

function decode(value: string): string | null {
  const decoded = Buffer.from(value, 'base64url').toString('utf8');
  // Round-tripped rather than trusted: base64url decoding accepts input that does not
  // re-encode to itself, and a person id that is not exactly what was signed is not one.
  return encode(decoded) === value && decoded.length > 0 ? decoded : null;
}
