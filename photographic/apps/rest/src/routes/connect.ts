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
  type ConnectDeps,
} from '@photographic/connect';
import { Hono } from 'hono';

import type { AppEnv } from '../context.js';
import { importCommitSchema, importPreviewSchema } from '../schemas.js';
import { serialiseProposal } from '../serialise.js';
import { parseJsonBody } from '../validation.js';
import { getActor, getServices } from './shared.js';

export interface ConnectRouteDeps {
  connect: ConnectDeps;
  config: ConnectConfig;
}

/** No token: this is how an account comes to exist in the first place. */
export function publicConnectRoutes(deps: ConnectRouteDeps): Hono<AppEnv> {
  const routes = new Hono<AppEnv>();

  routes.post('/signup/request', async (c) => {
    const result = await handleSignupRequest(deps.connect, { body: await body(c) });
    return c.json(result.body as object, result.status as 200);
  });

  routes.post('/signup/verify', async (c) => {
    const result = await handleSignupVerify(deps.connect, { body: await body(c) });
    return c.json(result.body as object, result.status as 200);
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
