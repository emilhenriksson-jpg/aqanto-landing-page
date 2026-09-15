/**
 * The browser app served from the API origin.
 *
 * The cases worth writing are the boundary, not the happy path: a single-page app
 * answers every unknown path with its shell, and mounting one over an API is how
 * `GET /v1/typo` quietly becomes 200 and a page instead of a JSON 404. A client that
 * gets HTML where it expected an error does not fail — it parses nothing, finds
 * nothing, and reports that the room is empty.
 */

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { loadConfigFromEnv } from './config.js';
import type { AppEnv } from './context.js';
import {
  AUTH_APP_ROUTES,
  isApiPath,
  APEX_ROOT_ROUTES,
  mountWebApp,
  ownsPath,
  PRODUCT_APP_ROUTES,
  resolveAsset,
  resolveWebDist,
} from './web-app.js';

let dist: string;
let productDist: string;

beforeAll(() => {
  dist = mkdtempSync(join(tmpdir(), 'photographic-web-'));
  productDist = mkdtempSync(join(tmpdir(), 'photographic-product-'));
  mkdirSync(join(productDist, 'assets'), { recursive: true });
  writeFileSync(
    join(productDist, 'index.html'),
    '<!doctype html><div id="root" data-app="product-bundle"></div>',
  );
  mkdirSync(join(dist, 'assets'), { recursive: true });
  writeFileSync(
    join(dist, 'index.html'),
    '<!doctype html><div id="root" data-app="onboarding-bundle"></div>',
  );
  writeFileSync(join(dist, 'assets', 'app-abc123.js'), 'export const x = 1;\n');
  writeFileSync(join(dist, 'secret-sibling.txt'), 'not under dist in spirit');
});

afterAll(() => {
  rmSync(dist, { recursive: true, force: true });
  rmSync(productDist, { recursive: true, force: true });
});

function app(): Hono<AppEnv> {
  const instance = new Hono<AppEnv>();
  instance.get('/health', (c) => c.json({ ok: true }));
  instance.get('/v1/rooms', (c) => c.json({ rooms: [] }));
  mountWebApp(instance, { name: 'onboarding', dist, routes: AUTH_APP_ROUTES });
  instance.notFound((c) => c.json({ error: { code: 'not_found' } }, 404));
  return instance;
}

describe('serving the browser app from the API origin', () => {
  it('answers a page route with the shell', async () => {
    const response = await app().request('/login?auth_request=abc');

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/html');
    expect(await response.text()).toContain('id="root"');
  });

  it('serves a hashed asset as immutable', async () => {
    const response = await app().request('/assets/app-abc123.js');

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/javascript');
    expect(response.headers.get('cache-control')).toContain('immutable');
  });

  it('never caches the shell, which names the bundle of the moment', async () => {
    const response = await app().request('/login');

    expect(response.headers.get('cache-control')).toBe('no-cache');
  });

  it('leaves API routes alone', async () => {
    const response = await app().request('/v1/rooms');

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ rooms: [] });
  });

  it('keeps an unknown API path a JSON 404 rather than the shell', async () => {
    for (const path of ['/v1/typo', '/oauth/typo', '/mcp/typo', '/.well-known/typo']) {
      const response = await app().request(path);

      expect(response.status, path).toBe(404);
      expect(response.headers.get('content-type'), path).toContain('application/json');
    }
  });

  it('does not shadow a prefix that merely starts with an API path', async () => {
    // `/v1x` is not `/v1`. It is also not a route any app declares, so it is a 404 —
    // the point being that it is not treated as an API path on its way there.
    expect(isApiPath('/v1x')).toBe(false);

    const response = await app().request('/v1x');
    expect(response.status).toBe(404);
  });

  /**
   * The regression this file now exists to prevent.
   *
   * An open catch-all made every unclaimed path answer `200` with a shell, so
   * `GET /kalender` looked served while the app that renders it was not in the image at
   * all — and a path nobody had ever routed looked served too. A status code stopped
   * being evidence. These assert the boundary in both directions.
   */
  it('refuses a path no app declares, rather than answering with a shell', async () => {
    for (const path of ['/nonsense', '/kalender', '/rum', '/totally-made-up-xyz']) {
      const response = await app().request(path);

      expect(response.status, path).toBe(404);
      expect(response.headers.get('content-type'), path).toContain('application/json');
    }
  });

  it('serves each app only over the routes it declares', async () => {
    const instance = new Hono<AppEnv>();
    mountWebApp(
      instance,
      { name: 'onboarding', dist, routes: AUTH_APP_ROUTES },
      { name: 'web', dist: productDist, routes: PRODUCT_APP_ROUTES },
    );
    instance.notFound((c) => c.json({ error: { code: 'not_found' } }, 404));

    // Each bundle is identifiable, so this asserts *which* app answered rather than
    // that something did.
    const auth = await instance.request('/login?auth_request=abc');
    expect(await auth.text()).toContain('onboarding-bundle');

    const product = await instance.request('/kalender');
    expect(await product.text()).toContain('product-bundle');

    expect((await instance.request('/nonsense')).status).toBe(404);
  });
});

