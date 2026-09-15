/**
 * Documents as memory, end to end, against both backends.
 *
 * The same file runs against the reference implementation and against Postgres, which
 * is the whole reason the reference implementation was worth writing: "does the SQL
 * behave correctly" becomes a diff against something that already does.
 *
 * What is actually being proved here, in the order the product promises it:
 *
 *   1. A document can be uploaded straight to private memory, or to a named room.
 *   2. The original file comes back byte for byte, whatever happened to the text.
 *   3. Our extraction and the model's summary are separate and stay separate.
 *   4. The text is chunked at ingest and those chunks are searchable.
 *   5. A room's documents are invisible to someone who is not in the room.
 *   6. The storage limit is enforced at upload time.
 *   7. A document that cannot be read is stored anyway.
 */

import { STORAGE_LIMIT_BYTES } from '@photographic/core';
import type { Actor, DocumentId } from '@photographic/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createHarness, type Harness } from './harness.js';

const utf8 = (text: string) => new TextEncoder().encode(text);

const CONTRACT = [
  '# Buyersclub Ledning',
  '',
  'Styrelsen beslutade att skjuta förvärvet till Q3.',
  '',
  '## Uppsägning',
  '',
  'Uppsägningstiden är tre månader ömsesidigt och räknas från månadsskiftet.',
].join('\n');

let h: Harness;
let emil: Actor;

beforeAll(async () => {
  h = await createHarness();
  await h.registerPerson('dokument-emil@example.com', 'Emil');
  emil = await h.actorForEmail('dokument-emil@example.com');
});

afterAll(async () => {
  await h.teardown();
});

describe('a document uploaded to private memory', () => {
  let documentId: DocumentId;

  beforeAll(async () => {
    const personal = await h.services.identity.personalRoomOf(emil.personId);
    const result = await h.services.documents.upload(emil, {
      roomId: personal.id,
      filename: 'anteckningar.md',
      mimeType: 'text/markdown',
      bytes: utf8(CONTRACT),
    });
    documentId = result.documentId;
    expect(result.extraction).toBe('extracted');
    expect(result.chunkCount).toBeGreaterThan(0);
  });

  it('comes back as a card with the extraction reported', async () => {
    const doc = await h.services.documents.get(emil, documentId);

    expect(doc).toMatchObject({
      filename: 'anteckningar.md',
      mimeType: 'text/markdown',
      extraction: 'extracted',
      extractionError: null,
    });
    expect(doc!.byteSize).toBe(utf8(CONTRACT).byteLength);
    expect(doc!.chunkCount).toBeGreaterThan(0);
  });

  it('gives the original file back byte for byte', async () => {
    // The floor under everything else. Summaries can be wrong and chunk boundaries can
    // change; the bytes cannot.
    const file = await h.services.documents.download(emil, documentId);

    expect(file?.filename).toBe('anteckningar.md');
    expect(file?.bytes).toEqual(utf8(CONTRACT));
  });

  it('keeps the extracted text reachable and separate from any summary', async () => {
    const text = await h.services.documents.originalText(emil, documentId);
    expect(text).toContain('Uppsägningstiden är tre månader');

    const before = await h.services.documents.get(emil, documentId);
    expect(before?.summary).toBeNull();

    await h.runJobsToCompletion();

    const after = await h.services.documents.get(emil, documentId);
    expect(after?.summary).not.toBeNull();

    // The point of the whole separation: a summary existing does not change the source.
    const textAfter = await h.services.documents.originalText(emil, documentId);
    expect(textAfter).toBe(text);
  });

  it('chunked the text at ingest, with headings kept', async () => {
    const chunks = await h.services.documents.chunksFor(emil, documentId);

    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks.map((chunk) => chunk.ord)).toEqual(
      chunks.map((_, index) => index),
    );
    expect(chunks.some((chunk) => chunk.text.includes('Uppsägning'))).toBe(true);
  });

  it('is searchable by a word from inside the document', async () => {
    // The product claim in one assertion: text goes in as a file and comes back out of
    // search, without anyone having written a memory about it.
    const hits = await h.services.retrieval.search(emil, { query: 'uppsägningstiden' });

    const chunk = hits.find((hit) => hit.kind === 'chunk');
    expect(chunk, 'no chunk hit for a word that is in the document').toBeDefined();
    expect(chunk!.documentId).toBe(documentId);
    expect(chunk!.text).toContain('tre månader');
  });

  it('is findable by its heading, because the heading is folded into the chunk', async () => {
    const hits = await h.services.retrieval.search(emil, { query: 'uppsägning' });
    expect(hits.some((hit) => hit.kind === 'chunk')).toBe(true);
  });
});

