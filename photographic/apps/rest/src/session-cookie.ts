/**
 * The browser's session, as an httpOnly cookie.
 *
 * Why this exists, since it replaces a decision that was correct when it was made.
 * `apps/onboarding` kept the session token in memory and said why: it is a bearer
 * credential for someone's entire memory, and anything that can run script on the page
 * can read it out of `localStorage`. That reasoning still holds. But memory-only means a
 * reload signs the person out of their own memory, and `apps/web` reads a `localStorage`
 * key that nothing ever writes — so in practice there was no way to be signed in to the
 * product at all.
 *
 * A cookie resolves both without conceding either point: `httpOnly` puts it out of reach
 * of page script, which is the property `localStorage` could not offer, and it survives a
 * reload, which memory could not. It was awkward before only because the two apps were on
 * different origins. They are not any more, so the constraint that shaped the original
 * decision is gone.
 *
 * Deliberately the same token the `Authorization` header carries, not a second kind of
 * credential. `introspect` already resolves a browser session token to
 * `FIRST_PARTY_CLIENT_ID`, so a cookie-authenticated request is *more* clearly
 * first-party than a bearer one, and `firstPartyOnly` keeps meaning what it says without
 * knowing this file exists.
 */

import type { Context } from 'hono';
import { deleteCookie, setCookie } from 'hono/cookie';

import type { AppEnv } from './context.js';

/** Named for what it is. Not the `photographic_session` `localStorage` key, which is
 * readable by script and is what this replaces. */
export const SESSION_COOKIE = 'photographic_sid';

export interface SessionCookieOptions {
  /** So a loopback dev server over http still gets a working cookie. */
  publicUrl: string;
  expiresAt: Date | null;
}

export function setSessionCookie(
  c: Context<AppEnv>,
  token: string,
  options: SessionCookieOptions,
): void {
  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    // `Secure` would stop the cookie being sent at all over plain http, which is how
    // local development runs. Keyed off the origin we actually serve rather than
    // `NODE_ENV`, so a production deploy cannot end up with a non-secure cookie because
    // an environment variable was wrong.
    secure: options.publicUrl.startsWith('https://'),
    /**
     * `Lax`, not `Strict`.
     *
     * `Strict` would withhold the cookie on the first navigation into the site from
     * anywhere else — an emailed link, a message, the OAuth redirect coming back — so a
     * person who is signed in would land signed out and sign in again for no reason.
     * `Lax` still withholds it from every cross-site *mutating* request, which is the
     * half that matters for CSRF, and `authenticate` checks the origin on top of it.
     */
    sameSite: 'Lax',
    path: '/',
    ...(options.expiresAt ? { expires: options.expiresAt } : {}),
  });
}

export function clearSessionCookie(c: Context<AppEnv>, options: { publicUrl: string }): void {
  deleteCookie(c, SESSION_COOKIE, {
    path: '/',
    secure: options.publicUrl.startsWith('https://'),
  });
}
