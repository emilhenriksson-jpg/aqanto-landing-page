/**
 * What happens to a document when the upload only half worked, and when a person wants it
 * gone.
 *
 * The upload path writes the bytes and charges the person's ten gigabytes before the
 * document row exists, because the storage key is the checksum and the checksum is not
 * knowable until the bytes have been read. Nothing compensated for that: a transient error
 * in the row-and-chunks transaction left a person paying for an object they could never see
 * and an original in storage with nothing pointing at it. And there was no way to delete a
 * single document at all, so a person could not clean up after it either.
 *
 * Both halves are tested here: compensation while the process is alive to do it, and
 * reconciliation for when the process was the thing that died.
 */

import type { Actor, DocumentId, RoomId } from '@photographic/core';
import { MemoryBlobStore } from '@photographic/documents/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createPool, createPostgresServices, reset, type PostgresServices } from '../index.js';
import type { PgDocuments } from './documents.js';

const pool = createPool();
const utf8 = (text: string) => new TextEncoder().encode(text);

let wired: PostgresServices;
let blobs: MemoryBlobStore;
let documents: PgDocuments;
let emil: Actor;
let personalRoom: RoomId;

beforeAll(async () => {
  await reset(pool);
  blobs = new MemoryBlobStore();
  wired = await createPostgresServices({ pool, blobs });

  const registered = await wired.services.identity.register({
    email: 'dokumentliv@photographic.test',
    displayName: 'Emil',
  });
  emil = wired.actorFor(registered.person.id);
  personalRoom = registered.personalRoom.id;
  documents = wired.services.documents as PgDocuments;
});

afterAll(async () => {
  await wired.close();
});

const upload = (filename: string, body: string, roomId: RoomId = personalRoom) =>
  wired.services.documents.upload(emil, {
    roomId,
    filename,
    mimeType: 'text/markdown',
    bytes: utf8(body),
  });

const storageKeyOf = async (documentId: DocumentId) =>
  (
    await pool.query<{ storage_key: string; checksum: string }>(
      `SELECT storage_key, checksum FROM app.document WHERE id = $1`,
      [documentId],
    )
  ).rows[0]!;

