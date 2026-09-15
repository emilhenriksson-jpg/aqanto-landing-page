/**
 * Building the archive.
 *
 * Reads the log in pages and writes each entry as it goes, so memory stays flat whether
 * the person has forty events or four million. Nothing here holds a whole file except
 * one document at a time, which is bounded by the upload limit rather than by the
 * account.
 *
 * The scope rule, which is the only interesting decision in this file:
 *
 *   - The **personal room** is included whole. It is unambiguously the person's.
 *   - A **shared room** contributes only what the person wrote, unless they explicitly
 *     asked for that room's full transcript. See `EXPORT.md` for the reasoning; the
 *     short version is that a shared room is a collective working memory, the same
 *     premise that keeps a departing member's notes in it, and that premise does not
 *     stop applying when the copy is going the other way.
 *
 * Authorship in a shared room is derived from the log rather than read off a column,
 * because `app.item` does not have one yet — and because the log is the truth, so
 * deriving it is the answer that stays correct when the column arrives.
 */

import { createHash } from 'node:crypto';

import { NotFoundError } from '@photographic/core';

import {
  ARCHIVE_PATHS,
  archiveDocumentPath,
  archiveFilename,
  EXPORT_FORMAT_VERSION,
  ndjsonLine,
  renderReadme,
  type ExportManifest,
  type ExportScope,
  type ExportedRoom,
} from './archive.js';
import type {
  ExportDeps,
  ExportDocument,
  ExportEvent,
  ExportItem,
  ExportRoom,
} from './deps.js';
import { ZipWriter, type ZipSink } from './zip.js';

const DEFAULT_PAGE_SIZE = 500;

export interface BuildRequest {
  personId: string;
  scope: ExportScope;
  /** Shared rooms whose full transcript was asked for. Ignored when scope is `own`. */
  requestedRooms?: string[];
}

export interface BuildResult {
  filename: string;
  manifest: ExportManifest;
  byteSize: number;
  /** sha256 of the whole archive, computed as it was written. */
  checksum: string;
  entryCount: number;
  /** Rooms the archive touched, for the `export.created` events the caller writes. */
  touchedRooms: Array<{ roomId: string; included: 'own' | 'full' }>;
  throughSeq: number;
}

/**
 * A sink that hashes and counts on the way past.
 *
 * The manifest carries a sha256 per entry, and the job row carries one for the whole
 * archive. Computing them here means one pass over bytes already in flight rather than
 * reading the finished archive back out of storage to checksum it.
 */
class HashingSink implements ZipSink {
  private readonly hash = createHash('sha256');
  private size = 0;

  constructor(private readonly inner: ZipSink) {}

  async write(chunk: Uint8Array): Promise<void> {
    this.hash.update(chunk);
    this.size += chunk.byteLength;
    await this.inner.write(chunk);
  }

  digest(): { checksum: string; byteSize: number } {
    return { checksum: this.hash.digest('hex'), byteSize: this.size };
  }
}

/**
 * Starts reading a blob, and answers null when there is nothing to read.
 *
 * The first chunk is pulled before the caller writes an entry header. A blob store that
 * does not have the key throws on that first read, and finding out then is the difference
 * between an archive with one file missing and a note about it, and an archive with a
 * half-written entry in it. A failure *after* bytes have arrived is a genuine storage
 * fault and is left to propagate — that one should fail the export rather than be
 * summarised as a missing file.
 */
async function openBlob(
  deps: ExportDeps,
  storageKey: string,
): Promise<AsyncIterable<Uint8Array> | null> {
  const iterator = deps.blobs.getStream(storageKey)[Symbol.asyncIterator]();

  let first: IteratorResult<Uint8Array>;
  try {
    first = await iterator.next();
  } catch (error) {
    if (error instanceof NotFoundError) return null;
    throw error;
  }

  return {
    async *[Symbol.asyncIterator]() {
      if (first.done) return;
      yield first.value;
      for (;;) {
        const next = await iterator.next();
        if (next.done) return;
        yield next.value;
      }
    },
  };
}

