import { STORAGE_LIMIT_BYTES } from '@photographic/core';
import { describe, expect, it } from 'vitest';

import { assertAcceptableUpload, ingestDocument } from './ingest.js';
import { formatBytes, storageLimitReached } from './limit.js';
import { MemoryBlobStore, MemoryStorageLedger } from './testing/index.js';
import { makePdf } from './testing/fixtures.js';

const utf8 = (text: string) => new TextEncoder().encode(text);

describe('assertAcceptableUpload', () => {
  it('refuses an empty file', () => {
    expect(() => assertAcceptableUpload({ filename: 'tom.txt', byteSize: 0 })).toThrow('är tom');
  });

  it('refuses a file over the size ceiling, in Swedish with both numbers', () => {
    expect(() =>
      assertAcceptableUpload({ filename: 'stor.pdf', byteSize: 2048, maxBytes: 1024 }),
    ).toThrow(/stor\.pdf.*2 kB.*1 kB/s);
  });

  it('accepts a file at exactly the ceiling', () => {
    expect(() =>
      assertAcceptableUpload({ filename: 'precis.pdf', byteSize: 1024, maxBytes: 1024 }),
    ).not.toThrow();
  });
});

describe('ingestDocument', () => {
  it('stores the bytes, extracts the text and chunks it', async () => {
    const blobs = new MemoryBlobStore();
    const result = await ingestDocument({
      blobs,
      bytes: utf8('# Mallorca\n\nHuset är bokat i juli.'),
      filename: 'resa.md',
      mimeType: 'text/markdown',
    });

    expect(result.stored.checksum).toHaveLength(64);
    expect(result.stored.deduplicated).toBe(false);
    expect(result.extraction.outcome).toBe('extracted');
    expect(result.chunks).toHaveLength(1);
    expect(result.chunks[0]!.heading).toBe('Mallorca');
    expect(await blobs.get(result.stored.key)).toEqual(utf8('# Mallorca\n\nHuset är bokat i juli.'));
  });

  it('keeps the original bytes byte-for-byte, not the extracted text', async () => {
    // The promise is that the source is always reachable. A PDF whose stored bytes are
    // its own extracted text is a PDF we have quietly thrown away.
    const blobs = new MemoryBlobStore();
    const pdf = makePdf(['Buyersclub Ledning']);

    const result = await ingestDocument({
      blobs,
      bytes: pdf,
      filename: 'protokoll.pdf',
      mimeType: 'application/pdf',
    });

    expect(await blobs.get(result.stored.key)).toEqual(pdf);
    expect(result.extraction.text).toContain('Buyersclub Ledning');
  });

  it('stores the file even when there is no text to extract', async () => {
    // Losing someone's document because we could not parse it is the one outcome that
    // is never acceptable.
    const blobs = new MemoryBlobStore();
    const result = await ingestDocument({
      blobs,
      bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]),
      filename: 'semester.png',
      mimeType: 'image/png',
    });

    expect(result.extraction.outcome).toBe('unsupported');
    expect(result.chunks).toEqual([]);
    expect(await blobs.exists(result.stored.key)).toBe(true);
  });

  it('deduplicates the same bytes to one object', async () => {
    const blobs = new MemoryBlobStore();
    const bytes = utf8('samma innehåll');

    const first = await ingestDocument({ blobs, bytes, filename: 'a.txt', mimeType: 'text/plain' });
    const second = await ingestDocument({ blobs, bytes, filename: 'b.txt', mimeType: 'text/plain' });

    expect(second.stored.key).toBe(first.stored.key);
    expect(second.stored.deduplicated).toBe(true);
    expect(blobs.size).toBe(1);
  });

  it('reserves storage after the checksum is known and before any text is read', async () => {
    // The order is the guarantee. The checksum is not knowable before the bytes are
    // written, so a limit checked earlier would be trusting a client-declared length.
    const blobs = new MemoryBlobStore();
    const seen: string[] = [];

    await ingestDocument({
      blobs,
      bytes: utf8('lite text'),
      filename: 'a.txt',
      mimeType: 'text/plain',
      reserve: async (stored) => {
        seen.push(stored.checksum);
        expect(await blobs.exists(stored.key)).toBe(true);
      },
    });

    expect(seen).toHaveLength(1);
  });

  it('propagates a refusal from reserve', async () => {
    const blobs = new MemoryBlobStore();

    await expect(
      ingestDocument({
        blobs,
        bytes: utf8('lite text'),
        filename: 'a.txt',
        mimeType: 'text/plain',
        reserve: async () => {
          throw storageLimitReached({
            filename: 'a.txt',
            byteSize: 9,
            usage: { bytesUsed: 10, limitBytes: 10, objectCount: 1 },
          });
        },
      }),
    ).rejects.toThrow('inte plats');
  });

  it('refuses an oversized file before writing anything', async () => {
    const blobs = new MemoryBlobStore();

    await expect(
      ingestDocument({
        blobs,
        bytes: new Uint8Array(4096),
        filename: 'stor.txt',
        mimeType: 'text/plain',
        maxBytes: 1024,
      }),
    ).rejects.toThrow('Största filstorlek');

    expect(blobs.size).toBe(0);
  });
});

