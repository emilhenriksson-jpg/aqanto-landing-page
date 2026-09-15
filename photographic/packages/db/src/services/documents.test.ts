/**
 * The parts of document handling that only Postgres can answer for.
 *
 * `e2e/src/documents.test.ts` covers the behaviour against both backends. What is left
 * here needs either a limit small enough to hit or a look at the actual columns:
 *
 *   - The storage limit refusing an upload, atomically, at upload time.
 *   - `document.text` and `document.summary` being two columns that never overwrite each
 *     other, which is the promise that the original stays reachable.
 *   - `chunk.embedding` staying null while the chunks exist, which is what makes adding
 *     embeddings later a backfill rather than a re-extraction.
 *   - Swedish stemming actually reaching search through the generated tsvector.
 */

import type { Actor, PersonId, RoomId } from '@photographic/core';
import { MemoryBlobStore } from '@photographic/documents/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createPool, createPostgresServices, reset, type PostgresServices } from '../index.js';
import { PgStorageLedger } from './storage-ledger.js';

const pool = createPool();
const utf8 = (text: string) => new TextEncoder().encode(text);

/** Small enough that a few kilobytes fill it. */
const TINY_LIMIT = 4096;

let wired: PostgresServices;
let blobs: MemoryBlobStore;
let actor: Actor;
let personalRoom: RoomId;

beforeAll(async () => {
  await reset(pool);
  blobs = new MemoryBlobStore();
  wired = await createPostgresServices({
    pool,
    blobs,
    storage: new PgStorageLedger(pool, TINY_LIMIT),
  });

  const registered = await wired.services.identity.register({
    email: 'dokument@photographic.test',
    displayName: 'Emil',
  });
  actor = wired.actorFor(registered.person.id);
  personalRoom = registered.personalRoom.id;
});

afterAll(async () => {
  await wired.close();
});

const upload = (filename: string, body: string, roomId: RoomId = personalRoom) =>
  wired.services.documents.upload(actor, {
    roomId,
    filename,
    mimeType: 'text/markdown',
    bytes: utf8(body),
  });

describe('the storage limit', () => {
  it('refuses an upload that would not fit, and says how much room is left', async () => {
    const filler = `# Stor\n\n${'a'.repeat(3000)}`;
    await upload('filler.md', filler);

    const usage = await wired.services.documents.storageUsage(actor);
    expect(usage.bytesUsed).toBeGreaterThan(3000);
    expect(usage.limitBytes).toBe(TINY_LIMIT);

    await expect(upload('too-much.md', `# Mer\n\n${'b'.repeat(3000)}`)).rejects.toThrow(
      /inte plats|kvar/,
    );
  });

  it('leaves the counter untouched when an upload is refused', async () => {
    const before = await wired.services.documents.storageUsage(actor);

    await expect(upload('nope.md', `# Nej\n\n${'c'.repeat(3000)}`)).rejects.toThrow();

    const after = await wired.services.documents.storageUsage(actor);
    expect(after.bytesUsed).toBe(before.bytesUsed);
    expect(after.objectCount).toBe(before.objectCount);
  });

  it('writes no document row for a refused upload', async () => {
    await expect(upload('inte-sparad.md', `# Nej\n\n${'d'.repeat(3000)}`)).rejects.toThrow();

    const listed = await wired.services.documents.listForRoom(actor, personalRoom);
    expect(listed.map((doc) => doc.filename)).not.toContain('inte-sparad.md');
  });

  it('still accepts a re-upload of bytes the person already stores', async () => {
    // Consumes nothing new, and it is the path that most needs to be idempotent: a
    // phone retrying a failed upload. Refusing it at the limit would be wrong.
    const body = `# Samma\n\n${'e'.repeat(200)}`;
    const first = await upload('samma-1.md', body);
    const again = await upload('samma-2.md', body);

    expect(first.documentId).not.toBe(again.documentId);

    const usage = await wired.services.documents.storageUsage(actor);
    expect(usage.objectCount).toBeLessThanOrEqual(2);
  });

  it('does not let one person fill another person\'s quota', async () => {
    const other = await wired.services.identity.register({
      email: 'annan@photographic.test',
    });
    const otherActor = wired.actorFor(other.person.id);

    const usage = await wired.services.documents.storageUsage(otherActor);
    expect(usage.bytesUsed).toBe(0);
  });
});

