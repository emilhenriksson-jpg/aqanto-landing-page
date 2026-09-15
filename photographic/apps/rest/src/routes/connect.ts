/**
 * Sign-up, connecting an AI, and importing what another system already remembers.
 *
 * The handlers themselves live in `@photographic/connect` and take plain objects, so
 * this file is an adapter and nothing else. That split is what lets the sign-up flow be
 * tested without a web framework, and it is why the connect screen's strings live in
 * one place rather than being half in a package and half in a route.
 */

import type { ConnectConfig } from '@photographic/connect';
import {
  handleConnect,
  handleSignupRequest,
  handleSignupVerify,
  handleStartVerification,
  handleVerificationStatus,
  previewImport,
  verifyBreakGlassToken,
  type ConnectDeps,
} from '@photographic/connect';
import type { PersonId } from '@photographic/core';
import { AuthError } from '@photographic/core';
import { Hono } from 'hono';

import type { AppEnv } from '../context.js';
import { importCommitSchema, importPreviewSchema } from '../schemas.js';
import { serialiseProposal } from '../serialise.js';
import { setSessionCookie } from '../session-cookie.js';
import { parseJsonBody } from '../validation.js';
import { getActor, getServices } from './shared.js';

export interface ConnectRouteDeps {
  connect: ConnectDeps;
  config: ConnectConfig;
  /**
   * The key `scripts/break-glass-signin.ts` signs with, from the machine's own
   * environment. Null — the default — means no token verifies, so the endpoint below is
   * mounted but has nothing to accept.
   */
  breakGlassSecret?: string | null;
}

/** The one answer the break-glass exchange ever gives when it will not sign anyone in. */
const BREAK_GLASS_REJECTED =
  'Nödkoden gäller inte. Kör skriptet på maskinen igen för att få en ny.';

/** No token: this is how an account comes to exist in the first place. */
export function publicConnectRoutes(deps: ConnectRouteDeps): Hono<AppEnv> {
  const routes = new Hono<AppEnv>();

  /**
   * Spent tokens, so one is one sign-in.
   *
   * Process-local rather than a table, and that is a real limit worth stating: a restart
   * inside the token's few remaining minutes forgets it. Bounding the reuse window with
   * the TTL rather than with storage is the trade — a table for this would be a schema
   * change on the path that exists for the day the product is already broken, and the
   * event log records every mint and every use either way.
   */
  const spent = new Set<string>();

  routes.post('/signup/request', async (c) => {
    const result = await handleSignupRequest(deps.connect, { body: await body(c) });
    return c.json(result.body as object, result.status as 200);
  });

  routes.post('/signup/verify', async (c) => {
    const result = await handleSignupVerify(deps.connect, { body: await body(c) });

    // The one place a browser session begins, so the one place the cookie is set.
    //
    // The token stays in the response body as well. Nothing is taken away: the
    // onboarding app keeps using it from memory for the rest of the flow, and the
    // acceptance tests and `scripts/demo-web.md` keep working unchanged. What the cookie
    // adds is that the *product* app has a session at all — it reads no token of its own,
    // and same-origin `fetch` sends this without being asked.
    const session = (result.body as { session?: { token?: string; expiresAt?: string } }).session;
    if (result.status === 200 && session?.token) {
      setSessionCookie(c, session.token, {
        publicUrl: c.get('config').publicUrl,
        expiresAt: session.expiresAt ? new Date(session.expiresAt) : null,
      });
    }

    return c.json(result.body as object, result.status as 200);
  });

  /**
   * Trades a token minted on the machine for the ordinary browser session.
   *
   * This is the *using* half of break-glass; the minting half is not reachable from here
   * or from any other request. `scripts/break-glass-signin.ts` runs on the host, signs a
   * token with a secret only the machine can read, and prints a URL. This endpoint checks
   * that signature and nothing else grants it anything.
   *
   * Deliberately not a GET with the token in the path or query. `accessLog` logs the route
   * template rather than the concrete path, but a browser keeps the URL in history and
   * hands it to the next site in `Referer`, and the entire point of this work is to stop
   * shipping credentials somewhere they are read later. The token arrives in a POST body,
   * from the small page at `/nodlage`, which reads it out of the URL fragment — the one
   * part of a URL that is never sent to a server.
   *
   * The session it mints is the ordinary one, from the same issuer sign-up uses, so
   * whatever that issuer becomes — signed, revocable, expiring — this inherits without
   * being touched. The token is not returned in the body: the cookie is `httpOnly` for a
   * reason and a second copy in reach of page script would undo it.
   */
  routes.post('/signup/break-glass', async (c) => {
    const services = getServices(c);
    const payload = (await body(c)) as { token?: unknown };
    const token = typeof payload.token === 'string' ? payload.token : '';

    const claims = verifyBreakGlassToken({ token, secret: deps.breakGlassSecret ?? null });
    // One refusal for every reason, including "break-glass is not configured here". A
    // publicly reachable endpoint that answered differently would describe the state of a
    // secret to whoever asked.
    if (!claims || spent.has(claims.jti)) throw new AuthError(BREAK_GLASS_REJECTED);

    const personId = claims.personId as PersonId;
    const person = await services.identity.findById(personId);
    if (!person) throw new AuthError(BREAK_GLASS_REJECTED);

    spent.add(claims.jti);

    // Written before the session exists, not after. A break-glass sign-in that happened
    // without a line in the log is the thing this must never be, so the append is the
    // step that can refuse — not an afterthought that can be lost.
    //
    // In the person's own room, paired by `jti` with the `session.break_glass_minted` the
    // script wrote, and visible on `Historik` as "Nödinloggning använd för att logga in" —
    // both allowlists and the Swedish label came with this. A record only the operators can
    // read would let us say the account is audited while the person sees nothing.
    const personalRoom = await services.identity.personalRoomOf(personId);
    await services.events.append({
      roomId: personalRoom.id,
      eventType: 'session.break_glass_used',
      payload: { jti: claims.jti, expiresAt: claims.expiresAt.toISOString() },
      actorPersonId: personId,
      agentClient: 'web',
      explicit: true,
    });

    const session = await deps.connect.issuer.issue({ personId });
    setSessionCookie(c, session.token, {
      publicUrl: c.get('config').publicUrl,
      expiresAt: session.expiresAt,
    });

    c.get('logger').warn('break_glass_signin', { personId, jti: claims.jti });

    return c.json({ ok: true, expiresAt: session.expiresAt.toISOString() }, 200);
  });

  /**
   * The connect screen, as data.
   *
   * Unauthenticated on purpose: it contains no secrets. There is one shared MCP URL for
   * everyone and identity comes from OAuth at connect time, so this page can be
   * screenshotted and pasted into a group chat without leaking anything. That property
   * is asserted in the acceptance test, because it is the kind of thing that quietly
   * stops being true when someone adds a convenience parameter.
   */
  routes.get('/connect', async (c) => {
    const result = await handleConnect(deps.config, {
      headers: { 'user-agent': c.req.header('user-agent') },
    });
    return c.json(result.body as object, result.status as 200);
  });

  return routes;
}