describe('MemoryStorageLedger', () => {
  it('starts a person at zero', async () => {
    const ledger = new MemoryStorageLedger();
    expect(await ledger.usage('p1')).toEqual({
      bytesUsed: 0,
      limitBytes: STORAGE_LIMIT_BYTES,
      objectCount: 0,
    });
  });

  it('charges a new object and refuses one that would not fit', async () => {
    const ledger = new MemoryStorageLedger(1000);

    const first = await ledger.reserve({
      personId: 'p1',
      checksum: 'a',
      byteSize: 600,
      storageKey: 'k1',
    });
    expect(first).toMatchObject({ allowed: true, deduplicated: false, bytesUsed: 600 });

    const second = await ledger.reserve({
      personId: 'p1',
      checksum: 'b',
      byteSize: 600,
      storageKey: 'k2',
    });
    expect(second).toMatchObject({ allowed: false, bytesUsed: 600 });
  });

  it('charges identical bytes once and allows the re-upload even at the limit', async () => {
    // A phone retrying a failed 40 MB upload is the path that most needs to be
    // idempotent, and it consumes nothing new.
    const ledger = new MemoryStorageLedger(1000);
    await ledger.reserve({ personId: 'p1', checksum: 'a', byteSize: 1000, storageKey: 'k' });

    const again = await ledger.reserve({
      personId: 'p1',
      checksum: 'a',
      byteSize: 1000,
      storageKey: 'k',
    });

    expect(again).toMatchObject({ allowed: true, deduplicated: true, bytesUsed: 1000 });
  });

  it("never lets one person's usage reveal another's", async () => {
    const ledger = new MemoryStorageLedger(1000);
    await ledger.reserve({ personId: 'p1', checksum: 'a', byteSize: 900, storageKey: 'k' });

    const other = await ledger.reserve({
      personId: 'p2',
      checksum: 'a',
      byteSize: 900,
      storageKey: 'k',
    });

    expect(other).toMatchObject({ allowed: true, deduplicated: false });
    expect((await ledger.usage('p2')).bytesUsed).toBe(900);
  });

  it('frees the space only when the last reference goes', async () => {
    const ledger = new MemoryStorageLedger(1000);
    await ledger.reserve({ personId: 'p1', checksum: 'a', byteSize: 500, storageKey: 'k' });
    await ledger.reserve({ personId: 'p1', checksum: 'a', byteSize: 500, storageKey: 'k' });

    expect(await ledger.release({ personId: 'p1', checksum: 'a' })).toBe(false);
    expect((await ledger.usage('p1')).bytesUsed).toBe(500);

    expect(await ledger.release({ personId: 'p1', checksum: 'a' })).toBe(true);
    expect((await ledger.usage('p1')).bytesUsed).toBe(0);
  });
});

describe('formatBytes', () => {
  it('reads like a Swedish file manager', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1536)).toBe('1,5 kB');
    expect(formatBytes(10 * 1024 * 1024 * 1024)).toBe('10 GB');
  });
});
