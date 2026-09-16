/**
 * The browser-only end of a session.
 *
 * A browser session is an httpOnly cookie, so the client cannot remove it itself.
 * This endpoint remains available when that cookie has expired or become invalid:
 * logging out must repair a stale session just as reliably as it ends a live one.
 */

import { Hono } from 'hono';

import type { AppEnv } from '../context.js';
import { clearSessionCookie } from '../session-cookie.js';

export function sessionRoutes(): Hono<AppEnv> {
  const routes = new Hono<AppEnv>();

  routes.post('/session/logout', (c) => {
    if (!isSameOrigin(c.req.header('origin'), c.req.header('host'), c.req.url)) {
      return c.json(
        { error: { code: 'forbidden', message: 'Begäran kom från en annan plats.' } },
        403,
      );
    }

    clearSessionCookie(c, { publicUrl: c.get('config').publicUrl });
    c.header('cache-control', 'no-store');
    return c.body(null, 204);
  });

  return routes;
}

/**
 * Sign-out changes only this browser's cookie, but a third-party page still must not be
 * able to trigger it. Compare Origin to the request host rather than `PUBLIC_URL`: the
 * same app intentionally serves both photographic.space and mcp.photographic.space.
 */
function isSameOrigin(origin: string | undefined, host: string | undefined, url: string): boolean {
  if (!origin) return false;
  try {
    // Preserve the port: mcp.localhost:8787 and mcp.localhost:5173 are different
    // origins. `requestHost` intentionally strips it for hostname routing, which is
    // right there and wrong for a CSRF boundary.
    const requestHost = host?.toLowerCase() || new URL(url).host.toLowerCase();
    return new URL(origin).host.toLowerCase() === requestHost;
  } catch {
    return false;
  }
}