/** Hashes one entry's bytes as they stream, without holding them. */
function hashingPassthrough(
  source: AsyncIterable<Uint8Array> | Iterable<Uint8Array>,
  onDigest: (checksum: string) => void,
): AsyncIterable<Uint8Array> {
  return {
    async *[Symbol.asyncIterator]() {
      const hash = createHash('sha256');
      for await (const chunk of source) {
        hash.update(chunk);
        yield chunk;
      }
      onDigest(hash.digest('hex'));
    },
  };
}

export async function buildExportArchive(
  deps: ExportDeps,
  request: BuildRequest,
  sink: ZipSink,
): Promise<BuildResult> {
  const now = deps.now?.() ?? new Date();
  const pageSize = deps.pageSize ?? DEFAULT_PAGE_SIZE;
  const { source } = deps;

  const person = await source.person(request.personId);
  const reachable = await source.rooms(request.personId);

  // Requested rooms are intersected with what is reachable *now*. A room the person left
  // between asking and the job running must not end up in the archive, and a room id
  // they never had access to is not a grant just because they named it.
  const requested = new Set(request.scope === 'rooms' ? (request.requestedRooms ?? []) : []);
  const plan = reachable.map((room) => ({
    room,
    included: inclusionFor(room, requested),
  }));

  const roomIds = plan.map((entry) => entry.room.id);
  const ownOnlyRoomIds = plan
    .filter((entry) => entry.included === 'own')
    .map((entry) => entry.room.id);

  // A snapshot boundary, fixed before anything is read. Without it a long export would
  // include events that happened while it ran, and two exports of "the same" memory
  // would differ for no reason anyone could name.
  const throughSeq = await source.latestSeq();

  // One sink, hashing the whole archive as it passes, wrapped once. The job row records
  // that digest so a download can be verified against what was produced.
  const hashingSink = new HashingSink(sink);
  const archive = new ZipWriter(hashingSink);

  const checksums: Record<string, string> = {};
  const record = (path: string) => (checksum: string) => {
    checksums[path] = checksum;
  };

  // ---------------------------------------------------------------------
  // events.ndjson — the truth, and the thing that makes this portable
  // ---------------------------------------------------------------------

  let eventCount = 0;
  let firstSeq: number | null = null;
  let lastSeq = 0;
  const actors = new Set<string>();

  await archive.add(
    ARCHIVE_PATHS.events,
    hashingPassthrough(
      (async function* () {
        let after = 0;
        for (;;) {
          const page = await source.events({
            roomIds,
            actorPersonId: request.personId,
            actorOnlyRoomIds: ownOnlyRoomIds,
            throughSeq,
            afterSeq: after,
            limit: pageSize,
          });

          for (const event of page.rows) {
            eventCount += 1;
            firstSeq ??= event.seq;
            lastSeq = event.seq;
            if (event.actorPersonId) actors.add(event.actorPersonId);
            if (event.approvedBy) actors.add(event.approvedBy);
            yield ndjsonLine(serialiseEvent(event));
          }

          if (page.cursor === null) break;
          after = page.cursor;
        }
      })(),
      record(ARCHIVE_PATHS.events),
    ),
  );

  // ---------------------------------------------------------------------
  // items.ndjson — the projection, for convenience
  // ---------------------------------------------------------------------

  // Which items in a shared room are the person's own. Derived from their own events
  // rather than from a column, because `app.item` has no author yet and because the log
  // is where authorship actually lives.
  const ownItemIds =
    ownOnlyRoomIds.length > 0
      ? await collectOwnItemIds(deps, request.personId, ownOnlyRoomIds, throughSeq, pageSize)
      : [];

  let itemCount = 0;
  await archive.add(
    ARCHIVE_PATHS.items,
    hashingPassthrough(
      (async function* () {
        let after = 0;
        for (;;) {
          const page = await source.items({
            roomIds,
            actorOnlyRoomIds: ownOnlyRoomIds,
            itemIds: ownItemIds,
            afterRowId: after,
            limit: pageSize,
          });

          for (const item of page.rows) {
            itemCount += 1;
            yield ndjsonLine(serialiseItem(item));
          }

          if (page.cursor === null) break;
          after = page.cursor;
        }
      })(),
      record(ARCHIVE_PATHS.items),
    ),
  );

  // ---------------------------------------------------------------------
  // documents.ndjson, then the originals
  // ---------------------------------------------------------------------

  const documents: ExportDocument[] = [];
  let documentCount = 0;

  await archive.add(
    ARCHIVE_PATHS.documents,
    hashingPassthrough(
      (async function* () {
        let after = 0;
        for (;;) {
          const page = await source.documents({
            roomIds,
            actorOnlyRoomIds: ownOnlyRoomIds,
            uploadedBy: request.personId,
            afterRowId: after,
            limit: pageSize,
          });

          for (const doc of page.rows) {
            documentCount += 1;
            // Kept so the files can be written next. Metadata only — the bytes are
            // streamed straight from the blob store and never collected.
            documents.push(doc);
            const room = plan.find((entry) => entry.room.id === doc.roomId)?.room;
            yield ndjsonLine(
              serialiseDocument(doc, archiveDocumentPath({
                roomSlug: room?.slug ?? doc.roomId,
                documentId: doc.id,
                filename: doc.filename,
              })),
            );
          }

          if (page.cursor === null) break;
          after = page.cursor;
        }
      })(),
      record(ARCHIVE_PATHS.documents),
    ),
  );

  const notes: string[] = [];
  let fileCount = 0;

  for (const doc of documents) {
    const room = plan.find((entry) => entry.room.id === doc.roomId)?.room;
    const path = archiveDocumentPath({
      roomSlug: room?.slug ?? doc.roomId,
      documentId: doc.id,
      filename: doc.filename,
    });

    // Opened before the entry's header is written, because a missing blob has to be
    // discovered while the archive can still leave the entry out. Streamed after that: an
    // original can be 25 MB and there is no reason for two of them to be resident.
    const opened = await openBlob(deps, doc.storageKey);
    if (!opened) {
      // A row that names a blob the store does not have. Noted in the archive rather
      // than failing the export: the person's other twelve years of memory should not be
      // withheld over one missing file, and a silent gap would be worse than a line
      // saying which file is missing.
      notes.push(
        `Filen "${doc.filename}" kunde inte läsas ur lagringen och finns inte med i arkivet. ` +
          `Metadata om den ligger kvar i documents.ndjson.`,
      );
      continue;
    }

    await archive.add(path, hashingPassthrough(opened, record(path)));
    fileCount += 1;
  }

  // ---------------------------------------------------------------------
  // rooms.json, people.json, manifest, README
  // ---------------------------------------------------------------------

  const exportedRooms: ExportedRoom[] = plan.map(({ room, included }) => ({
    id: room.id,
    kind: room.kind,
    title: room.title,
    description: room.description,
    createdAt: room.createdAt.toISOString(),
    role: room.role,
    included,
    // In `own` scope the member list is still the room's — it is who the person shares
    // the room with, which is theirs to know, and it is display names rather than
    // contact details.
    members: room.members,
  }));

  await archive.add(
    ARCHIVE_PATHS.rooms,
    hashingPassthrough(
      [new TextEncoder().encode(JSON.stringify(exportedRooms, null, 2))],
      record(ARCHIVE_PATHS.rooms),
    ),
  );

  // Room members are added to the actor set before resolving names. Without this an
  // `own` export lists Elias in `rooms.json` — because who you share a room with is
  // yours to know — while `people.json` has never heard of him, since his events were
  // filtered out. An archive that references an id it cannot resolve is not
  // self-describing, which is the one thing the format is for.
  for (const { room } of plan) {
    for (const member of room.members) actors.add(member.personId);
  }
  actors.add(request.personId);

  const people = await source.people([...actors]);
  await archive.add(
    ARCHIVE_PATHS.people,
    hashingPassthrough(
      [
        new TextEncoder().encode(
          JSON.stringify(
            // Display names only. Other members' email addresses are not the exporting
            // person's to take, and nothing in the log needs them to be readable.
            people.map((entry) => ({
              id: entry.id,
              displayName: entry.displayName,
              ...(entry.id === request.personId
                ? { handle: entry.handle, email: entry.email, self: true }
                : {}),
            })),
            null,
            2,
          ),
        ),
      ],
      record(ARCHIVE_PATHS.people),
    ),
  );

  if (plan.some((entry) => entry.included === 'full')) {
    notes.push(
      'Arkivet innehåller hela innehållet i ett eller flera delade rum, inklusive vad ' +
        'andra medlemmar skrivit. Rummens medlemmar ser i historiken att en kopia togs.',
    );
  }

  const manifest: ExportManifest = {
    formatVersion: EXPORT_FORMAT_VERSION,
    createdAt: now.toISOString(),
    scope: request.scope,
    person: {
      id: person.id,
      handle: person.handle,
      displayName: person.displayName,
      email: person.email,
    },
    rooms: exportedRooms,
    counts: { events: eventCount, items: itemCount, documents: documentCount, files: fileCount },
    seqRange: firstSeq === null ? null : { from: firstSeq, through: lastSeq },
    checksums,
    notes,
  };

  // Manifest and README last, because they describe what was written — including the
  // per-entry checksums, which do not exist until the entries do.
  await archive.addBytes(
    ARCHIVE_PATHS.manifest,
    new TextEncoder().encode(`${JSON.stringify(manifest, null, 2)}\n`),
  );
  await archive.addBytes(
    ARCHIVE_PATHS.readme,
    new TextEncoder().encode(renderReadme(manifest)),
  );

  const { entryCount } = await archive.finish();
  const { byteSize, checksum } = hashingSink.digest();

  return {
    filename: archiveFilename({ handle: person.handle, createdAt: now }),
    manifest,
    byteSize,
    checksum,
    entryCount,
    touchedRooms: plan.map(({ room, included }) => ({ roomId: room.id, included })),
    throughSeq,
  };
}