export function connectRoutes(deps: ConnectRouteDeps): Hono<AppEnv> {
  const routes = new Hono<AppEnv>();

  routes.post('/connect/verify', async (c) => {
    const actor = getActor(c);
    const services = getServices(c);

    const result = await handleStartVerification(
      { sessions: services.sessions, clock: () => new Date() },
      deps.config,
      { body: await body(c), actor },
    );
    return c.json(result.body as object, result.status as 200);
  });

  routes.post('/connect/status', async (c) => {
    const actor = getActor(c);
    const services = getServices(c);

    const result = await handleVerificationStatus(
      { sessions: services.sessions, clock: () => new Date() },
      deps.config,
      { body: await body(c), actor },
    );
    return c.json(result.body as object, result.status as 200);
  });

  /**
   * Shows what an import would produce, changing nothing.
   *
   * Separate from the commit because the candidates are worth looking at: the parser
   * strips UI chrome, rewrites "the user is allergic to X" into the person's own voice,
   * and drops anything that looks like a secret. Committing blind would mean trusting
   * all of that silently on someone's real memory.
   */
  routes.post('/import/preview', async (c) => {
    getActor(c);
    const { text } = await parseJsonBody(c, importPreviewSchema);
    return c.json(previewImport(text));
  });

  /**
   * Commits an import as proposals. Never as facts.
   *
   * Memories carried over from another system arrive with no evidence the person ever
   * confirmed them — some are stale, some were wrong when they were written. Importing
   * them as established fact means inheriting another product's mistakes and calling
   * them your own memory.
   */
  routes.post('/import', async (c) => {
    const actor = getActor(c);
    const { text } = await parseJsonBody(c, importCommitSchema);
    const services = getServices(c);

    const preview = previewImport(text);
    const room = await services.identity.personalRoomOf(actor.personId);

    const proposals = [];
    for (const candidate of preview.candidates) {
      proposals.push(
        await services.ingest.propose(actor, {
          roomId: room.id,
          body: candidate.text,
          kind: candidate.kind,
          source: preview.source,
        }),
      );
    }

    return c.json(
      {
        source: preview.source,
        proposals: proposals.map(serialiseProposal),
        skipped: preview.skipped,
      },
      201,
    );
  });

  return routes;
}

async function body(c: { req: { text(): Promise<string> } }): Promise<unknown> {
  try {
    const raw = await c.req.text();
    return raw.trim() ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}
