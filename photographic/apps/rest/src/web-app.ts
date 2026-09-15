/**
 * The browser app, served from the API origin.
 *
 * Two of the URLs this process hands out are pages a person opens rather than endpoints
 * a client calls: the login page an authorization request redirects to, and the connect
 * page a QR code points at. In development those live on a Vite dev server that proxies
 * `/v1`, `/oauth` and `/.well-known` back here, which is why the app calls its API with
 * same-origin relative paths.
 *
 * That proxy does not exist anywhere but a laptop. Published behind a single hostname —
 * a tunnel, or one container — the login page has to come from this process or the OAuth
 * flow dead-ends after the redirect: the client reaches `/mcp`, discovers the
 * authorization server, opens `/oauth/authorize`, and the browser lands on an origin
 * that serves no HTML. Serving the built app here is what makes one URL enough, and one
 * URL is the whole requirement — a client discovers everything else from the MCP
 * endpoint's own metadata.
 *
 * Mounted last, and only over paths the API has not claimed. A single-page app answers
 * every unknown path with its shell, which is correct for a person following a link and
 * wrong for a client calling an endpoint that does not exist: `GET /v1/typo` must stay a
 * JSON 404, not 200 and a page.
 */

import { createReadStream, statSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { dirname, join, normalize, resolve, sep } from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';

import type { Hono } from 'hono';

import type { AppEnv } from './context.js';

/**
 * Paths that belong to the API, and can never fall through to the page shell.
 *
 * Stated as a list rather than derived from the router because Hono cannot be asked
 * "would anything have matched this": by the time the fallback runs, a request for a
 * route that exists and one for a route that does not look identical.
 */
const API_PREFIXES = ['/v1', '/oauth', '/mcp', '/health', '/.well-known'];

const CONTENT_TYPES = new Map<string, string>([
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.mjs', 'text/javascript; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.svg', 'image/svg+xml'],
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.webp', 'image/webp'],
  ['.avif', 'image/avif'],
  ['.ico', 'image/x-icon'],
  ['.woff', 'font/woff'],
  ['.woff2', 'font/woff2'],
  ['.txt', 'text/plain; charset=utf-8'],
  ['.webmanifest', 'application/manifest+json'],
  ['.map', 'application/json; charset=utf-8'],
]);

function contentType(path: string): string {
  const dot = path.lastIndexOf('.');
  if (dot === -1) return 'application/octet-stream';
  return CONTENT_TYPES.get(path.slice(dot).toLowerCase()) ?? 'application/octet-stream';
}

/**
 * Where the built browser app is, if it is anywhere.
 *
 * `WEB_DIST` wins, so a container can put the bundle where it likes. Otherwise the
 * onboarding app's own `dist` next to this package, which is what makes `pnpm build &&
 * pnpm dev` serve the login page without a second variable to remember.
 *
 * Returns `null` rather than throwing when there is no build: running the API with no
 * browser app is a supported way to work, and every test does it.
 *
 * Synchronous because it is read once, at boot, by `loadConfigFromEnv`.
 */
export function resolveWebDist(
  env: Record<string, string | undefined> = process.env,
): string | null {
  const candidates = env.WEB_DIST
    ? [resolve(env.WEB_DIST)]
    : [resolve(packageRoot(), '..', 'onboarding', 'dist')];

  for (const candidate of candidates) {
    try {
      if (statSync(join(candidate, 'index.html')).isFile()) return candidate;
    } catch {
      // No build there. Next candidate, or none.
    }
  }
  return null;
}

function packageRoot(): string {
  // `src/web-app.ts` → `apps/rest`. tsx runs from source, so there is no `dist` step to
  // account for here; if one is ever added this is the single line that moves.
  return resolve(dirname(fileURLToPath(import.meta.url)), '..');
}

/**
 * Resolves a request path to a file inside `dist`, or `null`.
 *
 * Exported because path traversal is the one thing here worth testing directly: the
 * check is that the resolved path is still under `dist`, not that the request looked
 * innocent. `%2e%2e%2f` has already been decoded by the time a path reaches us, and a
 * rule written against `..` in the raw URL would miss it.
 */
export function resolveAsset(dist: string, requestPath: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(requestPath);
  } catch {
    return null;
  }
  if (decoded.includes('\0')) return null;

  const candidate = resolve(join(dist, normalize(decoded)));
  const root = resolve(dist);
  return candidate === root || candidate.startsWith(root + sep) ? candidate : null;
}

export function isApiPath(path: string): boolean {
  return API_PREFIXES.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
}

async function fileResponse(path: string, cacheControl: string): Promise<Response | null> {
  let size: number;
  try {
    const info = await stat(path);
    if (!info.isFile()) return null;
    size = info.size;
  } catch {
    return null;
  }

  return new Response(Readable.toWeb(createReadStream(path)) as ReadableStream, {
    headers: {
      'content-type': contentType(path),
      'content-length': String(size),
      'cache-control': cacheControl,
    },
  });
}

/**
 * Mounts the browser app over everything the API did not claim.
 *
 * Call after every API route and before `notFound`. Assets are content-hashed by Vite,
 * so they are immutable; the shell never is, because the next deploy changes which
 * hashed bundle it points at.
 */
export function mountWebApp(app: Hono<AppEnv>, input: { dist: string }): void {
  const dist = resolve(input.dist);
  const shell = join(dist, 'index.html');

  app.get('*', async (c, next) => {
    const path = c.req.path;
    if (isApiPath(path)) return next();

    const asset = resolveAsset(dist, path);
    if (asset && asset !== shell) {
      const immutable = path.startsWith('/assets/');
      const found = await fileResponse(
        asset,
        immutable ? 'public, max-age=31536000, immutable' : 'public, max-age=300',
      );
      if (found) return found;
    }

    // The shell, for every path the app routes itself: `/login`, `/connect`,
    // `/invite/<token>`. `no-cache` rather than `no-store` — it revalidates, so a
    // person on a slow connection still gets a conditional request rather than a
    // full download, and never a stale bundle reference.
    const page = await fileResponse(shell, 'no-cache');
    return page ?? next();
  });
}
