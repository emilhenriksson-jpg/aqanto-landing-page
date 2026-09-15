/**
 * Documents over HTTP.
 *
 * Three endpoints exist because three different things are being asked for, and
 * collapsing them would break the promise the product makes about documents. `GET
 * /documents/:id` is metadata for a card. `/text` is our extraction, which is unbounded
 * and belongs on its own request. `/file` is the original bytes — the floor under
 * everything else, because summaries can be wrong and extraction can fail and none of
 * that matters as long as the file a person uploaded is still the file they get back.
 *
 * Upload takes a room the way a person says it: `POST /documents` with `room: "Buyersclub
 * Ledning"`, or nothing at all for private memory. The name is resolved against rooms the
 * actor is already in, through the same `resolveRoomRef` every other surface uses — a
 * room named in a request is a request, never a grant.
 */

import type { DocumentId, RoomId } from '@photographic/core';
import { TRASH_RETENTION_DAYS, ValidationError } from '@photographic/core';
import { formatBytes } from '@photographic/documents';
import { Hono } from 'hono';

import type { AppContext, AppEnv } from '../context.js';
import { roomIdParam, uploadFieldsSchema } from '../schemas.js';
import { serialiseDocument } from '../serialise.js';
import { parseParams } from '../validation.js';
import { getActor, getServices, resolveRoom } from './shared.js';

export function documentRoutes(): Hono<AppEnv> {
  const routes = new Hono<AppEnv>();

  /**
   * Upload into private memory, or into a named room.
   *
   * "Lägg den här PDF:en i Buyersclub Ledning" arrives here as a file plus a room name.
   * No room named means the personal room, which is the overwhelmingly common case and
   * the right default for anything about the person themselves.
   */
  routes.post('/documents', async (c) => {
    const actor = getActor(c);
    const { file, fields } = await readUpload(c);
    const roomId = await resolveRoom(c, actor, {
      ...(fields.roomId ? { roomId: fields.roomId } : {}),
      ...(fields.room ? { room: fields.room } : {}),
    });

    return uploadInto(c, roomId, file);
  });

  /** The same thing with the room in the path, for a client that already has an id. */
  routes.post('/rooms/:roomId/documents', async (c) => {
    const actor = getActor(c);
    const { roomId } = parseParams(c, roomIdParam);
    const { file } = await readUpload(c);

    return uploadInto(c, await resolveRoom(c, actor, { roomId: roomId as RoomId }), file);
  });

  /**
   * The document trash.
   *
   * Before `/documents/:id`'s DELETE existed there was no way for a person to remove a
   * single document at all: a file uploaded to the wrong room, or a failed upload that
   * consumed part of their ten gigabytes, was permanent and unmentionable. This is the
   * other half of that — what is recoverable and until when, so a delete is visibly
   * reversible rather than merely reversible.
   *
   * Registered before `/documents/:documentId` so "trash" is not read as a document id.
   */
  routes.get('/documents/trash', async (c) => {
    const actor = getActor(c);
    const roomParam = c.req.query('room');
    const trashed = await getServices(c).documents.trashed(actor, {
      ...(roomParam ? { roomId: (await resolveRoom(c, actor, { room: roomParam })) } : {}),
    });

    return c.json({
      documents: trashed.map((document) => ({
        ...serialiseDocument(document),
        deletedAt: document.deletedAt?.toISOString() ?? null,
        purgeAfter: document.purgeAfter?.toISOString() ?? null,
        daysRemaining:
          document.purgeAfter === null
            ? null
            : Math.max(0, Math.ceil((document.purgeAfter.getTime() - Date.now()) / 86_400_000)),
      })),
    });
  });

  /**
   * Moves a document to the trash.
   *
   * The same thirty days a memory gets, and the same reasoning: a person who has just
   * deleted the wrong contract must be able to get it back. The storage it occupies is
   * released at the purge rather than here — a restore that could fail at the limit would
   * make the trash a promise we cannot keep — and the response says so, because "I deleted
   * it and my storage did not change" is otherwise a bug report.
   */
  routes.delete('/documents/:documentId', async (c) => {
    const actor = getActor(c);
    const documentId = c.req.param('documentId') as DocumentId;

    const removed = await getServices(c).documents.remove(actor, documentId);
    if (!removed) return notFound(c);

    return c.json({
      document: serialiseDocument(removed),
      purgeAfter: removed.purgeAfter?.toISOString() ?? null,
      notice:
        `Dokumentet ligger i papperskorgen i ${TRASH_RETENTION_DAYS} dagar. ` +
        'Utrymmet frigörs när det raderas permanent, så att det går att ta tillbaka.',
    });
  });

  routes.post('/documents/:documentId/restore', async (c) => {
    const actor = getActor(c);
    const documentId = c.req.param('documentId') as DocumentId;

    const restored = await getServices(c).documents.restore(actor, documentId);
    // Same answer for "not in the trash" and "not yours": a restore endpoint that
    // distinguished them would confirm a document exists to someone who cannot read it.
    if (!restored) return notFound(c);

    return c.json({ document: serialiseDocument(restored) });
  });

  routes.get('/documents/:documentId', async (c) => {
    const actor = getActor(c);
    const documentId = c.req.param('documentId') as DocumentId;

    const document = await getServices(c).documents.get(actor, documentId);
    if (!document) return notFound(c);

    return c.json({ document: serialiseDocument(document) });
  });

  /**
   * Our extraction of the document, verbatim.
   *
   * `text/plain` rather than wrapped in JSON: this is the source text, it can be
   * megabytes, and a caller that wants it wants to read or index it rather than parse a
   * document around it. Kept apart from the summary at every layer — the summary is
   * what a model wrote, this is what the file said.
   */
  routes.get('/documents/:documentId/text', async (c) => {
    const actor = getActor(c);
    const documentId = c.req.param('documentId') as DocumentId;

    const document = await getServices(c).documents.get(actor, documentId);
    if (!document) return notFound(c);

    const text = await getServices(c).documents.originalText(actor, documentId);
    if (text === null) {
      // The document exists and is readable; there is simply no text in it. A 404 here
      // would say the document does not exist, which is a different and wrong answer.
      return c.json(
        {
          error: {
            code: 'no_text',
            message:
              document.extractionError ??
              'Det finns ingen utläst text för det här dokumentet ännu.',
            extraction: document.extraction,
          },
        },
        409,
      );
    }

    return c.body(text, 200, {
      'content-type': 'text/plain; charset=utf-8',
      'x-photographic-extraction': document.extraction,
    });
  });

  /** The original file. */
  routes.get('/documents/:documentId/file', async (c) => {
    const actor = getActor(c);
    const documentId = c.req.param('documentId') as DocumentId;

    const file = await getServices(c).documents.download(actor, documentId);
    if (!file) return notFound(c);

    return c.body(file.bytes as unknown as ArrayBuffer, 200, {
      'content-type': file.mimeType || 'application/octet-stream',
      // `attachment` rather than `inline`: an uploaded file is untrusted content, and an
      // HTML document served inline from this origin would run as this origin.
      'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(file.filename)}`,
      'content-length': String(file.bytes.byteLength),
      'x-content-type-options': 'nosniff',
    });
  });

  /** The chunks search actually returns, in order. */
  routes.get('/documents/:documentId/chunks', async (c) => {
    const actor = getActor(c);
    const documentId = c.req.param('documentId') as DocumentId;

    const chunks = await getServices(c).documents.chunksFor(actor, documentId);
    return c.json({
      chunks: chunks.map((chunk) => ({ id: chunk.id, ord: chunk.ord, text: chunk.text })),
    });
  });

  /**
   * Storage against the 10 GB limit.
   *
   * Formatted alongside the raw numbers because every surface showing this would
   * otherwise format it itself, and "9,4 GB" and "9.4 GB" in two places in one product
   * is the kind of detail that reads as carelessness.
   */
  routes.get('/storage', async (c) => {
    const actor = getActor(c);
    const usage = await getServices(c).documents.storageUsage(actor);

    return c.json({
      storage: {
        bytesUsed: usage.bytesUsed,
        limitBytes: usage.limitBytes,
        objectCount: usage.objectCount,
        usedLabel: formatBytes(usage.bytesUsed),
        limitLabel: formatBytes(usage.limitBytes),
        remainingLabel: formatBytes(Math.max(usage.limitBytes - usage.bytesUsed, 0)),
        // Clamped, because a limit lowered below what someone already stores would
        // otherwise render as a progress bar past its own end.
        fraction: Math.min(usage.bytesUsed / Math.max(usage.limitBytes, 1), 1),
      },
    });
  });

  return routes;
}

