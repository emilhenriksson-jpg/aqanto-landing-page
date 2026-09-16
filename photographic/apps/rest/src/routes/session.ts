/**
 * The browser-only end of a session.
 *
 * A browser session is an httpOnly cookie, so the client cannot remove it itself.
 * This endpoint remains available when that cookie has expired or become invalid:
 * logging out must repair a stale session just as reliably as it ends a live one.
 */

import { Hono } from 'hono';
import { getCookie } from 'hono/cookie';

import type { AppEnv } from '../context.js';
import { clearSessionCookie, SESSION_COOKIE } from '../session-cookie.js';

export function sessionRoutes(revoke?: (token: string) => Promise<void>): Hono<AppEnv> {
  const routes = new Hono<AppEnv>();

  routes.post('/session/logout', async (c) => {
    if (!isSameOrigin(c.req.header('origin'), c.req.header('host'), c.req.url, c.get('config').publicUrl)) {
      return c.json(
        { error: { code: 'forbidden', message: 'Begäran kom från en annan plats.' } },
        403,
      );
    }

    const cookie = getCookie(c, SESSION_COOKIE);
    const bearer = c.req.header('authorization')?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
    const tokens = new Set([cookie, bearer].filter((token): token is string => Boolean(token)));
    if (tokens.size > 0) {
      if (!revoke) return c.json({ error: { message: 'Utloggning är inte tillgänglig just nu.' } }, 503);
      for (const token of tokens) await revoke(token);
    }
    clearSessionCookie(c, { publicUrl: c.get('config').publicUrl });
    c.header('cache-control', 'no-store');
    return c.body(null, 204);
  });

  return routes;
}

/**
 * Sign-out revokes only this browser's session, but a third-party page still must not be
 * able to trigger it. Compare Origin to the request host rather than `PUBLIC_URL`: the
 * same app intentionally serves both photographic.space and mcp.photographic.space.
 */
function isSameOrigin(origin: string | undefined, host: string | undefined, url: string, publicUrl: string): boolean {
  if (!origin) return false;
  try {
    // Preserve the port: mcp.localhost:8787 and mcp.localhost:5173 are different
    // origins. `requestHost` intentionally strips it for hostname routing, which is
    // right there and wrong for a CSRF boundary.
    const requestHost = host?.toLowerCase() || new URL(url).host.toLowerCase();
    const parsed = new URL(origin);
    return parsed.host.toLowerCase() === requestHost && parsed.protocol === new URL(publicUrl).protocol;
  } catch {
    return false;
  }
}