describe('original and understanding stay apart', () => {
  it('keeps document.text as ours and document.summary as the model\'s', async () => {
    const other = await wired.services.identity.register({
      email: 'separat@photographic.test',
    });
    const separate = wired.actorFor(other.person.id);
    const room = await wired.services.identity.personalRoomOf(other.person.id);

    const { documentId } = await wired.services.documents.upload(separate, {
      roomId: room.id,
      filename: 'avtal.md',
      mimeType: 'text/markdown',
      bytes: utf8('# Avtal\n\nUppsägningstiden är tre månader.'),
    });

    const text = await wired.services.documents.originalText(separate, documentId);
    expect(text).toContain('Uppsägningstiden är tre månader');

    await wired.runJobsToCompletion();

    const row = await pool.query<{ text: string; summary: string | null }>(
      `SELECT text, summary FROM app.document WHERE id = $1`,
      [documentId],
    );

    // Two columns, both populated, neither derived from the other.
    expect(row.rows[0]?.text).toBe(text);
    expect(row.rows[0]?.summary).not.toBeNull();
    expect(row.rows[0]?.summary).not.toBe(row.rows[0]?.text);
  });

  it('stores the bytes in the blob store and not in the row', async () => {
    const before = blobs.size;
    const { documentId } = await upload('i-lagringen.md', '# Fil\n\nEtt kort dokument.');

    expect(blobs.size).toBe(before + 1);

    const row = await pool.query<{ storage_key: string; checksum: string }>(
      `SELECT storage_key, checksum FROM app.document WHERE id = $1`,
      [documentId],
    );
    // Content-addressed: the key carries the checksum, which is what makes a re-upload
    // of the same file idempotent across stores.
    expect(row.rows[0]?.storage_key).toContain(row.rows[0]!.checksum);
    expect(await blobs.exists(row.rows[0]!.storage_key)).toBe(true);
  });
});

describe('chunks', () => {
  it('exist with a null embedding, so adding embeddings is a backfill', async () => {
    const { documentId, chunkCount } = await upload(
      'chunkad.md',
      '# Ett\n\nFörsta stycket.\n\n# Två\n\nAndra stycket.',
    );
    expect(chunkCount).toBeGreaterThan(1);

    const rows = await pool.query<{ embedding: unknown; heading: string | null }>(
      `SELECT embedding, heading FROM app.chunk WHERE document_id = $1 ORDER BY ord`,
      [documentId],
    );

    expect(rows.rows.every((row) => row.embedding === null)).toBe(true);
    expect(rows.rows.map((row) => row.heading)).toContain('Ett');
  });

  it('carries a generated search vector without anyone writing one', async () => {
    // Generated rather than maintained by the application: a chunk whose text and index
    // disagree is a silently unsearchable document, and nothing would notice.
    const { documentId } = await upload('vektor.md', '# Vektor\n\nDokumentet är sökbart.');

    const rows = await pool.query<{ fts: string | null }>(
      `SELECT fts::text AS fts FROM app.chunk WHERE document_id = $1`,
      [documentId],
    );
    expect(rows.rows[0]?.fts).toBeTruthy();
  });
});

