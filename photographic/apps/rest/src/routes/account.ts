/**
 * Export and permanent deletion.
 *
 * Both are first-party only. No OAuth scope should let a connected AI export a person's
 * entire memory or delete their account — a scope that permitted either would be held by
 * every client holding it, and "an AI deleted my account" is not a sentence this product
 * can ever produce. These are things a person does in the app, with the copy in front of
 * them, so they are gated on the browser session exactly like client management is.
 *
 * The one exception is the download itself, which takes a signed token and no session:
 * the archive is delivered by email and the browser that opens the link may never have
 * been logged in.
 */

import {
  DELETION_FREEZE_DAYS,
  DELETION_FREEZE_EXPLANATION,
  DELETION_IMMEDIATE_WARNING,
  DELETION_SHARED_ROOM_NOTICE,
  REMOVE_MY_CONTRIBUTIONS,
  ValidationError,
  type RoomId,
} from '@photographic/core';
import { formatBytes } from '@photographic/documents';
import { Hono } from 'hono';

import type { AppContext, AppEnv } from '../context.js';
import { deletionRequestSchema, exportRequestSchema } from '../schemas.js';
import { parseJsonBody } from '../validation.js';
import { getActor } from './shared.js';

/** The slice of `PgExports` these routes use. Declared here so `app.ts` needs no pg. */
export interface ExportService {
  request(
    actor: ReturnType<typeof getActor>,
    input: { scope?: 'own' | 'rooms'; rooms?: RoomId[] },
  ): Promise<ExportJobView>;
  list(actor: ReturnType<typeof getActor>): Promise<ExportJobView[]>;
  get(actor: ReturnType<typeof getActor>, id: string): Promise<ExportJobView | null>;
  createDownloadToken(
    actor: ReturnType<typeof getActor>,
    id: string,
  ): Promise<{ token: string; expiresAt: Date } | null>;
  resolveDownload(token: string): Promise<{ filename: string; bytes: Uint8Array } | null>;
}

export interface ExportJobView {
  id: string;
  scope: 'own' | 'rooms';
  status: string;
  byteSize: number | null;
  eventCount: number | null;
  itemCount: number | null;
  documentCount: number | null;
  requestedAt: Date;
  finishedAt: Date | null;
  expiresAt: Date;
  error: string | null;
}

/** The slice of `PgAccounts` these routes use. */
export interface AccountService {
  requestDeletion(
    actor: ReturnType<typeof getActor>,
    input: { immediate: boolean; contributions: 'keep' | 'remove' },
  ): Promise<{ request: DeletionView; tokensRevoked: number }>;
  pendingDeletion(personId: string): Promise<DeletionView | null>;
  cancelDeletion(actor: ReturnType<typeof getActor>): Promise<DeletionView | null>;
}

export interface DeletionView {
  id: string;
  status: string;
  immediate: boolean;
  contributions: 'keep' | 'remove';
  requestedAt: Date;
  executeAfter: Date;
}

export interface AccountRouteDeps {
  exports?: ExportService | null;
  accounts?: AccountService | null;
}

export function accountRoutes(deps: AccountRouteDeps): Hono<AppEnv> {
  const routes = new Hono<AppEnv>();

  // -------------------------------------------------------------------------
  // Export
  // -------------------------------------------------------------------------

  /**
   * Queues an export. Never builds one inside the request.
   *
   * `scope: 'rooms'` is the explicit, stronger request — full transcripts of named
   * shared rooms, including other members' writing. It is not the default, and the
   * response says which rooms it will cover so a person can see what they asked for
   * before the archive exists.
   */
  routes.post('/export', async (c) => {
    const actor = getActor(c);
    if (!deps.exports) return unavailable(c);

    const input = await parseJsonBody(c, exportRequestSchema);
    const job = await deps.exports.request(actor, {
      scope: input.scope ?? 'own',
      ...(input.rooms ? { rooms: input.rooms as RoomId[] } : {}),
    });

    return c.json({ export: serialiseExport(job) }, 202);
  });

  routes.get('/export', async (c) => {
    const actor = getActor(c);
    if (!deps.exports) return unavailable(c);

    const jobs = await deps.exports.list(actor);
    return c.json({ exports: jobs.map(serialiseExport) });
  });

  routes.get('/export/:exportId', async (c) => {
    const actor = getActor(c);
    if (!deps.exports) return unavailable(c);

    const job = await deps.exports.get(actor, c.req.param('exportId'));
    if (!job) return notFound(c, 'Exporten finns inte.');

    return c.json({ export: serialiseExport(job) });
  });

  /**
   * Mints the download link.
   *
   * Separate from the status endpoint so the link is created when a person asks for it
   * rather than every time a screen polls, and so it is not sitting in a response body
   * that a browser may have cached.
   */
  routes.post('/export/:exportId/link', async (c) => {
    const actor = getActor(c);
    if (!deps.exports) return unavailable(c);

    const link = await deps.exports.createDownloadToken(actor, c.req.param('exportId'));
    if (!link) return notFound(c, 'Exporten är inte klar att hämtas.');

    const base = c.get('config').publicUrl;
    return c.json({
      url: `${base}/v1/export/download/${link.token}`,
      expiresAt: link.expiresAt.toISOString(),
    });
  });

  return routes;
}

/**
 * The download, outside the authenticated group.
 *
 * Mounted separately in `app.ts` because it carries its own credential: the archive is
 * emailed and the browser opening it may never have had a session. The token is the
 * authority and nothing else is consulted.
 */
