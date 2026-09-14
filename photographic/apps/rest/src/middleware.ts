/**
 * Middleware.
 *
 * The ordering in `app.ts` matters and is not arbitrary: request context, then CORS,
 * then rate limiting, then auth, then the route. Rate limiting sits in front of auth so
 * that an unauthenticated flood is rejected without a token lookup per request.
 */

import { randomUUID } from 'node:crypto';

import type { Actor } from '@photographic/core';
import { NotPermittedError, PhotographicError } from '@photographic/core';
import type { MiddlewareHandler } from 'hono';

import type { RestConfig, RateLimitRule } from './config.js';
import type { AppContext, AppEnv } from './context.js';
import { RateLimitError, RequestValidationError } from './errors.js';
import type { Logger } from './logger.js';
import type { OAuthProvider } from './oauth-contract.js';

export function requestContext(input: {
  config: RestConfig;
  logger: Logger;
  services: AppEnv['Variables']['services'];
}): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    // Honour an inbound id so a trace survives the hop from the web app, but never
    // trust its shape: it ends up in every log line for this request.
    const inbound = c.req.header('x-request-id');
    const requestId = inbound && /^[\w-]{1,64}$/.test(inbound) ? inbound : randomUUID();

    c.set('requestId', requestId);
    c.set('startedAt', Date.now());
    c.set('config', input.config);
    c.set('services', input.services);
    c.set('logger', input.logger.child({ requestId }));
    c.set('actor', null);
    c.header('x-request-id', requestId);

    await next();
  };
}

export function accessLog(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    await next();

    const logger = c.get('logger');
    // Path template rather than the concrete path: a short id in a log line is a
    // pointer to a memory, and the logger strips bodies for the same reason.
    logger.info('request', {
      method: c.req.method,
      route: c.req.routePath,
      status: c.res.status,
      durationMs: Date.now() - c.get('startedAt'),
      personId: c.get('actor')?.personId ?? null,
      agentClient: c.get('actor')?.agentClient ?? null,
    });
  };
}

export function cors(config: RestConfig): MiddlewareHandler<AppEnv> {
  const allowed = new Set(config.corsOrigins);

  return async (c, next) => {
    const origin = c.req.header('origin');

    // Echoed only when it matches exactly. No wildcard, because these endpoints carry
    // bearer tokens and a wildcard plus credentials is how a memory layer becomes
    // readable by any page the person happens to have open.
    if (origin && allowed.has(origin)) {
      c.header('access-control-allow-origin', origin);
      c.header('access-control-allow-credentials', 'true');
      c.header('vary', 'origin');
    }

    if (c.req.method === 'OPTIONS') {
      c.header('access-control-allow-methods', 'GET,POST,PATCH,DELETE,OPTIONS');
      c.header('access-control-allow-headers', 'authorization,content-type,x-request-id');
      c.header('access-control-max-age', '600');
      return c.body(null, 204);
    }

    await next();
  };
}

/**
 * Turns a bearer token into an actor, and refuses to do it any other way.
 *
 * Nothing else in the system may construct an `Actor`. Not a header, not a body field,
 * not a path parameter. Every port takes the actor as its first argument and resolves
 * permissions from it, so this function is the single place where "who is calling"
 * is decided — and therefore the only place it can be decided wrongly.
 */
export function authenticate(oauth: OAuthProvider, options: { required: boolean } = { required: true }): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const header = c.req.header('authorization');
    const token = header?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim();

    if (!token) {
      if (options.required) return unauthorized(c, 'Saknar access token.');
      return next();
    }

    const claims = await oauth.introspect(token);
    if (!claims) {
      if (options.required) return unauthorized(c, 'Ogiltig eller utgången access token.');
      return next();
    }

    if (claims.expiresAt && claims.expiresAt <= new Date()) {
      if (options.required) return unauthorized(c, 'Access token har gått ut.');
      return next();
    }

    const actor: Actor = {
      personId: claims.personId,
      // A token issued without a recorded surface reports as `api` rather than
      // guessing from a user agent. A wrong attribution in the history feed is worse
      // than an honest "api", because the person cannot tell it is wrong.
      agentClient: claims.agentClient ?? 'api',
      sessionId: claims.sessionId,
      roomScope: claims.roomScope,
    };

    c.set('actor', actor);
    await next();
  };
}