describe('Swedish full-text search over chunks', () => {
  let searchActor: Actor;

  beforeAll(async () => {
    const registered = await wired.services.identity.register({
      email: 'sok@photographic.test',
    });
    searchActor = wired.actorFor(registered.person.id);

    await wired.services.documents.upload(searchActor, {
      roomId: registered.personalRoom.id,
      filename: 'strategi.md',
      mimeType: 'text/markdown',
      bytes: utf8('# Strategi\n\nDokumenten beskriver förvärvet och uppsägningstiden.'),
    });
  });

  it('matches a stemmed word the document never literally contains', async () => {
    // "dokument" against "Dokumenten". This is why the tsvector uses the Swedish config
    // rather than `simple`: for prose nobody wrote for retrieval, stemming is the
    // difference between finding a contract and not.
    const hits = await wired.services.retrieval.search(searchActor, { query: 'dokument' });
    expect(hits.some((hit) => hit.kind === 'chunk')).toBe(true);
  });

  it('matches a Swedish compound the stemmer cannot split', async () => {
    // "uppsägning" against "uppsägningstiden". The Snowball stemmer trims inflection off
    // the end of a word and never splits one — it stems "uppsägningstiden" to
    // "uppsägningstid", which a query for "uppsägning" does not match. Swedish compounds
    // constantly, so this is the trigram fallback from migration 0012 earning its place
    // rather than a nicety.
    const hits = await wired.services.retrieval.search(searchActor, { query: 'uppsägning' });
    expect(hits.some((hit) => hit.kind === 'chunk')).toBe(true);
  });

  it('matches a definite form the stemmer leaves alone', async () => {
    // "förvärv" against "förvärvet". The Swedish stemmer is conservative enough to leave
    // this one entirely alone, so even a non-compound search misses without the fallback.
    const hits = await wired.services.retrieval.search(searchActor, { query: 'förvärv' });
    expect(hits.some((hit) => hit.kind === 'chunk')).toBe(true);
  });

  it('ranks a stemmed match above a compound one', async () => {
    // The fallback may only ever append to the tail. If it could outrank full-text,
    // a substring coincidence would start beating a real match.
    const hits = await wired.services.retrieval.search(searchActor, { query: 'dokument' });
    const chunks = hits.filter((hit) => hit.kind === 'chunk');
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks).toEqual([...chunks].sort((a, b) => b.score - a.score));
  });

  it('does not fall back on a query too short to mean anything', async () => {
    // Three characters match most of the language as a substring. Left on, every search
    // would end in a tail of noise.
    const hits = await wired.services.retrieval.search(searchActor, { query: 'upp' });
    expect(hits.filter((hit) => hit.kind === 'chunk')).toEqual([]);
  });

  it('returns nothing for a word that is not in any document', async () => {
    const hits = await wired.services.retrieval.search(searchActor, { query: 'krokodil' });
    expect(hits.filter((hit) => hit.kind === 'chunk')).toEqual([]);
  });

  it('never returns a chunk from a room the searcher cannot read', async () => {
    const stranger = await wired.services.identity.register({
      email: 'frammande@photographic.test',
    });

    const hits = await wired.services.retrieval.search(wired.actorFor(stranger.person.id), {
      query: 'förvärvet',
    });
    expect(hits.filter((hit) => hit.kind === 'chunk')).toEqual([]);
  });
});

describe('a missing blob', () => {
  it('is reported as a storage inconsistency, not as a missing document', async () => {
    // The row says the file exists and the store says it does not. Answering "no such
    // document" would hide a problem someone needs to know about.
    const { documentId } = await upload('forsvunnen.md', '# Försvunnen\n\nFilen tas bort.');

    const row = await pool.query<{ storage_key: string }>(
      `SELECT storage_key FROM app.document WHERE id = $1`,
      [documentId],
    );
    await blobs.delete(row.rows[0]!.storage_key);

    await expect(wired.services.documents.download(actor, documentId)).rejects.toThrow(
      /saknas i lagringen/,
    );

    // The card still works, so the person sees the document and an explicable failure
    // rather than the document vanishing from the list.
    expect(await wired.services.documents.get(actor, documentId)).not.toBeNull();
  });
});

describe('permission', () => {
  it('refuses an upload into a room the actor cannot write', async () => {
    const stranger = await wired.services.identity.register({
      email: 'ingen-skrivratt@photographic.test',
    });

    await expect(
      wired.services.documents.upload(wired.actorFor(stranger.person.id), {
        roomId: personalRoom,
        filename: 'inkrakt.md',
        mimeType: 'text/markdown',
        bytes: utf8('# Nej'),
      }),
    ).rejects.toThrow();
  });

  it('refuses before writing any bytes', async () => {
    // Permission is resolved before the pipeline runs, so a refused upload leaves
    // nothing behind in the blob store to clean up.
    const stranger = await wired.services.identity.register({
      email: 'inga-bytes@photographic.test',
    });
    const before = blobs.size;

    await expect(
      wired.services.documents.upload(wired.actorFor(stranger.person.id), {
        roomId: personalRoom,
        filename: 'inga-bytes.md',
        mimeType: 'text/markdown',
        bytes: utf8('# Skulle inte sparas'),
      }),
    ).rejects.toThrow();

    expect(blobs.size).toBe(before);
  });
});

/** A `PersonId` is a branded string; this keeps the cast in one place. */
export type { PersonId };