/**
 * The apex and `mcp.` disagree about `/` and about nothing else.
 *
 * Asserted on which bundle answered, not on the status code. A 200 was the evidence that
 * hid the missing product app for a day: the onboarding catch-all answered every
 * unclaimed path with its own shell, so a nonsense path looked served too.
 */
describe('one process, two hostnames', () => {
  const APEX = 'photographic.space';

  function bothHosts(): Hono<AppEnv> {
    const instance = new Hono<AppEnv>();
    mountWebApp(
      instance,
      { name: 'onboarding-apex', dist, routes: APEX_ROOT_ROUTES, hosts: [APEX] },
      { name: 'onboarding', dist, routes: AUTH_APP_ROUTES },
      { name: 'web', dist: productDist, routes: PRODUCT_APP_ROUTES },
    );
    instance.notFound((c) => c.json({ error: { code: 'not_found' } }, 404));
    return instance;
  }

  async function get(path: string, host: string): Promise<Response> {
    return bothHosts().request(path, { headers: { host } });
  }

  it('serves the auth bundle at / on the apex', async () => {
    const response = await get('/', APEX);

    expect(response.status).toBe(200);
    expect(await response.text()).toContain('onboarding-bundle');
  });

  it('still serves the product at / on the mcp hostname', async () => {
    const response = await get('/', 'mcp.photographic.space');

    expect(response.status).toBe(200);
    expect(await response.text()).toContain('product-bundle');
  });

  it('serves the product screens on both hostnames', async () => {
    for (const host of [APEX, 'mcp.photographic.space']) {
      const response = await get('/kalender', host);
      expect(await response.text()).toContain('product-bundle');
    }
  });

  it('keeps /login on the auth bundle from either name, since OAuth depends on it', async () => {
    for (const host of [APEX, 'mcp.photographic.space']) {
      const response = await get('/login?auth_request=abc', host);
      expect(await response.text()).toContain('onboarding-bundle');
    }
  });

  it('still refuses a route nobody declares, on either name', async () => {
    for (const host of [APEX, 'mcp.photographic.space']) {
      expect((await get('/nonsense', host)).status).toBe(404);
    }
  });

  // `Host` carries the port when it is non-default. Comparing it against a bare hostname
  // without stripping that would mean the apex rule silently never fires locally.
  it('matches the host regardless of port or case', async () => {
    for (const host of [`${APEX}:8787`, APEX.toUpperCase()]) {
      const response = await get('/', host);
      expect(await response.text()).toContain('onboarding-bundle');
    }
  });

  it('leaves a mount with no host filter answering on an unrelated name', async () => {
    const response = await get('/kalender', 'photographic.fly.dev');

    expect(await response.text()).toContain('product-bundle');
  });
});