function inclusionFor(room: ExportRoom, requested: Set<string>): 'own' | 'full' {
  // The personal room has one member and is the person's whole private memory. There is
  // no "someone else's contribution" in it to be careful about.
  if (room.kind === 'personal') return 'full';
  return requested.has(room.id) ? 'full' : 'own';
}

/**
 * Item ids the person authored in the given rooms, read out of the log.
 *
 * `item.created` carries the actor and the item id, so the person's own events name
 * exactly the items they wrote. Updates are included too: correcting your own memory
 * does not make it someone else's, and a person who fixed a date on their own note
 * should still get the note.
 */
async function collectOwnItemIds(
  deps: ExportDeps,
  personId: string,
  roomIds: string[],
  throughSeq: number,
  pageSize: number,
): Promise<string[]> {
  const ids = new Set<string>();
  let after = 0;

  for (;;) {
    const page = await deps.source.events({
      roomIds,
      actorPersonId: personId,
      actorOnlyRoomIds: roomIds,
      throughSeq,
      afterSeq: after,
      limit: pageSize,
    });

    for (const event of page.rows) {
      if (event.actorPersonId !== personId) continue;
      const itemId = event.payload['item_id'];
      if (typeof itemId === 'string') ids.add(itemId);
    }

    if (page.cursor === null) break;
    after = page.cursor;
  }

  return [...ids];
}