describe('an upload that half worked', () => {
  it('gives the space back and deletes the bytes when the document cannot be written', async () => {
    // The failure is injected between the two halves of the upload: the bytes and the
    // charge have happened, the row has not. Before compensation existed this consumed part
    // of a person's ten gigabytes with an object they could never see.
    const before = await wired.services.documents.storageUsage(emil);
    const blobsBefore = blobs.size;

    // A body long enough to chunk, so the failure lands in the chunk insert rather than
    // somewhere less interesting. `NOT VALID` so the constraint applies to the rows this
    // upload writes and not to chunks that are already there.
    const body = `# Trasig\n\n${'x'.repeat(4000)}`;
    await pool.query(`ALTER TABLE app.chunk ADD CONSTRAINT chunk_break CHECK (false) NOT VALID`);
    try {
      await expect(upload('trasig.md', body)).rejects.toThrow();
    } finally {
      await pool.query(`ALTER TABLE app.chunk DROP CONSTRAINT chunk_break`);
    }

    const after = await wired.services.documents.storageUsage(emil);
    expect(after.bytesUsed).toBe(before.bytesUsed);
    expect(after.objectCount).toBe(before.objectCount);
    // And the original does not sit in storage with no memory pointing at it.
    expect(blobs.size).toBe(blobsBefore);
    // Nor is the upload record left behind to be reconciled later; this one was handled.
    const left = await pool.query(`SELECT 1 FROM app.blob_upload`);
    expect(left.rowCount).toBe(0);
  });

  it('keeps the bytes when another document already referenced them', async () => {
    // Content addressing means the object may belong to a document that is perfectly fine.
    // Deleting it as compensation would break that one instead.
    const body = `# Delad\n\n${'y'.repeat(4000)}`;
    const first = await upload('delad-1.md', body);
    const { storage_key } = await storageKeyOf(first.documentId);

    await pool.query(`ALTER TABLE app.chunk ADD CONSTRAINT chunk_break CHECK (false) NOT VALID`);
    try {
      await expect(upload('delad-2.md', body)).rejects.toThrow();
    } finally {
      await pool.query(`ALTER TABLE app.chunk DROP CONSTRAINT chunk_break`);
    }

    expect(await blobs.exists(storage_key)).toBe(true);
    // The first document still downloads, which is the thing being protected.
    expect(await wired.services.documents.download(emil, first.documentId)).not.toBeNull();
  });

  it('is reconciled after a crash, because the process cannot compensate for its own death', async () => {
    // The state a killed process leaves: charged, recorded as an upload in flight, no
    // document. Nothing in the request path can clean this up — it is not running any more.
    const { documentId } = await upload('sedan-borttagen.md', '# Kvar\n\nEn fil.');
    const { checksum, storage_key } = await storageKeyOf(documentId);

    await pool.query(`DELETE FROM app.chunk WHERE document_id = $1`, [documentId]);
    await pool.query(`DELETE FROM app.document WHERE id = $1`, [documentId]);
    await pool.query(
      `INSERT INTO app.blob_upload
         (person_id, room_id, checksum, storage_key, byte_size, filename, created_at)
       VALUES ($1, $2, $3, $4, 100, 'sedan-borttagen.md', now() - interval '2 hours')`,
      [emil.personId, personalRoom, checksum, storage_key],
    );

    const usageBefore = await wired.services.documents.storageUsage(emil);
    const result = await documents.reconcileStorage();

    expect(result.uploadsReleased).toBeGreaterThanOrEqual(1);
    expect(result.blobsDeleted).toBeGreaterThanOrEqual(1);
    expect(await blobs.exists(storage_key)).toBe(false);

    const usageAfter = await wired.services.documents.storageUsage(emil);
    expect(usageAfter.bytesUsed).toBeLessThan(usageBefore.bytesUsed);
  });

  it('leaves an upload that is still in flight alone', async () => {
    // A row written seconds ago is indistinguishable from a crashed one except by age, and
    // reconciliation that ate live uploads would be worse than the leak it fixes.
    await pool.query(
      `INSERT INTO app.blob_upload (person_id, room_id, checksum, storage_key, byte_size, filename)
       VALUES ($1, $2, 'inflight-checksum', 'sha256/inflight', 10, 'pågår.md')`,
      [emil.personId, personalRoom],
    );

    const result = await documents.reconcileStorage();
    expect(result.uploadsReleased).toBe(0);

    const still = await pool.query(`SELECT 1 FROM app.blob_upload WHERE checksum = 'inflight-checksum'`);
    expect(still.rowCount).toBe(1);
    await pool.query(`DELETE FROM app.blob_upload WHERE checksum = 'inflight-checksum'`);
  });

  it('releases a ledger row from before any of this existed', async () => {
    // Damage already done: a charge with no document and no upload record, which is what an
    // older crash left behind. Nothing but reconciliation can find it, because it is
    // invisible by construction.
    await pool.query(
      `INSERT INTO app.storage_object (person_id, checksum, byte_size, storage_key, first_seen_at)
       VALUES ($1, 'gammal-checksum', 4096, 'sha256/gammal', now() - interval '3 days')`,
      [emil.personId],
    );
    await pool.query(
      `UPDATE app.storage_usage SET bytes_used = bytes_used + 4096, object_count = object_count + 1
       WHERE person_id = $1`,
      [emil.personId],
    );

    const before = await wired.services.documents.storageUsage(emil);
    const result = await documents.reconcileStorage();

    expect(result.objectsReleased).toBeGreaterThanOrEqual(1);
    const after = await wired.services.documents.storageUsage(emil);
    expect(after.bytesUsed).toBe(before.bytesUsed - 4096);
  });

  it('never releases a charge for a document sitting in the trash', async () => {
    // A document in the trash is restorable for thirty days. Giving its space back early
    // would let the restore fail at the storage limit, which would make the trash a lie.
    const { documentId } = await upload('i-papperskorgen.md', '# Kvar\n\nSka gå att ta tillbaka.');
    await wired.services.documents.remove(emil, documentId);

    const before = await wired.services.documents.storageUsage(emil);
    await pool.query(
      `UPDATE app.storage_object SET first_seen_at = now() - interval '30 days' WHERE person_id = $1`,
      [emil.personId],
    );
    await documents.reconcileStorage();

    const after = await wired.services.documents.storageUsage(emil);
    expect(after.bytesUsed).toBe(before.bytesUsed);
    expect(await wired.services.documents.restore(emil, documentId)).not.toBeNull();
  });
});

