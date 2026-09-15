/**
 * A document's trash, held to the same standard as a memory's.
 *
 * `documents-lifecycle.test.ts` covers what the feature does. This covers what happens when
 * a statement in the middle fails, which is the half that decides whether "thirty days,
 * restorable" is a promise or a hope — and it is the half the memory path only got right
 * after a review found it wrong.
 *
 * Same three rules as `lifecycle.test.ts`. Nothing here reads `deleted_at` to decide whether
 * something is in the trash; failures are injected between statements rather than simulated;
 * and every transition is asked for twice, because idempotence is what makes a retry after a
 * lost response safe and the happy path cannot show it.
 */

import type { Actor, DocumentId, RoomId } from '@photographic/core';
import { documentDivergencesFrom, replayDocumentLifecycle } from '@photographic/core';
import { MemoryBlobStore } from '@photographic/documents/testing';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { createPool, createPostgresServices, reset, type PostgresServices } from '../index.js';
import { failOnce } from '../testing/fail-once.js';

const pool = createPool();
const utf8 = (text: string) => new TextEncoder().encode(text);

let wired: PostgresServices;
let blobs: MemoryBlobStore;
let emil: Actor;
let elias: Actor;
let sharedRoom: RoomId;

beforeEach(async () => {
  await reset(pool);
  blobs = new MemoryBlobStore();
  wired = await createPostgresServices({ pool, blobs });

  const one = await wired.services.identity.register({
    email: 'emil@doclifecycle.test',
    displayName: 'Emil',
  });
  emil = wired.actorFor(one.person.id);

  const two = await wired.services.identity.register({
    email: 'elias@doclifecycle.test',
    displayName: 'Elias',
  });
  elias = wired.actorFor(two.person.id);

  const room = await wired.services.rooms.create(emil, { title: 'Buyersclub Ledning' });
  sharedRoom = room.id;
  const invite = await wired.services.invites.create(emil, {
    roomId: sharedRoom,
    channel: 'email',
    destination: 'elias@doclifecycle.test',
  });
  await wired.services.invites.accept(
    invite.url.split('/').filter(Boolean).at(-1)!,
    elias.personId,
  );
});

afterAll(async () => {
  await pool.end();
});

async function upload(actor: Actor, filename: string, body: string): Promise<DocumentId> {
  const result = await wired.services.documents.upload(actor, {
    roomId: sharedRoom,
    filename,
    mimeType: 'text/markdown',
    bytes: utf8(body),
  });
  return result.documentId;
}

/** Whether the log and `app.document` still describe the same documents. */
async function divergences() {
  const events = await wired.services.events.replay({ limit: 10_000 });
  const rows = await pool.query<{ id: string; room_id: string; deleted_at: Date | null }>(
    `SELECT id, room_id, deleted_at FROM app.document`,
  );

  return documentDivergencesFrom(
    replayDocumentLifecycle(events),
    rows.rows.map((row) => ({
      documentId: row.id,
      roomId: row.room_id as RoomId,
      inTrash: row.deleted_at !== null,
    })),
  );
}

const eventTypes = async (documentId: DocumentId): Promise<string[]> => {
  const rows = await pool.query<{ event_type: string }>(
    `SELECT event_type FROM app.event
     WHERE (payload ->> 'document_id') = $1 ORDER BY seq`,
    [documentId],
  );
  return rows.rows.map((row) => row.event_type);
};

describe('trashing a document is one transaction', () => {
  it('records the deletion in the log the room reads, not only on the row', async () => {
    const documentId = await upload(emil, 'kontrakt.md', 'Villans kontrakt');
    await wired.services.documents.remove(emil, documentId, { reason: 'fel version' });

    expect(await eventTypes(documentId)).toEqual(['document.uploaded', 'document.deleted']);
    expect((await wired.services.documents.trashed(elias)).map((d) => d.id)).toContain(
      documentId,
    );
    expect(await divergences()).toEqual([]);
  });

  it('leaves the document in the room when the event append fails', async () => {
    const documentId = await upload(emil, 'kontrakt.md', 'Villans kontrakt');

    // The window that mattered for memories and matters no less for a file: the row updated
    // and the `document.deleted` not written, so the other members of a shared room watch a
    // document disappear with nothing in their history explaining it.
    const injected = failOnce(pool, /INSERT INTO app\.event/);
    const services = (await createPostgresServices({ pool: injected.pool, blobs })).services;

    await expect(services.documents.remove(emil, documentId)).rejects.toThrow(/injected failure/);
    expect(injected.fired()).toBe(true);

    // Rolled back whole: still listed, not in the trash, log still agrees.
    const listed = await wired.services.documents.listForRoom(emil, sharedRoom);
    expect(listed.map((d) => d.id)).toContain(documentId);
    expect(await wired.services.documents.trashed(emil)).toEqual([]);
    expect(await divergences()).toEqual([]);
  });

  it('does not append a second deletion for a document already in the trash', async () => {
    const documentId = await upload(emil, 'kontrakt.md', 'Villans kontrakt');
    await wired.services.documents.remove(emil, documentId);

    // Null rather than a second event: the `UPDATE` is conditional on not being deleted, so
    // the retry a lost response produces cannot move the purge deadline either.
    expect(await wired.services.documents.remove(emil, documentId)).toBeNull();
    expect((await eventTypes(documentId)).filter((t) => t === 'document.deleted')).toHaveLength(1);
  });
});

describe('restoring a document is idempotent', () => {
  it('appends one restore for one restore', async () => {
    const documentId = await upload(emil, 'kontrakt.md', 'Villans kontrakt');
    await wired.services.documents.remove(emil, documentId);

    expect(await wired.services.documents.restore(emil, documentId)).not.toBeNull();
    expect(await wired.services.documents.restore(emil, documentId)).toBeNull();

    expect((await eventTypes(documentId)).filter((t) => t === 'document.restored')).toHaveLength(1);
    expect(await divergences()).toEqual([]);
  });

  it('leaves it in the trash when the restore’s event append fails', async () => {
    const documentId = await upload(emil, 'kontrakt.md', 'Villans kontrakt');
    await wired.services.documents.remove(emil, documentId);

    const injected = failOnce(pool, /INSERT INTO app\.event/);
    const services = (await createPostgresServices({ pool: injected.pool, blobs })).services;

    await expect(services.documents.restore(emil, documentId)).rejects.toThrow(/injected failure/);

    // Still recoverable, which is the whole promise. A restore that half-committed would
    // leave the file live in the room with the log still saying it was deleted.
    expect((await wired.services.documents.trashed(emil)).map((d) => d.id)).toContain(
      documentId,
    );
    expect(await wired.services.documents.restore(emil, documentId)).not.toBeNull();
    expect(await divergences()).toEqual([]);
  });

  it('agrees with the log through delete, restore and delete again', async () => {
    // The sequence that gave the memory trash two answers before it was derived from the log.
    const documentId = await upload(emil, 'kontrakt.md', 'Villans kontrakt');

    await wired.services.documents.remove(emil, documentId);
    await wired.services.documents.restore(emil, documentId);
    await wired.services.documents.remove(emil, documentId, { reason: 'ändå fel' });

    const replayed = replayDocumentLifecycle(
      await wired.services.events.replay({ limit: 10_000 }),
    );
    expect(replayed.get(documentId)?.inTrash).toBe(true);
    expect((await wired.services.documents.trashed(emil)).map((d) => d.id)).toEqual([
      documentId,
    ]);
    expect(await divergences()).toEqual([]);
  });
});
