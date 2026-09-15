/**
 * Configuration for the HTTP API.
 *
 * Everything has a default that works on a laptop with nothing set, because a new
 * contributor running `pnpm dev` should not have to guess at fifteen variables.
 */

import type { LogLevel } from './logger.js';
import { resolveAppDist, resolveWebDist } from './web-app.js';

export interface RestConfig {
  /** Interface and port the node server binds to. */
  host: string;
  port: number;

  /**
   * Externally reachable origin. Used as the OAuth issuer, the protected-resource
   * identifier and the base of invite URLs, so it has to be the URL clients actually
   * call, not the bind address.
   */
  publicUrl: string;

  /**
   * Where the browser-facing app lives.
   *
   * Separate from `publicUrl` because two of the URLs this process hands out are pages a
   * person opens, not endpoints a client calls: the login page an authorization request
   * redirects to, and the connect page a QR code points at. Deriving those from the API
   * origin sends people to an origin that serves no HTML, and the failure only shows up
   * in a browser — never in a test that checks the redirect happened.
   *
   * The two coincide when this process serves the browser app itself (see `webDist`),
   * which is what a single public hostname requires.
   */
  webUrl: string;

  /**
   * The built auth app (`apps/onboarding`), served from this origin, or `null` for none.
   *
   * Set by `loadConfigFromEnv`; `createApp` never looks at the filesystem itself.
   */
  webDist: string | null;

  /**
   * The built product app (`apps/web`) — Rum, Kalender, Godkänn, Papperskorg, Historik,
   * Fråga, Kompass — or `null` for none.
   *
   * Separate from `webDist` because they are mounted together over different paths, and
   * because the two go missing for different reasons: this one is the product being
   * unreachable, that one is the OAuth flow dead-ending after its redirect.
   */
  appDist: string | null;

  environment: 'development' | 'test' | 'production';
  logLevel: LogLevel;

  /** Exactly the origins of our own web and voice apps. No wildcards, ever. */
  corsOrigins: string[];

  /** Hard ceiling for a document upload, enforced while streaming. */
  maxUploadBytes: number;

  /**
   * Every 404 is padded to at least this long. "Exists but you may not see it" and
   * "does not exist" have to be indistinguishable, and response time is a side
   * channel that leaks the difference for free.
   */
  notFoundFloorMs: number;

  /** How long in-flight requests get to finish after SIGTERM. */
  shutdownGraceMs: number;

  rateLimits: RateLimitConfig;
}

export interface RateLimitRule {
  limit: number;
  windowMs: number;
}

export interface RateLimitConfig {
  /** Per person, for anything behind a bearer token. */
  authenticated: RateLimitRule;
  /** Per client address, for everything else. */
  unauthenticated: RateLimitRule;
  /** The unauthenticated invite preview is the one endpoint a stranger can enumerate. */
  invitePreview: RateLimitRule;
  /** OAuth dynamic client registration. Open by design, so metered by address. */
  register: RateLimitRule;
  /**
   * Sign-up, per client address, across both requesting a code and verifying one.
   *
   * Its own rule rather than sharing OAuth registration's, because the two are tuned
   * against different things and will move apart: this one is the only endpoint that
   * sends mail to an address a stranger chose, which is someone else's inbox and
   * someone else's sending reputation. The per-address budget in
   * `@photographic/connect` (`MAX_REQUESTS_PER_HOUR`) is the other half — that one stops
   * one inbox being flooded, this one stops one sender walking a list of them.
   */
  signup: RateLimitRule;
}

export const DEFAULT_CONFIG: RestConfig = {
  host: '0.0.0.0',
  port: 8787,
  publicUrl: 'http://localhost:8787',
  // The onboarding app's dev port, which is where the login page lives when this
  // process is not serving it.
  webUrl: 'http://localhost:5174',
  webDist: null,
  appDist: null,
  environment: 'development',
  logLevel: 'info',
  corsOrigins: [
    'http://localhost:3000',
    'http://localhost:5173',
    'http://127.0.0.1:5173',
    'http://localhost:5174',
    'http://127.0.0.1:5174',
  ],
  maxUploadBytes: 25 * 1024 * 1024,
  notFoundFloorMs: 25,
  shutdownGraceMs: 10_000,
  rateLimits: {
    authenticated: { limit: 600, windowMs: 60_000 },
    unauthenticated: { limit: 120, windowMs: 60_000 },
    invitePreview: { limit: 20, windowMs: 60_000 },
    register: { limit: 20, windowMs: 3_600_000 },
    // Covers request and verify together. A person signing up needs two or three calls;
    // five mistyped codes and a resend is still well inside it.
    signup: { limit: 20, windowMs: 3_600_000 },
  },
};

export function resolveConfig(overrides: Partial<RestConfig> = {}): RestConfig {
  return {
    ...DEFAULT_CONFIG,
    ...overrides,
    rateLimits: { ...DEFAULT_CONFIG.rateLimits, ...(overrides.rateLimits ?? {}) },
  };
}

type Env = Record<string, string | undefined>;

export function loadConfigFromEnv(env: Env = process.env): RestConfig {
  const environment = pickEnvironment(env.NODE_ENV);
  const port = int(env.PORT, DEFAULT_CONFIG.port);
  const publicUrl = (env.PUBLIC_URL ?? `http://localhost:${port}`).replace(/\/+$/, '');
  const webDist = env.WEB_DIST === '' ? null : resolveWebDist(env);
  const appDist = env.APP_DIST === '' ? null : resolveAppDist(env);

  // When this process serves the browser app, the login page is on this origin and
  // pointing it at a dev server that is not running is the one way to break a
  // connection that otherwise works. `WEB_ORIGIN` still wins, for the case where the
  // pages really are published somewhere else.
  const webUrl = env.WEB_ORIGIN ?? (webDist ? publicUrl : DEFAULT_CONFIG.webUrl);

  return resolveConfig({
    host: env.HOST ?? DEFAULT_CONFIG.host,
    port,
    publicUrl,
    webUrl: webUrl.replace(/\/+$/, ''),
    webDist,
    appDist,
    environment,
    logLevel: pickLogLevel(env.LOG_LEVEL, environment),
    corsOrigins: list(env.CORS_ORIGINS) ?? defaultCorsOrigins(env),
    maxUploadBytes: int(env.MAX_UPLOAD_BYTES, DEFAULT_CONFIG.maxUploadBytes),
    notFoundFloorMs: int(env.NOT_FOUND_FLOOR_MS, DEFAULT_CONFIG.notFoundFloorMs),
    shutdownGraceMs: int(env.SHUTDOWN_GRACE_MS, DEFAULT_CONFIG.shutdownGraceMs),
  });
}

function defaultCorsOrigins(env: Env): string[] {
  const origins = [env.WEB_ORIGIN, env.VOICE_ORIGIN].filter(
    (value): value is string => typeof value === 'string' && value.length > 0,
  );
  return origins.length > 0 ? origins : DEFAULT_CONFIG.corsOrigins;
}

function pickEnvironment(value: string | undefined): RestConfig['environment'] {
  return value === 'production' || value === 'test' ? value : 'development';
}

function pickLogLevel(value: string | undefined, environment: RestConfig['environment']): LogLevel {
  if (value === 'debug' || value === 'info' || value === 'warn' || value === 'error') return value;
  return environment === 'test' ? 'error' : DEFAULT_CONFIG.logLevel;
}

function int(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function list(value: string | undefined): string[] | undefined {
  if (!value) return undefined;
  const parts = value
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  return parts.length > 0 ? parts : undefined;
}