async function uploadInto(c: AppContext, roomId: RoomId, file: File) {
  const actor = getActor(c);
  const bytes = new Uint8Array(await file.arrayBuffer());

  const result = await getServices(c).documents.upload(actor, {
    roomId,
    filename: file.name,
    mimeType: file.type,
    bytes,
  });

  const document = await getServices(c).documents.get(actor, result.documentId);

  // 201 whatever happened to the text. The file is stored and retrievable, which is what
  // was asked for; whether we could read it is reported in the body rather than as a
  // failure, because a scanned contract is a normal thing to be handed and answering
  // 422 would tell the person their upload did not work.
  return c.json(
    {
      document: document ? serialiseDocument(document) : null,
      extraction: result.extraction,
      chunkCount: result.chunkCount,
    },
    201,
  );
}

/**
 * Pulls the file and the room out of a multipart body.
 *
 * The size ceiling is checked against `content-length` before the body is read, so an
 * oversized upload costs a header rather than a buffer — and again after, because
 * `content-length` is client-supplied and a chunked request has none.
 */
async function readUpload(c: AppContext): Promise<{
  file: File;
  fields: { room?: string; roomId?: string };
}> {
  const config = c.get('config');
  const declared = Number(c.req.header('content-length') ?? 0);
  if (declared > config.maxUploadBytes) {
    throw new ValidationError(
      `Filen är för stor. Största filstorlek är ${formatBytes(config.maxUploadBytes)}.`,
    );
  }

  const body = await c.req.parseBody().catch(() => null);
  if (!body) throw new ValidationError('Kunde inte läsa uppladdningen.');

  const file = body['file'];
  if (!(file instanceof File)) {
    throw new ValidationError('Ingen fil skickades med. Använd fältnamnet "file".');
  }
  if (file.size > config.maxUploadBytes) {
    throw new ValidationError(
      `"${file.name}" är ${formatBytes(file.size)}. Största filstorlek är ${formatBytes(config.maxUploadBytes)}.`,
    );
  }

  const fields = uploadFieldsSchema.parse({
    room: typeof body['room'] === 'string' ? body['room'] : undefined,
    roomId: typeof body['roomId'] === 'string' ? body['roomId'] : undefined,
  });

  return { file, fields };
}

/** Same answer for unreachable and non-existent, like every other read path. */
function notFound(c: AppContext) {
  return c.json({ error: { code: 'not_found', message: 'Dokumentet finns inte.' } }, 404);
}
