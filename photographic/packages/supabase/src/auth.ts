/**
 * Supabase Auth as a way of proving who someone is — and nothing more.
 *
 * The distinction is the whole design. Supabase Auth answers "is this person who they
 * say they are", which is a question it is good at and which Photographic has no reason
 * to reimplement. It does **not** answer "may this person read this room": that stays in
 * the API layer, in one place, because two authorities on room permissions is how rooms
 * leak, and because a permission model living in a vendor's policy engine is a
 * permission model that cannot be ported.
 *
 * So this module does exactly two things. It verifies a Supabase access token
 * cryptographically, and it maps the verified subject to a Photographic `PersonId`. What
 * it returns is an identity. Every access decision downstream is made the same way it is
 * for an OAuth token, by the same code, against the same memberships.
 *
 * Note what is absent: no `person_id` is ever read out of the token's claims. A Supabase
 * project's own metadata is user-writable through the Auth API, so a `person_id` claim
 * would be an identity a person could choose. The mapping lives in `app.credential`,
 * keyed on the provider subject, and is ours.
 */

import { AuthError } from '@photographic/core';
import type { PersonId } from '@photographic/core';
import { createLocalJWKSet, createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';

import type { SupabaseConfig } from './config.js';

/** The provider name under which a Supabase subject is stored in `app.credential`. */
export const SUPABASE_CREDENTIAL_PROVIDER = 'supabase';

/**
 * A verified Supabase token, reduced to what we will act on.
 *
 * Deliberately small. `email` is here because it is how an existing Photographic account
 * is recognised on first sign-in; everything else Supabase puts in a token is either
 * user-writable or irrelevant to us.
 */
export interface SupabaseIdentity {
  /** `sub`: the Supabase user id. Stable, opaque, and the key we store. */
  subject: string;
  email: string | null;
  /** True when Supabase says the address was confirmed. See `linkPerson`. */
  emailVerified: boolean;
  /** Present only when the project still issues HS256 tokens. */
  algorithm: string;
}

/** Resolves and creates the Photographic person behind a Supabase subject. */
export interface PersonDirectory {
  /** The person previously linked to this subject, if any. */
  findBySupabaseSubject(subject: string): Promise<PersonId | null>;
  findByEmail(email: string): Promise<PersonId | null>;
  /** Creates the person and their personal room, then links the subject. */
  createFromSupabase(input: { subject: string; email: string | null }): Promise<PersonId>;
  /** Attaches a Supabase subject to an existing person. */
  linkSupabaseSubject(input: { personId: PersonId; subject: string }): Promise<void>;
}

export interface SupabaseAuthOptions {
  config: SupabaseConfig;
  /**
   * Overrides remote JWKS fetching. A test passes the project's public keys directly;
   * production lets `jose` fetch and cache them.
   */
  jwks?: Parameters<typeof createLocalJWKSet>[0];
  now?: () => Date;
}

export class SupabaseAuth {
  private readonly config: SupabaseConfig;
  private readonly keys: ReturnType<typeof createRemoteJWKSet> | ReturnType<typeof createLocalJWKSet>;
  private readonly secret: Uint8Array | null;

  constructor(options: SupabaseAuthOptions) {
    this.config = options.config;
    this.keys = options.jwks
      ? createLocalJWKSet(options.jwks)
      : createRemoteJWKSet(new URL(this.config.jwksUrl));
    this.secret = this.config.jwtSecret
      ? new TextEncoder().encode(this.config.jwtSecret)
      : null;
  }

  /**
   * Verifies a Supabase access token.
   *
   * `issuer` and `audience` are both checked. Skipping the audience would let a token
   * minted elsewhere in the same project — a service token, say — authenticate as a
   * person, which is the kind of hole that only shows up once someone looks for it.
   *
   * Throws `AuthError` with no detail about which check failed, like every other token
   * path here: unknown, expired and wrong-audience are one answer, because the
   * difference tells the holder of a stolen token what kind of stolen token they have.
   */
  async verify(token: string): Promise<SupabaseIdentity> {
    if (token.trim() === '') throw new AuthError('missing token');

    const payload = await this.verifyPayload(token);
    const subject = typeof payload.sub === 'string' ? payload.sub : '';
    if (!subject) throw new AuthError('invalid token');

    const email = typeof payload.email === 'string' ? payload.email : null;

    return {
      subject,
      email,
      // Supabase spells this several ways across versions. Absent counts as unverified,
      // which is the safe direction: see `linkPerson` for why it matters.
      emailVerified: readVerified(payload),
      algorithm: (payload as { alg?: string }).alg ?? 'unknown',
    };
  }

  private async verifyPayload(token: string): Promise<JWTPayload> {
    const options = {
      issuer: this.config.issuer,
      audience: this.config.audience,
    };

    try {
      // Asymmetric first: it is the current Supabase default, and it means this process
      // verifies with a public key and therefore holds nothing that could mint a token.
      const { payload } = await jwtVerify(token, this.keys, options);
      return payload;
    } catch (asymmetricError) {
      if (!this.secret) throw new AuthError('invalid token');

      try {
        const { payload } = await jwtVerify(token, this.secret, options);
        return payload;
      } catch {
        // Neither worked. The asymmetric error is the more informative one but neither
        // is reported: the caller gets 401 and no hint about which check failed.
        void asymmetricError;
        throw new AuthError('invalid token');
      }
    }
  }

  /**
   * Turns a verified identity into a Photographic person, creating one if needed.
   *
   * Three cases, and the order is the security-relevant part.
   *
   * A known subject resolves straight to its person. This is the common path and it
   * never touches the email, so a person changing their address in Supabase cannot
   * change which Photographic account they reach.
   *
   * An unknown subject with a **verified** email adopts the existing account with that
   * address. This is what makes an existing Photographic user able to sign in through
   * Supabase without ending up with a second, empty memory.
   *
   * An unknown subject with an unverified email gets a new account, never an existing
   * one. Linking on an unverified address would be an account takeover with one step:
   * sign up in Supabase claiming someone else's email, and inherit their memory. The
   * cost of being strict is a duplicate account for someone who has not confirmed their
   * address yet, which is recoverable; the cost of being lax is not.
   */
  async linkPerson(
    identity: SupabaseIdentity,
    people: PersonDirectory,
  ): Promise<{ personId: PersonId; created: boolean; adopted: boolean }> {
    const known = await people.findBySupabaseSubject(identity.subject);
    if (known) return { personId: known, created: false, adopted: false };

    if (identity.email && identity.emailVerified) {
      const existing = await people.findByEmail(identity.email);
      if (existing) {
        await people.linkSupabaseSubject({ personId: existing, subject: identity.subject });
        return { personId: existing, created: false, adopted: true };
      }
    }

    const personId = await people.createFromSupabase({
      subject: identity.subject,
      email: identity.email,
    });
    return { personId, created: true, adopted: false };
  }
}

/**
 * Whether Supabase considers the address confirmed.
 *
 * Spelled differently across Supabase versions — a boolean claim in some, a timestamp
 * in `user_metadata` in others — so all the spellings are checked and anything
 * unrecognised counts as unverified.
 */
function readVerified(payload: JWTPayload): boolean {
  if (payload['email_verified'] === true) return true;

  const userMetadata = payload['user_metadata'];
  if (userMetadata && typeof userMetadata === 'object') {
    const meta = userMetadata as Record<string, unknown>;
    if (meta['email_verified'] === true) return true;
  }

  // `email_confirmed_at` is a timestamp when confirmed and absent otherwise.
  const confirmedAt = payload['email_confirmed_at'];
  if (typeof confirmedAt === 'string' && confirmedAt.length > 0) return true;

  return false;
}