function unauthorized(c: Parameters<MiddlewareHandler<AppEnv>>[0], detail: string) {
  // RFC 9728: this header is how an MCP client discovers where to authenticate, so a
  // 401 without it turns a recoverable "please log in" into a dead end.
  const config = c.get('config');
  c.header(
    'www-authenticate',
    `Bearer realm="photographic", resource_metadata="${config.publicUrl}/.well-known/oauth-protected-resource"`,
  );
  return c.json({ error: { code: 'unauthorized', message: detail } }, 401);
}

interface Bucket {
  count: number;
  resetAt: number;
}

/**
 * Fixed-window counting, in memory.
 *
 * Deliberately per-process and therefore approximate: with several instances the
 * effective limit is the configured one times the instance count. That is acceptable
 * because this exists to stop runaway loops and casual scraping, not to meter billing,
 * and a shared store would put a Redis round trip in front of every request.
 */
export function rateLimit(input: {
  rule: RateLimitRule;
  key: (c: Parameters<MiddlewareHandler<AppEnv>>[0]) => string;
}): MiddlewareHandler<AppEnv> {
  const buckets = new Map<string, Bucket>();

  return async (c, next) => {
    const now = Date.now();
    const key = input.key(c);

    // Swept opportunistically rather than on a timer: a timer would keep the process
    // alive and this map only grows while requests are arriving anyway.
    if (buckets.size > 10_000) {
      for (const [k, bucket] of buckets) if (bucket.resetAt <= now) buckets.delete(k);
    }

    const bucket = buckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
      buckets.set(key, { count: 1, resetAt: now + input.rule.windowMs });
      return next();
    }

    bucket.count += 1;
    if (bucket.count > input.rule.limit) {
      throw new RateLimitError(Math.ceil((bucket.resetAt - now) / 1000));
    }

    return next();
  };
}

export function clientAddress(c: Parameters<MiddlewareHandler<AppEnv>>[0]): string {
  const forwarded = c.req.header('x-forwarded-for');
  if (forwarded) return forwarded.split(',')[0]!.trim();
  return c.req.header('fly-client-ip') ?? c.req.header('x-real-ip') ?? 'unknown';
}

/**
 * The error boundary.
 *
 * Registered with `app.onError`, and it has to be: in Hono a middleware that wraps
 * `await next()` in try/catch never sees an error thrown by a handler. The framework
 * catches it inside its own dispatch and routes it straight to `onError`, so a
 * middleware-shaped boundary looks correct, typechecks, and silently turns every
 * domain error into a 500 — including turning a 404 permission denial into a 500, which
 * both leaks differently and breaks clients that branch on the status.
 *
 * Two things it must get right. A `NotPermittedError` renders as 404 and is padded to a
 * floor, because the status code and the response time are both channels that leak
 * whether a room exists. And an unexpected error never reaches the client as a message:
 * a stack trace or a driver error string is exactly where internal detail escapes.
 */
export async function handleError(error: Error, c: AppContext): Promise<Response> {
  const logger = c.get('logger');
  const config = c.get('config');

  if (error instanceof RequestValidationError) {
    return c.json(
      { error: { code: 'invalid_request', message: error.message, issues: error.issues } },
      400,
    );
  }

  if (error instanceof RateLimitError) {
    c.header('retry-after', String(error.retryAfterSeconds));
    return c.json({ error: { code: 'rate_limited', message: error.message } }, 429);
  }

  if (error instanceof PhotographicError) {
    if (error instanceof NotPermittedError || error.status === 404) {
      await padTo(c.get('startedAt'), config.notFoundFloorMs);
    }
    return c.json({ error: { code: error.code, message: error.message } }, error.status as 400);
  }

  logger.error('unhandled_error', {
    route: c.req.routePath,
    error: error instanceof Error ? error.message : String(error),
  });

  return c.json({ error: { code: 'internal_error', message: 'Något gick fel. Försök igen.' } }, 500);
}

async function padTo(startedAt: number, floorMs: number): Promise<void> {
  const remaining = floorMs - (Date.now() - startedAt);
  if (remaining > 0) await new Promise((resolve) => setTimeout(resolve, remaining));
}
