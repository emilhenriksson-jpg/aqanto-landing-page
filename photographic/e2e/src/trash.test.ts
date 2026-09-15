/**
 * One trash, end to end, against both backends.
 *
 * The product promise being tested is not a data model: it is that a person who deleted
 * something has one place to look and one thirty-day window, whether the thing was a memory
 * they typed or a file they uploaded. Documents used to satisfy that in principle — their own
 * `deleted_at`, their own listing endpoint — and not in practice, because nothing a person
 * could reach showed them.
 *
 * Run on both drivers deliberately. `AGENTS.md` treats the reference implementation as what
 * defines correct behaviour, and a unification that held in SQL and not there would leave the
 * definition as the unchecked copy — which is the shape of every drift this repo has had.
 *
 * Nothing here reads `status` or `deleted_at` to decide what is in the trash. The trash is
 * derived from the log for both halves now, so membership is a question for `TrashPort.list`
 * and recoverability a question for `TrashPort.restore`.
 */

import { isTrashedDocument, isTrashedMemory, trashHandleFor } from '@photographic/core';
import type { Actor, DocumentId, RoomId, ShortId } from '@photographic/core';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { createHarness, type Harness } from './harness.js';

const utf8 = (text: string) => new TextEncoder().encode(text);

let h: Harness;
let emil: Actor;
let personalRoom: RoomId;

beforeEach(async () => {
  h = await createHarness({
    databaseUrl: 'postgres://photographic:photographic@127.0.0.1:5432/photographic',
  });

  const registered = await h.registerPerson('emil@trash.test', 'Emil');
  emil = h.actorFor(registered.person);
  personalRoom = registered.personalRoom.id;
});

afterAll(async () => {
  await h.teardown();
});

async function saveMemory(body: string): Promise<ShortId> {
  const decision = await h.services.ingest.remember(emil, {
    roomId: personalRoom,
    body,
    explicit: true,
  });
  if (decision.outcome === 'auto') return decision.item.shortId;
  if (decision.outcome === 'needs_approval') {
    const item = await h.services.ingest.resolveProposal(emil, decision.proposal.id, true);
    return item!.shortId;
  }
  return decision.existing.shortId;
}

async function uploadDocument(filename: string, body: string): Promise<DocumentId> {
  const result = await h.services.documents.upload(emil, {
    roomId: personalRoom,
    filename,
    mimeType: 'text/markdown',
    bytes: utf8(body),
  });
  return result.documentId;
}

