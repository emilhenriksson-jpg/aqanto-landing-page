/**
 * Cryptographic primitives for the authorization server.
 *
 * Two rules govern this file:
 *   1. Raw secrets never leave it in a comparable form -- everything that compares a
 *      secret goes through `constantTimeEqual`.
 *   2. Nothing here ever returns a value safe to log. Use `fingerprint` for that.
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/** URL-safe, high-entropy string. 32 bytes = 256 bits, base64url encoded. */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

export function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

export function sha256Base64Url(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('base64url');
}

/**
 * Compares two secrets without leaking their contents through timing.
 *
 * Both sides are hashed first so that unequal lengths cannot short-circuit and so the
 * comparison is over fixed-width buffers, which is what `timingSafeEqual` requires.
 */
export function constantTimeEqual(a: string, b: string): boolean {
  const left = createHash('sha256').update(a, 'utf8').digest();
  const right = createHash('sha256').update(b, 'utf8').digest();
  return timingSafeEqual(left, right);
}

/**
 * The only representation of a secret that may appear in a log line: the first bytes of
 * its SHA-256. Enough to correlate two log entries, useless to an attacker who reads
 * them.
 */
export function fingerprint(secret: string): string {
  return `sha256:${sha256Hex(secret).slice(0, 12)}`;
}

/** PKCE S256 challenge for a verifier. */
export function s256Challenge(verifier: string): string {
  return sha256Base64Url(verifier);
}

const VERIFIER_PATTERN = /^[A-Za-z0-9\-._~]{43,128}$/;

/** RFC 7636 section 4.1: 43-128 characters from the unreserved set. */
export function isValidCodeVerifier(verifier: string): boolean {
  return VERIFIER_PATTERN.test(verifier);
}

const CHALLENGE_PATTERN = /^[A-Za-z0-9\-._~]{43,128}$/;

export function isValidCodeChallenge(challenge: string): boolean {
  return CHALLENGE_PATTERN.test(challenge);
}

/**
 * Verifies a PKCE code_verifier against a stored S256 challenge.
 *
 * `plain` is not implemented anywhere in this package on purpose: accepting it is the
 * PKCE downgrade attack, and OAuth 2.1 removed it.
 */
export function verifyPkceS256(verifier: string, storedChallenge: string): boolean {
  if (!isValidCodeVerifier(verifier)) return false;
  return constantTimeEqual(s256Challenge(verifier), storedChallenge);
}