describe('ownsPath', () => {
  it("matches a declared route and the paths beneath it", () => {
    expect(ownsPath(['/kalender'], '/kalender')).toBe(true);
    expect(ownsPath(['/kalender'], '/kalender/2026-10-15')).toBe(true);
    expect(ownsPath(['/kalender'], '/kalendarium')).toBe(false);
  });

  it("does not let '/' own everything, which is the open catch-all again", () => {
    expect(ownsPath(['/'], '/')).toBe(true);
    expect(ownsPath(['/'], '/anything')).toBe(false);
  });
});

describe('resolveAsset', () => {
  it('resolves a path inside the build directory', () => {
    expect(resolveAsset('/srv/dist', '/assets/app.js')).toBe(resolve('/srv/dist/assets/app.js'));
  });

  it('keeps traversal inside the build directory', () => {
    // A request path is always absolute, so `normalize` clamps leading `..` rather than
    // walking above the root — and the containment check catches anything it does not.
    // Asserted on the decoded path, because `%2e%2e%2f` is already `../` by the time it
    // reaches us and a rule written against the raw URL would miss it.
    for (const path of ['/../secret', '/assets/../../etc/passwd', '/a/b/../../../..', '/%2e%2e/x']) {
      const resolved = resolveAsset('/srv/dist', path);

      expect(resolved, path).not.toBeNull();
      expect(
        resolved === resolve('/srv/dist') || resolved?.startsWith(`${resolve('/srv/dist')}/`),
        path,
      ).toBe(true);
    }
  });

  it('refuses a path with a null byte', () => {
    expect(resolveAsset('/srv/dist', '/assets/app.js\0.png')).toBeNull();
  });

  it('refuses a path that cannot be decoded', () => {
    expect(resolveAsset('/srv/dist', '/%')).toBeNull();
  });
});

describe('reading outside the build directory', () => {
  it('answers with the shell rather than a file from the host', async () => {
    const response = await app().request('/../../../../../../etc/passwd');

    // Never a file from the host. It is now a 404 rather than the shell, because no app
    // declares that route — which is a better answer to the same question.
    expect(response.status).toBe(404);
    expect(response.headers.get('content-type')).toContain('application/json');
  });
});

describe('isApiPath', () => {
  it('claims the API surfaces and nothing that merely looks like them', () => {
    expect(isApiPath('/v1')).toBe(true);
    expect(isApiPath('/v1/rooms')).toBe(true);
    expect(isApiPath('/mcp')).toBe(true);
    expect(isApiPath('/.well-known/oauth-authorization-server')).toBe(true);
    expect(isApiPath('/login')).toBe(false);
    expect(isApiPath('/v1x')).toBe(false);
  });
});

describe('config', () => {
  it('puts the login page on the API origin when we serve the app ourselves', () => {
    const config = loadConfigFromEnv({
      PUBLIC_URL: 'https://example.trycloudflare.com',
      WEB_DIST: dist,
    });

    expect(config.webDist).toBe(resolve(dist));
    expect(config.webUrl).toBe('https://example.trycloudflare.com');
  });

  it('keeps WEB_ORIGIN authoritative when the pages really are published elsewhere', () => {
    const config = loadConfigFromEnv({
      PUBLIC_URL: 'https://api.example.com',
      WEB_DIST: dist,
      WEB_ORIGIN: 'https://app.example.com',
    });

    expect(config.webUrl).toBe('https://app.example.com');
  });

  it('serves no app, and points elsewhere, when there is no build', () => {
    const config = loadConfigFromEnv({
      PUBLIC_URL: 'https://api.example.com',
      WEB_DIST: join(dist, 'nope'),
    });

    expect(config.webDist).toBeNull();
    expect(config.webUrl).toBe('http://localhost:5174');
  });

  it('can be told to serve nothing even where a build exists', () => {
    expect(resolveWebDist({ WEB_DIST: dist })).toBe(resolve(dist));
    expect(loadConfigFromEnv({ WEB_DIST: '' }).webDist).toBeNull();
  });
});