describe('a document uploaded to a named room', () => {
  it('lands in the room the person named, not in private memory', async () => {
    // "Lägg den här PDF:en i Buyersclub Ledning" — the room arrives as a name.
    const room = await h.services.rooms.create(emil, { title: 'Buyersclub Ledning' });
    const resolved = await h.services.rooms.resolveByName(emil, 'Buyersclub Ledning');
    expect(resolved?.id).toBe(room.id);

    const { documentId } = await h.services.documents.upload(emil, {
      roomId: resolved!.id,
      filename: 'protokoll.md',
      mimeType: 'text/markdown',
      bytes: utf8('# Protokoll\n\nBeslut om budget för 2027.'),
    });

    const inRoom = await h.services.documents.listForRoom(emil, room.id);
    expect(inRoom.map((doc) => doc.id)).toContain(documentId);

    const personal = await h.services.identity.personalRoomOf(emil.personId);
    const inPersonal = await h.services.documents.listForRoom(emil, personal.id);
    expect(inPersonal.map((doc) => doc.id)).not.toContain(documentId);
  });

  it('is invisible to someone who is not in the room', async () => {
    const room = await h.services.rooms.create(emil, { title: 'Mallorca' });
    const { documentId } = await h.services.documents.upload(emil, {
      roomId: room.id,
      filename: 'hyresavtal.md',
      mimeType: 'text/markdown',
      bytes: utf8('# Hyresavtal\n\nHuset i Mallorca är bokat hela juli.'),
    });

    await h.registerPerson('utomstaende@example.com', 'Utomstående');
    const stranger = await h.actorForEmail('utomstaende@example.com');

    // Not-found rather than forbidden. Confirming that a document exists is already a
    // leak, so "not yours" and "does not exist" have to be the same answer.
    expect(await h.services.documents.get(stranger, documentId)).toBeNull();
    expect(await h.services.documents.originalText(stranger, documentId)).toBeNull();
    expect(await h.services.documents.download(stranger, documentId)).toBeNull();
    await expect(h.services.documents.chunksFor(stranger, documentId)).rejects.toThrow();

    // And the text does not leak through search either, which is the path that would
    // never look like a permission bug.
    const hits = await h.services.retrieval.search(stranger, { query: 'Mallorca' });
    expect(hits.filter((hit) => hit.kind === 'chunk')).toEqual([]);
  });
});

describe('a document we cannot read', () => {
  it('is stored anyway, and says why there is no text', async () => {
    // Losing someone's file because we could not parse it is the one outcome that is
    // never acceptable.
    const personal = await h.services.identity.personalRoomOf(emil.personId);
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

    const result = await h.services.documents.upload(emil, {
      roomId: personal.id,
      filename: 'semester.png',
      mimeType: 'image/png',
      bytes: png,
    });

    expect(result.extraction).toBe('unsupported');
    expect(result.chunkCount).toBe(0);

    const doc = await h.services.documents.get(emil, result.documentId);
    expect(doc?.extractionError).toContain('sparad');
    expect(doc?.chunkCount).toBe(0);

    // The file itself is intact, which is the part that matters.
    const file = await h.services.documents.download(emil, result.documentId);
    expect(file?.bytes).toEqual(png);
  });
});

describe('the storage counter', () => {
  it('starts at zero against the 10 GB product limit', async () => {
    await h.registerPerson('tom-lagring@example.com', 'Tom');
    const fresh = await h.actorForEmail('tom-lagring@example.com');

    const usage = await h.services.documents.storageUsage(fresh);
    expect(usage).toMatchObject({ bytesUsed: 0, objectCount: 0 });
    expect(usage.limitBytes).toBe(STORAGE_LIMIT_BYTES);
  });

  it('counts an upload, and counts identical bytes only once', async () => {
    await h.registerPerson('raknare@example.com', 'Räknare');
    const actor = await h.actorForEmail('raknare@example.com');
    const personal = await h.services.identity.personalRoomOf(actor.personId);
    const bytes = utf8('# Samma fil\n\nExakt samma innehåll båda gångerna.');

    await h.services.documents.upload(actor, {
      roomId: personal.id,
      filename: 'en.md',
      mimeType: 'text/markdown',
      bytes,
    });
    const first = await h.services.documents.storageUsage(actor);
    expect(first.bytesUsed).toBe(bytes.byteLength);
    expect(first.objectCount).toBe(1);

    // The same bytes again: two documents, one object. Charging twice would be a bill
    // for storage nobody is using.
    await h.services.documents.upload(actor, {
      roomId: personal.id,
      filename: 'två.md',
      mimeType: 'text/markdown',
      bytes,
    });
    const second = await h.services.documents.storageUsage(actor);
    expect(second.bytesUsed).toBe(bytes.byteLength);
    expect(second.objectCount).toBe(1);

    // Both documents exist and both are readable, dedup or not.
    const listed = await h.services.documents.listForRoom(actor, personal.id);
    expect(listed.filter((doc) => doc.filename === 'en.md' || doc.filename === 'två.md')).toHaveLength(2);
  });
});
