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
  return distIn(env.WEB_DIST, resolve(packageRoot(), '..', 'onboarding', 'dist'));
}

/**
 * Where the built product app is — `apps/web`, the screens a person actually uses.
 *
 * A sibling of `resolveWebDist` rather than a second candidate inside it, because the
 * two are mounted at the same time over different paths and "which bundle is missing"
 * has to be answerable separately. `APP_DIST` mirrors `WEB_DIST`, including the
 * empty-string escape hatch for serving nothing where a build exists.
 */
export function resolveAppDist(
  env: Record<string, string | undefined> = process.env,
): string | null {
  return distIn(env.APP_DIST, resolve(packageRoot(), '..', 'web', 'dist'));
}

function distIn(override: string | undefined, fallback: string): string | null {
  const candidate = override ? resolve(override) : fallback;
  try {
    return statSync(join(candidate, 'index.html')).isFile() ? candidate : null;
  } catch {
    return null;
  }
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
 * What each browser app can actually render.
 *
 * Enumerated, and that is the whole point of this file's shape. A single-page app
 * answers *any* path with its shell, so a mount with an open catch-all reports `200` for
 * routes it cannot render — which is not a cosmetic wrong answer. It is indistinguishable
 * from the app working: `GET /kalender` returned `200` and the right content type while
 * the calendar was not being served at all, and the only reason anybody noticed was a
 * person opening the page and seeing the wrong thing. A nonsense path returned `200` too.
 *
 * So the rule here is that a shell is served only for a path the app routes, and
 * anything else falls through to the JSON 404. These lists are the source of truth for
 * that, they are exported so a test can read them, and adding a screen means adding its
 * route here.
 */

/** `apps/onboarding` — the auth surface. Keep this authoritative; the OAuth round trip
 * depends on `/login` in particular. `?auth_request=` arrives on `/login`.
 *
 * `/start` is the page for someone who has heard of Photografic and has no account yet.
 * It lives with the auth surface because that is where every way in already is, and it is
 * the page the apex hostname should serve — see `apps/onboarding/src/screens/Landing.tsx`. */
export const AUTH_APP_ROUTES = ['/login', '/connect', '/invite', '/start'] as const;

/**
 * `apps/web` — the product. Mirrors its router in `apps/web/src/App.tsx`.
 *
 * `/konto` covers `/konto/export` and `/konto/radera` by prefix. `/i` is gone: it was a
 * second invite landing whose join button only set React state, and the short link now
 * redirects to the one that accepts invites for real.
 */
export const PRODUCT_APP_ROUTES = [
  '/',
  '/chatt',
  '/personligt',
  '/rum',
  '/klienter',
  '/godkann',
  '/fraga',
  '/papperskorg',
  '/historik',
  '/kompass',
  '/konto',
  '/kalender',
] as const;

/**
 * What the apex serves from the auth bundle.
 *
 * `photographic.space` is the name a person types, so `/` there is the front door rather
 * than the product's home — a signed-out visitor should meet sign-in, not a screen that
 * needs a session it has not got. `mcp.photographic.space` keeps serving the product at
 * `/`, because clients are configured against it and nothing about that name moves.
 *
 * `/start`, the public page, arrives with the front-end branch that builds it; adding it
 * here before the route exists would claim a path the bundle cannot render, which is the
 * exact failure the route lists were introduced to stop.
 */
export const APEX_ROOT_ROUTES = ['/'] as const;

export interface SpaMount {
  /** Named for the boot log, so which bundle answers which path is visible at startup. */
  name: string;
  dist: string;
  routes: readonly string[];
  /**
   * Hostnames this mount answers on. Absent means every host, which is what every mount
   * did before the apex existed and is still right for anything served identically on
   * both names.
   *
   * Present, it is how `photographic.space` and `mcp.photographic.space` can disagree
   * about one path without disagreeing about the rest: the apex serves the auth bundle at
   * `/` while `mcp` serves the product there, and both serve everything else the same way.
   */
  hosts?: readonly string[];
}

/**
 * The hostname of the request, without the port, lowercased.
 *
 * `Host` carries the port when it is non-default, and a comparison against a bare
 * hostname would silently never match in local development on `:8787`.
 *
 * The header wins and the request URL is the fallback, because the two disagree in
 * different directions depending on how the request was built: behind Fly the header is
 * authoritative, while a request constructed from an absolute URL may carry no `Host`
 * header at all and hold the name only in the URL. Reading one and not the other makes a
 * host rule that quietly never matches — which is worse than a wrong rule, because a rule
 * that never fires looks like a rule that is satisfied.
 */
export function requestHost(header: string | undefined, url?: string): string {
  const fromHeader = (header ?? '').toLowerCase().replace(/:\d+$/, '');
  if (fromHeader) return fromHeader;

  try {
    return url ? new URL(url).hostname.toLowerCase() : '';
  } catch {
    return '';
  }
}

function servesHost(mount: SpaMount, host: string): boolean {
  return mount.hosts === undefined || mount.hosts.includes(host);
}

/**
 * Whether one of `routes` owns `path`.
 *
 * `'/'` matches only itself — as a prefix it would own everything and put the open
 * catch-all straight back.
 */
export function ownsPath(routes: readonly string[], path: string): boolean {
  return routes.some((route) =>
    route === '/' ? path === '/' : path === route || path.startsWith(`${route}/`),
  );
}

/**
 * Mounts one or more browser apps over the paths the API did not claim.
 *
 * Call after every API route and before `notFound`. Assets are content-hashed by Vite,
 * so they are immutable; a shell never is, because the next deploy changes which hashed
 * bundle it points at.
 *
 * Both apps emit their assets under `/assets/`, so a request for one is resolved by
 * trying each bundle in turn. That is safe rather than lucky: Vite derives the filename
 * from a hash of the contents, so two bundles agreeing on a name agree on the bytes, and
 * disagreeing on the bytes means disagreeing on the name.
 */
export function mountWebApp(app: Hono<AppEnv>, ...mounts: readonly SpaMount[]): void {
  const resolved = mounts.map((mount) => ({
    ...mount,
    dist: resolve(mount.dist),
    shell: join(resolve(mount.dist), 'index.html'),
  }));

  app.get('*', async (c, next) => {
    const path = c.req.path;
    if (isApiPath(path)) return next();

    const host = requestHost(c.req.header('host'), c.req.url);

    // Assets are not host-filtered on purpose. They are content-hashed, so a name
    // identifies bytes rather than an app, and a bundle the apex serves may legitimately
    // reference a chunk first emitted by the other one.
    for (const mount of resolved) {
      const asset = resolveAsset(mount.dist, path);
      if (!asset || asset === mount.shell) continue;

      const found = await fileResponse(
        asset,
        path.startsWith('/assets/')
          ? 'public, max-age=31536000, immutable'
          : 'public, max-age=300',
      );
      if (found) return found;
    }

    for (const mount of resolved) {
      if (!servesHost(mount, host)) continue;
      if (!ownsPath(mount.routes, path)) continue;

      // `no-cache` rather than `no-store` — it revalidates, so a person on a slow
      // connection still gets a conditional request rather than a full download, and
      // never a stale bundle reference.
      const page = await fileResponse(mount.shell, 'no-cache');
      if (page) return page;
    }

    // Routed by nobody. A JSON 404 is the honest answer, and it is what makes the two
    // lists above meaningful rather than decorative.
    return next();
  });
}