describe('a document a person wants gone', () => {
  it('goes to the trash, is gone from the room, and can be taken back', async () => {
    const { documentId } = await upload('avtal.md', '# Avtal\n\nUppsägningstiden är tre månader.');

    const removed = await wired.services.documents.remove(emil, documentId);
    expect(removed?.deletedAt).not.toBeNull();
    expect(removed?.purgeAfter).not.toBeNull();

    // Gone from every ordinary read, exactly as a deleted memory is.
    expect(await wired.services.documents.get(emil, documentId)).toBeNull();
    expect(
      (await wired.services.documents.listForRoom(emil, personalRoom)).map((d) => d.id),
    ).not.toContain(documentId);
    expect(await wired.services.documents.download(emil, documentId)).toBeNull();
    expect(await wired.services.documents.originalText(emil, documentId)).toBeNull();

    // Visible where a person looks for it, with a deadline.
    const trashed = await wired.services.documents.trashed(emil);
    expect(trashed.map((d) => d.id)).toContain(documentId);

    const restored = await wired.services.documents.restore(emil, documentId);
    expect(restored?.deletedAt).toBeNull();
    expect(await wired.services.documents.get(emil, documentId)).not.toBeNull();
    // With its text and chunks intact, which is what makes it a restore rather than a
    // second upload.
    expect(await wired.services.documents.originalText(emil, documentId)).toContain('Uppsägningstiden');
    expect((await wired.services.documents.chunksFor(emil, documentId)).length).toBeGreaterThan(0);
  });

  it('stops appearing in search while it is in the trash', async () => {
    // A deleted memory that still turns up in search is the failure the trash exists to
    // prevent. It is no better for a contract.
    const { documentId } = await upload('hyra.md', '# Hyra\n\nHyresavtalet gäller till 2027.');
    await wired.runJobsToCompletion();

    const found = await wired.services.retrieval.search(emil, { query: 'hyresavtalet' });
    expect(found.some((hit) => hit.kind === 'chunk')).toBe(true);

    await wired.services.documents.remove(emil, documentId);
    const afterDelete = await wired.services.retrieval.search(emil, { query: 'hyresavtalet' });
    expect(afterDelete.some((hit) => hit.kind === 'chunk')).toBe(false);

    await wired.services.documents.restore(emil, documentId);
    const afterRestore = await wired.services.retrieval.search(emil, { query: 'hyresavtalet' });
    expect(afterRestore.some((hit) => hit.kind === 'chunk')).toBe(true);
  });

  it('writes the delete and the restore to the room’s history', async () => {
    // Other members seeing a file disappear with no trace is the silent removal the log
    // exists to prevent.
    const { documentId } = await upload('protokoll.md', '# Protokoll\n\nMötet hölls i mars.');
    await wired.services.documents.remove(emil, documentId, { reason: 'fel rum' });
    await wired.services.documents.restore(emil, documentId);

    const events = await pool.query<{ event_type: string; payload: Record<string, unknown> }>(
      `SELECT event_type, payload FROM app.event
       WHERE room_id = $1 AND event_type LIKE 'document.%' ORDER BY seq`,
      [personalRoom],
    );
    const types = events.rows.map((row) => row.event_type);
    expect(types).toContain('document.deleted');
    expect(types).toContain('document.restored');

    const deleted = events.rows.find(
      (row) => row.event_type === 'document.deleted' && row.payload['document_id'] === documentId,
    );
    expect(deleted?.payload['reason']).toBe('fel rum');
  });

  it('keeps its storage until the purge, and gives it back then', async () => {
    const { documentId } = await upload('stor-fil.md', `# Stor\n\n${'z'.repeat(5000)}`);
    const { storage_key } = await storageKeyOf(documentId);

    await wired.services.documents.remove(emil, documentId);
    const inTrash = await wired.services.documents.storageUsage(emil);
    expect(await blobs.exists(storage_key)).toBe(true);

    // Thirty days later, without waiting thirty days.
    await pool.query(`UPDATE app.document SET purge_after = now() - interval '1 day' WHERE id = $1`, [
      documentId,
    ]);
    expect(await wired.services.documents.purgeExpired()).toBeGreaterThanOrEqual(1);

    const purged = await wired.services.documents.storageUsage(emil);
    expect(purged.bytesUsed).toBeLessThan(inTrash.bytesUsed);
    expect(await blobs.exists(storage_key)).toBe(false);

    // The row, the chunks and the trash entry all go together.
    const rows = await pool.query(`SELECT 1 FROM app.document WHERE id = $1`, [documentId]);
    expect(rows.rowCount).toBe(0);
    const chunks = await pool.query(`SELECT 1 FROM app.chunk WHERE document_id = $1`, [documentId]);
    expect(chunks.rowCount).toBe(0);
  });

  it('cannot be deleted by someone who cannot reach it, and is not confirmed to exist', async () => {
    const { documentId } = await upload('privat.md', '# Privat\n\nInget för andra.');
    const stranger = await wired.services.identity.register({
      email: 'framling-dokument@photographic.test',
    });

    // Null rather than a refusal: a delete endpoint that distinguished "not yours" from
    // "does not exist" would confirm the document exists.
    expect(
      await wired.services.documents.remove(wired.actorFor(stranger.person.id), documentId),
    ).toBeNull();
    expect(await wired.services.documents.get(emil, documentId)).not.toBeNull();
  });

  it('does not show one person’s trash to another', async () => {
    const { documentId } = await upload('mitt.md', '# Mitt\n\nBara mitt.');
    await wired.services.documents.remove(emil, documentId);

    const stranger = await wired.services.identity.register({
      email: 'framling-papperskorg@photographic.test',
    });
    const theirs = await wired.services.documents.trashed(wired.actorFor(stranger.person.id));
    expect(theirs.map((d) => d.id)).not.toContain(documentId);
  });
});