function serialiseEvent(event: ExportEvent): Record<string, unknown> {
  return {
    seq: event.seq,
    id: event.id,
    room_id: event.roomId,
    event_type: event.eventType,
    payload: event.payload,
    actor_person_id: event.actorPersonId,
    agent_client: event.agentClient,
    session_ref: event.sessionRef,
    approved_by: event.approvedBy,
    occurred_at: event.occurredAt.toISOString(),
  };
}

function serialiseItem(item: ExportItem): Record<string, unknown> {
  return {
    id: item.id,
    short_id: item.shortId,
    room_id: item.roomId,
    kind: item.kind,
    body: item.body,
    status: item.status,
    sensitivity: item.sensitivity,
    valid_from: item.validFrom.toISOString(),
    valid_to: item.validTo?.toISOString() ?? null,
    superseded_by: item.supersededBy,
    created_at: item.createdAt.toISOString(),
    updated_at: item.updatedAt.toISOString(),
  };
}

function serialiseDocument(doc: ExportDocument, path: string): Record<string, unknown> {
  return {
    id: doc.id,
    room_id: doc.roomId,
    filename: doc.filename,
    mime_type: doc.mimeType,
    byte_size: doc.byteSize,
    sha256: doc.checksum,
    uploaded_by: doc.uploadedBy,
    created_at: doc.createdAt.toISOString(),
    extraction: doc.extraction,
    // Both, and labelled. `text` is what we read out of the file; `summary` is what a
    // model wrote about it. An export that blurred them would lose the distinction the
    // whole document model is built on.
    extracted_text: doc.text,
    ai_summary: doc.summary,
    path,
  };
}
