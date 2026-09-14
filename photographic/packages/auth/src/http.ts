/**
 * The plain request/response shapes every handler in this package speaks.
 *
 * This package deliberately has no HTTP framework dependency: `apps/rest` owns hono and
 * adapts it to these two types. That keeps the authorization server testable without a
 * server socket, and keeps a framework upgrade out of the security-critical code.
 */

export interface AuthRequest {
  method: string;
  /** Absolute URL, or a path with query string. Both are accepted. */
  url: string;
  /** Header names must be lower-cased by the adapter. */
  headers: Record<string, string | undefined>;
  /**
   * Parsed form body for `application/x-www-form-urlencoded`, or the raw string, or a
   * JSON object for `application/json` endpoints such as DCR.
   */
  body?: Record<string, unknown> | string | undefined;
  /** Client address, used only for rate limiting. */
  ip?: string | undefined;
}

export interface AuthResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

const DUMMY_ORIGIN = 'http://internal.invalid';

export function requestUrl(req: AuthRequest): URL {
  return new URL(req.url, DUMMY_ORIGIN);
}

export function queryParams(req: AuthRequest): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of requestUrl(req).searchParams) {
    // First occurrence wins; a duplicated OAuth parameter is an invalid request and the
    // callers below reject it rather than guessing.
    if (!(key in out)) out[key] = value;
  }
  return out;
}

/** True when a parameter appears more than once, which OAuth 2.1 forbids. */
export function hasDuplicateParams(req: AuthRequest): boolean {
  const seen = new Set<string>();
  for (const [key] of requestUrl(req).searchParams) {
    if (seen.has(key)) return true;
    seen.add(key);
  }
  return false;
}

export function formParams(req: AuthRequest): Record<string, string> {
  const body = req.body;
  if (body === undefined || body === null) return {};
  if (typeof body === 'string') {
    const out: Record<string, string> = {};
    for (const [key, value] of new URLSearchParams(body)) {
      if (!(key in out)) out[key] = value;
    }
    return out;
  }
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(body)) {
    if (typeof value === 'string') out[key] = value;
    else if (typeof value === 'number' || typeof value === 'boolean') out[key] = String(value);
  }
  return out;
}

export function jsonBody(req: AuthRequest): Record<string, unknown> {
  const body = req.body;
  if (body === undefined || body === null) return {};
  if (typeof body === 'string') {
    if (body.trim() === '') return {};
    try {
      const parsed: unknown = JSON.parse(body);
      return isPlainObject(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }
  return body;
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const NO_STORE = {
  'cache-control': 'no-store',
  pragma: 'no-cache',
} as const;

export function json(status: number, payload: unknown, headers: Record<string, string> = {}): AuthResponse {
  return {
    status,
    headers: { 'content-type': 'application/json', ...NO_STORE, ...headers },
    body: JSON.stringify(payload),
  };
}

/** Metadata documents are public and cacheable; everything else is `no-store`. */
export function cacheableJson(payload: unknown, maxAgeSeconds = 3600): AuthResponse {
  return {
    status: 200,
    headers: {
      'content-type': 'application/json',
      'cache-control': `public, max-age=${maxAgeSeconds}`,
    },
    body: JSON.stringify(payload),
  };
}

export function redirect(location: string): AuthResponse {
  return {
    status: 302,
    headers: { location, ...NO_STORE },
    body: '',
  };
}

export function noContent(): AuthResponse {
  return { status: 200, headers: { ...NO_STORE }, body: '' };
}

export interface BasicCredentials {
  clientId: string;
  clientSecret: string;
}

export function parseBasicAuth(req: AuthRequest): BasicCredentials | null {
  const header = req.headers['authorization'];
  if (!header) return null;
  const [scheme, encoded] = header.split(' ');
  if (!scheme || scheme.toLowerCase() !== 'basic' || !encoded) return null;
  let decoded: string;
  try {
    decoded = Buffer.from(encoded, 'base64').toString('utf8');
  } catch {
    return null;
  }
  const separator = decoded.indexOf(':');
  if (separator < 0) return null;
  // RFC 6749 appendix B: both halves are form-urlencoded inside Basic auth.
  return {
    clientId: decodeURIComponent(decoded.slice(0, separator).replace(/\+/g, ' ')),
    clientSecret: decodeURIComponent(decoded.slice(separator + 1).replace(/\+/g, ' ')),
  };
}

export function bearerToken(req: AuthRequest): string | null {
  const header = req.headers['authorization'];
  if (!header) return null;
  const [scheme, value] = header.split(' ');
  if (!scheme || scheme.toLowerCase() !== 'bearer' || !value) return null;
  return value.trim() === '' ? null : value.trim();
}
