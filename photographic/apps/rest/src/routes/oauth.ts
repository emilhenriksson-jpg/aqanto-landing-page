/**
 * The OAuth endpoints.
 *
 * Thin on purpose. Every decision an attacker cares about — which redirect URI is
 * allowed, whether a code has been redeemed, whether PKCE verifies — is made inside
 * `@photographic/auth`, and this file only carries bytes to it. If a security question
 * has an answer in here, it is in the wrong place.
 *
 * These routes sit outside `authenticate`, because they are what a client calls when it
 * has nothing to authenticate with yet. `/oauth/authorize/approve` is the exception: it
 * carries the browser session token from the sign-up flow, and the auth package verifies
 * that itself rather than trusting an actor this app resolved.
 */

import type { Context } from 'hono';
import { Hono } from 'hono';
import { getCookie } from 'hono/cookie';
import type { ContentfulStatusCode } from 'hono/utils/http-status';

import type { AppEnv } from '../context.js';
import { clientAddress, requestIsSameOrigin } from '../middleware.js';
import type { OAuthProvider, OAuthRequest, OAuthResponse } from '../oauth-contract.js';
import { OAUTH_PATHS } from '../oauth-contract.js';
import { SESSION_COOKIE } from '../session-cookie.js';

/** A body read into memory before anything is known about who sent it. */
const MAX_BODY_BYTES = 64 * 1024;

type OAuthHandler = (request: OAuthRequest) => Promise<OAuthResponse>;

export function oauthRoutes(oauth: OAuthProvider): Hono<AppEnv> {
  const routes = new Hono<AppEnv>();

  const handle = (handler: OAuthHandler | undefined) => async (c: Context<AppEnv>) => {
    if (!handler) {
      return send(c, {
        status: 501,
        body: {
          error: 'temporarily_unavailable',
          error_description: 'Den delen av inloggningen är inte inkopplad.',
        },
      });
    }

    const body = await readBody(c);
    if (!body.ok) {
      return send(c, {
        status: 413,
        body: { error: 'invalid_request', error_description: 'Förfrågan är för stor.' },
      });
    }

    return send(c, await handler(toOAuthRequest(c, body.value)));
  };

  routes.get(OAUTH_PATHS.authorize, handle(oauth.authorize));
  routes.post(OAUTH_PATHS.token, handle(oauth.token));
  routes.post(OAUTH_PATHS.register, handle(oauth.register));
  routes.post(OAUTH_PATHS.revoke, handle(oauth.revoke));

  // The login page's half of the flow. No AI client calls these.
  routes.get(OAUTH_PATHS.authorizeRequest, handle(oauth.describeRequest));
  /**
   * Approve is the exception among OAuth routes: it is called by our own page after
   * the person is signed in. The session used to live only in an `Authorization`
   * header the onboarding app kept in memory, so a reload — or a cookie we had just
   * set — could not finish the consent screen. The cookie is the same token; we lift
   * it into the header the auth package already reads, under the same CSRF lock the
   * rest of the cookie surface uses.
   */
  routes.post(OAUTH_PATHS.authorizeApprove, async (c) => {
    if (!oauth.approve) {
      return send(c, {
        status: 501,
        body: {
          error: 'temporarily_unavailable',
          error_description: 'Den delen av inloggningen är inte inkopplad.',
        },
      });
    }

    const body = await readBody(c);
    if (!body.ok) {
      return send(c, {
        status: 413,
        body: { error: 'invalid_request', error_description: 'Förfrågan är för stor.' },
      });
    }

    const request = toOAuthRequest(c, body.value);
    if (!request.headers['authorization']) {
      const cookie = getCookie(c, SESSION_COOKIE);
      if (cookie) {
        if (!requestIsSameOrigin(c)) {
          return c.json(
            {
              error: {
                code: 'forbidden',
                message: 'Begäran kom från en annan plats.',
              },
            },
            403,
          );
        }
        request.headers['authorization'] = `Bearer ${cookie}`;
      }
    }

    return send(c, await oauth.approve(request));
  });

  return routes;
}

function toOAuthRequest(c: Context<AppEnv>, body: string): OAuthRequest {
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(c.req.header())) {
    if (value !== undefined) headers[name.toLowerCase()] = value;
  }

  const query: Record<string, string | string[]> = {};
  for (const [key, values] of Object.entries(c.req.queries())) {
    // The array is preserved rather than collapsed: a duplicated OAuth parameter is an
    // invalid request, and the auth package can only say so if it can still see both.
    query[key] = values.length === 1 ? (values[0] as string) : values;
  }

  return {
    method: c.req.method,
    url: c.req.url,
    headers,
    query,
    body,
    clientAddress: clientAddress(c),
  };
}

/**
 * The body as text, unparsed.
 *
 * The auth package parses per endpoint — `formParams` for the token endpoint, `jsonBody`
 * for registration — so content-type sniffing stays out of a place where guessing wrong
 * would mean an endpoint reading a parameter the sender never sent.
 */
async function readBody(
  c: Context<AppEnv>,
): Promise<{ ok: true; value: string } | { ok: false }> {
  if (c.req.method === 'GET' || c.req.method === 'HEAD') return { ok: true, value: '' };

  const declared = Number(c.req.header('content-length'));
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) return { ok: false };

  const text = await c.req.text();
  if (text.length > MAX_BODY_BYTES) return { ok: false };

  return { ok: true, value: text };
}

function send(c: Context<AppEnv>, response: OAuthResponse) {
  for (const [name, value] of Object.entries(response.headers ?? {})) {
    c.header(name, value);
  }

  const status = response.status as ContentfulStatusCode;

  if (typeof response.body === 'string') {
    if (response.headers?.['content-type'] === undefined) {
      c.header('content-type', 'application/json');
    }
    return c.body(response.body, status);
  }

  return c.json(response.body ?? {}, status);
}