describe('the trash holds both kinds of thing', () => {
  it('lists a deleted memory and a deleted document together', async () => {
    const shortId = await saveMemory('Bor i Malmö');
    const documentId = await uploadDocument('kontrakt.md', 'Villans kontrakt');

    await h.services.ingest.forget(emil, shortId, personalRoom, 'flyttade');
    await h.services.documents.remove(emil, documentId, { reason: 'fel version' });

    const trash = await h.services.trash.list(emil);

    // One list, not two rendered next to each other: the assertion is that both are in the
    // same answer to the same call.
    expect(trash).toHaveLength(2);
    expect(trash.filter(isTrashedMemory).map((entry) => entry.shortId)).toEqual([shortId]);
    expect(trash.filter(isTrashedDocument).map((entry) => entry.documentId)).toEqual([documentId]);
    expect(await h.divergences()).toEqual([]);
  });

  it('names a document by its filename and a memory by its text', async () => {
    // What a person recognises the thing by. A document's extracted text can be megabytes and
    // is not what they are looking for in a list of things they deleted.
    const shortId = await saveMemory('Bor i Malmö');
    const documentId = await uploadDocument('styrelseprotokoll.md', 'Protokoll');

    await h.services.ingest.forget(emil, shortId, personalRoom);
    await h.services.documents.remove(emil, documentId);

    const trash = await h.services.trash.list(emil);
    const memory = trash.find(isTrashedMemory);
    const document = trash.find(isTrashedDocument);

    expect(memory?.body).toBe('Bor i Malmö');
    expect(document?.filename).toBe('styrelseprotokoll.md');
    expect(document?.byteSize).toBeGreaterThan(0);
  });

  it('sorts them together by when they were deleted', async () => {
    // A person remembers deleting things in an order, not in two orders by data type.
    const first = await saveMemory('Först borttagen');
    const documentId = await uploadDocument('sedan.md', 'Sedan borttagen');
    const last = await saveMemory('Sist borttagen');

    // A millisecond between each, because both drivers stamp `deletedAt` from the wall clock
    // and three deletions inside one tick tie. The tie is not the thing under test — the
    // ordering rule is — and a tie would let a grouped-by-type list pass.
    const tick = () => new Promise((resolve) => setTimeout(resolve, 2));

    await h.services.ingest.forget(emil, first, personalRoom);
    await tick();
    await h.services.documents.remove(emil, documentId);
    await tick();
    await h.services.ingest.forget(emil, last, personalRoom);

    const trash = await h.services.trash.list(emil);

    expect(trash).toHaveLength(3);
    // Newest first, with the document in the middle where it belongs rather than grouped at
    // one end — which is what a separate document list rendered underneath would have given.
    expect(trash.map((entry) => entry.type)).toEqual(['memory', 'document', 'memory']);
    expect(trash[0]!.deletedAt.getTime()).toBeGreaterThanOrEqual(trash[1]!.deletedAt.getTime());
    expect(trash[1]!.deletedAt.getTime()).toBeGreaterThanOrEqual(trash[2]!.deletedAt.getTime());
  });

  it('restores either one through the same call, by its own handle', async () => {
    const shortId = await saveMemory('Bor i Malmö');
    const documentId = await uploadDocument('kontrakt.md', 'Villans kontrakt');
    await h.services.ingest.forget(emil, shortId, personalRoom);
    await h.services.documents.remove(emil, documentId);

    for (const entry of await h.services.trash.list(emil)) {
      const restored = await h.services.trash.restore(emil, trashHandleFor(entry));
      // Discriminated on the way back too, so a caller cannot read the wrong field off it.
      expect(restored.type).toBe(entry.type);
    }

    expect(await h.services.trash.list(emil)).toEqual([]);
    expect(await h.divergences()).toEqual([]);

    // And both are readable again, which is what restoring was for.
    const items = await h.services.retrieval.listForRoom(emil, personalRoom);
    expect(items.map((item) => item.shortId)).toContain(shortId);
    const documents = await h.services.documents.listForRoom(emil, personalRoom);
    expect(documents.map((doc) => doc.id)).toContain(documentId);
  });

  it('gives delete-undo-delete one answer for a document, as it does for a memory', async () => {
    // The sequence the trash view was rebuilt around. It only has one answer because both
    // halves derive from the log rather than from a column somebody also updates.
    const documentId = await uploadDocument('kontrakt.md', 'Villans kontrakt');

    await h.services.documents.remove(emil, documentId);
    await h.services.trash.restore(emil, { type: 'document', documentId });
    await h.services.documents.remove(emil, documentId, { reason: 'ändå fel' });

    const trash = await h.services.trash.list(emil);
    expect(trash.filter(isTrashedDocument).map((entry) => entry.documentId)).toEqual([documentId]);
    expect(trash[0]?.deleteReason).toBe('ändå fel');
    expect(await h.divergences()).toEqual([]);
  });

  it('empties either one early, all the way to the bytes', async () => {
    const shortId = await saveMemory('Bor i Malmö');
    const documentId = await uploadDocument('kontrakt.md', 'Hemligt kontrakt');
    await h.services.ingest.forget(emil, shortId, personalRoom);
    await h.services.documents.remove(emil, documentId);

    await h.services.trash.purgeNow(emil, { type: 'memory', shortId }, personalRoom);
    await h.services.trash.purgeNow(emil, { type: 'document', documentId });

    expect(await h.services.trash.list(emil)).toEqual([]);
    // The whole point of purging rather than hiding: the text is not still sitting somewhere.
    expect(await h.textExistsAnywhere('Hemligt kontrakt')).toBe(false);
    expect(await h.divergences()).toEqual([]);
  });

  it('purges both halves when the thirty days run out', async () => {
    const shortId = await saveMemory('Bor i Malmö');
    const documentId = await uploadDocument('kontrakt.md', 'Villans kontrakt');
    await h.services.ingest.forget(emil, shortId, personalRoom);
    await h.services.documents.remove(emil, documentId);

    await h.expireTrash(shortId);
    await h.expireDocumentTrash();

    // One retention promise, so one sweep — with a document-only blob step inside it rather
    // than a second job on its own schedule.
    const purged = await h.services.trash.purgeExpired();
    expect(purged).toBe(2);
    expect(await h.services.trash.list(emil)).toEqual([]);
    expect(await h.divergences()).toEqual([]);
  });

  it('shows a room-mate nothing from a room they are not in', async () => {
    // The rule the whole product rests on, asserted on the new surface as well: a unified
    // view is a new query, and a new query is a new chance to forget the room filter.
    const shortId = await saveMemory('Bor i Malmö');
    await uploadDocument('kontrakt.md', 'Villans kontrakt').then((id) =>
      h.services.documents.remove(emil, id),
    );
    await h.services.ingest.forget(emil, shortId, personalRoom);

    const stranger = await h.registerPerson('jacob@trash.test', 'Jacob');
    const theirs = await h.services.trash.list(h.actorFor(stranger.person));

    expect(theirs).toEqual([]);
  });
});