export function publicExportRoutes(deps: AccountRouteDeps): Hono<AppEnv> {
  const routes = new Hono<AppEnv>();

  routes.get('/export/download/:token', async (c) => {
    if (!deps.exports) return unavailable(c);

    const archive = await deps.exports.resolveDownload(c.req.param('token'));
    // Unknown, expired and already-deleted are one answer. The difference tells whoever
    // guessed a link what kind of guess it was.
    if (!archive) return notFound(c, 'Länken gäller inte längre.');

    return c.body(archive.bytes as unknown as ArrayBuffer, 200, {
      'content-type': 'application/zip',
      'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(archive.filename)}`,
      'content-length': String(archive.bytes.byteLength),
      'x-content-type-options': 'nosniff',
      // Never cached: this is someone's entire memory and the URL is a bearer token.
      'cache-control': 'no-store',
    });
  });

  return routes;
}

export function deletionRoutes(deps: AccountRouteDeps): Hono<AppEnv> {
  const routes = new Hono<AppEnv>();

  /**
   * What the person is about to agree to, as data.
   *
   * The copy lives in `@photographic/core` and is served rather than duplicated in the
   * client, so the wording a person reads before deleting their account cannot drift
   * from the wording the invite promised them.
   */
  routes.get('/account/deletion', async (c) => {
    const actor = getActor(c);
    const pending = deps.accounts ? await deps.accounts.pendingDeletion(actor.personId) : null;

    return c.json({
      pending: pending
        ? {
            id: pending.id,
            immediate: pending.immediate,
            contributions: pending.contributions,
            requestedAt: pending.requestedAt.toISOString(),
            executeAfter: pending.executeAfter.toISOString(),
            daysRemaining: Math.max(
              0,
              Math.ceil((pending.executeAfter.getTime() - Date.now()) / 86_400_000),
            ),
          }
        : null,
      freezeDays: DELETION_FREEZE_DAYS,
      copy: {
        freeze: DELETION_FREEZE_EXPLANATION,
        immediate: DELETION_IMMEDIATE_WARNING,
        sharedRooms: DELETION_SHARED_ROOM_NOTICE,
        removeContributions: REMOVE_MY_CONTRIBUTIONS,
      },
    });
  });

  /**
   * Requests deletion.
   *
   * `contributions` is required by the schema, with no default, because the consent copy
   * says the choice is never preselected — and a body that omitted it would be this
   * endpoint choosing on the person's behalf about other people's memory.
   *
   * `immediate` additionally requires `confirm: 'radera nu'`. The harder warning is the
   * decision Emil confirmed; making the confirmation a typed phrase is what stops an
   * accidental double-submit from skipping thirty days of recoverability.
   */
  routes.post('/account/deletion', async (c) => {
    const actor = getActor(c);
    if (!deps.accounts) return unavailable(c);

    const input = await parseJsonBody(c, deletionRequestSchema);

    if (input.immediate && input.confirm !== IMMEDIATE_CONFIRMATION) {
      throw new ValidationError(
        `Omedelbar radering kan inte ångras. Skriv "${IMMEDIATE_CONFIRMATION}" för att bekräfta.`,
      );
    }

    const { request, tokensRevoked } = await deps.accounts.requestDeletion(actor, {
      immediate: input.immediate ?? false,
      contributions: input.contributions,
    });

    return c.json(
      {
        deletion: {
          id: request.id,
          immediate: request.immediate,
          contributions: request.contributions,
          executeAfter: request.executeAfter.toISOString(),
        },
        // Said back, because "alla anslutna AI:er kopplas bort" is the part of the copy
        // a person will want evidence of.
        clientsDisconnected: tokensRevoked,
        notice: request.immediate
          ? DELETION_IMMEDIATE_WARNING
          : DELETION_FREEZE_EXPLANATION,
        sharedRooms: DELETION_SHARED_ROOM_NOTICE,
      },
      202,
    );
  });

  routes.delete('/account/deletion', async (c) => {
    const actor = getActor(c);
    if (!deps.accounts) return unavailable(c);

    const cancelled = await deps.accounts.cancelDeletion(actor);
    if (!cancelled) return notFound(c, 'Det finns ingen pågående radering att avbryta.');

    return c.json({
      cancelled: true,
      // The AIs stay disconnected on purpose. A client silently regaining access to a
      // memory the person had decided to delete is the wrong default even after they
      // change their mind.
      notice:
        'Raderingen är avbruten. Dina anslutna AI:er är fortfarande bortkopplade – ' +
        'anslut dem igen när du vill.',
    });
  });

  return routes;
}

/** Typed by the person, in Swedish, on the path that cannot be undone. */
export const IMMEDIATE_CONFIRMATION = 'radera nu';

function serialiseExport(job: ExportJobView) {
  return {
    id: job.id,
    scope: job.scope,
    status: job.status,
    byteSize: job.byteSize,
    byteSizeLabel: job.byteSize === null ? null : formatBytes(job.byteSize),
    counts: {
      events: job.eventCount,
      items: job.itemCount,
      documents: job.documentCount,
    },
    requestedAt: job.requestedAt.toISOString(),
    finishedAt: job.finishedAt?.toISOString() ?? null,
    expiresAt: job.expiresAt.toISOString(),
    error: job.error,
  };
}

function unavailable(c: AppContext) {
  return c.json(
    {
      error: {
        code: 'unavailable',
        message: 'Export och radering kräver en databas. Sätt DATABASE_URL.',
      },
    },
    503,
  );
}

function notFound(c: AppContext, message: string) {
  return c.json({ error: { code: 'not_found', message } }, 404);
}
