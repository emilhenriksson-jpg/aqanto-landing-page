import { createHash } from 'node:crypto';

import { NotFoundError } from '@photographic/core';
import type { BlobStore, BlobUpload, StoredBlob } from '@photographic/documents';
import { describe, expect, it } from 'vitest';

import { LocalObjectArchive, MANIFEST_KEY, type ObjectArchive } from './archive.js';
import {
  backupDocuments,
  documentBackupCheck,
  readManifest,
  restoreDocuments,
  writeManifest,
} from './document-backup.js';
import type { Queryable } from './postgres-checks.js';

// ---------------------------------------------------------------------------
// A memory-only storage and archive, so these tests need neither Postgres nor a bucket.
// ---------------------------------------------------------------------------

function keyFor(checksum: string): string {
  return `sha256/${checksum.slice(0, 2)}/${checksum.slice(2, 4)}/${checksum}`;
}

class MemoryBlobStore implements BlobStore {
  readonly objects = new Map<string, Uint8Array>();

  async put(bytes: Uint8Array): Promise<StoredBlob> {
    const checksum = createHash('sha256').update(bytes).digest('hex');
    const key = keyFor(checksum);
    const deduplicated = this.objects.has(key);
    this.objects.set(key, bytes);
    return { key, checksum, byteSize: bytes.byteLength, deduplicated };
  }

  async get(key: string): Promise<Uint8Array> {
    const found = this.objects.get(key);
    if (!found) throw new NotFoundError('Filen finns inte längre i lagringen.');
    return found;
  }

  async *getStream(key: string): AsyncIterable<Uint8Array> {
    yield await this.get(key);
  }

  async createUpload(options: { key: string }): Promise<BlobUpload> {
    const chunks: Uint8Array[] = [];
    return {
      write: async (chunk) => {
        chunks.push(chunk);
      },
      complete: async () => {
        const bytes = Buffer.concat(chunks);
        this.objects.set(options.key, bytes);
        return {
          key: options.key,
          checksum: createHash('sha256').update(bytes).digest('hex'),
          byteSize: bytes.byteLength,
          deduplicated: false,
        };
      },
      abort: async () => {
        chunks.length = 0;
      },
    };
  }

  async exists(key: string): Promise<boolean> {
    return this.objects.has(key);
  }

  async delete(key: string): Promise<void> {
    this.objects.delete(key);
  }
}

class MemoryArchive implements ObjectArchive {
  readonly kind = 'local' as const;
  readonly target = 'memory://arkiv';
  readonly objects = new Map<string, Uint8Array>();

  async put(key: string, bytes: Uint8Array): Promise<void> {
    this.objects.set(key, bytes);
  }

  async get(key: string): Promise<Uint8Array | null> {
    return this.objects.get(key) ?? null;
  }

  async exists(key: string): Promise<boolean> {
    return this.objects.has(key);
  }
}

interface Row {
  storage_key: string;
  filename: string;
  byte_size: string;
  checksum: string;
}

/** Just enough Postgres: the document rows, the count, and the sample query. */
function fakeDb(rows: Row[], sample: Row[] = rows): Queryable {
  return {
    query: async <T>(sql: string): Promise<{ rows: T[] }> => {
      if (/count\(\*\)/.test(sql)) return { rows: [{ count: String(rows.length) } as T] };
      if (/created_at < \$1/.test(sql)) return { rows: sample as unknown as T[] };
      if (/app\.document/.test(sql)) return { rows: rows as unknown as T[] };
      throw new Error(`unexpected query: ${sql.slice(0, 60)}`);
    },
  };
}

async function seed(store: MemoryBlobStore, contents: string[]): Promise<Row[]> {
  const rows: Row[] = [];
  for (const [index, text] of contents.entries()) {
    const bytes = new TextEncoder().encode(text);
    const stored = await store.put(bytes);
    rows.push({
      storage_key: stored.key,
      filename: `avtal-${index}.txt`,
      byte_size: String(stored.byteSize),
      checksum: stored.checksum,
    });
  }
  return rows;
}

// ---------------------------------------------------------------------------

describe('backupDocuments', () => {
  it('copies every original the database references, and is incremental afterwards', async () => {
    const store = new MemoryBlobStore();
    const rows = await seed(store, ['ett', 'två', 'tre']);
    const archive = new MemoryArchive();
    const db = fakeDb(rows);

    const first = await backupDocuments({ db, source: store, archive });
    expect(first.copiedThisRun).toBe(3);
    expect(first.objects).toBe(3);
    expect(archive.objects.size).toBe(4); // three originals plus the manifest

    const second = await backupDocuments({ db, source: store, archive });
    expect(second.copiedThisRun).toBe(0);
  });

  it('writes nothing on a dry run but still reports what it found', async () => {
    const store = new MemoryBlobStore();
    const rows = await seed(store, ['ett']);
    const archive = new MemoryArchive();

    const result = await backupDocuments({ db: fakeDb(rows), source: store, archive, dryRun: true });

    expect(result.copiedThisRun).toBe(1);
    expect(result.dryRun).toBe(true);
    expect(archive.objects.size).toBe(0);
  });

  it('names an original that is in neither place instead of finishing quietly', async () => {
    const store = new MemoryBlobStore();
    const rows = await seed(store, ['ett', 'två']);
    store.objects.delete(rows[1]!.storage_key);
    const archive = new MemoryArchive();

    const result = await backupDocuments({ db: fakeDb(rows), source: store, archive });

    expect(result.copiedThisRun).toBe(1);
    expect(result.lost.map((item) => item.filename)).toEqual(['avtal-1.txt']);
  });

  it('reports an original that survives only in the archive as recoverable', async () => {
    const store = new MemoryBlobStore();
    const rows = await seed(store, ['ett', 'två']);
    const archive = new MemoryArchive();
    await backupDocuments({ db: fakeDb(rows), source: store, archive });

    // The bucket loses one file after the backup ran.
    store.objects.delete(rows[0]!.storage_key);
    const later = await backupDocuments({ db: fakeDb(rows), source: store, archive });

    expect(later.lost).toEqual([]);
    expect(later.recoverable.map((item) => item.filename)).toEqual(['avtal-0.txt']);
  });

  it('refuses to archive bytes that do not hash to what the database says', async () => {
    const store = new MemoryBlobStore();
    const rows = await seed(store, ['ett']);
    // Same key, different bytes: corruption that a copy would otherwise make permanent.
    store.objects.set(rows[0]!.storage_key, new TextEncoder().encode('något annat'));
    const archive = new MemoryArchive();

    const result = await backupDocuments({ db: fakeDb(rows), source: store, archive });

    expect(result.copiedThisRun).toBe(0);
    expect(result.mismatched.map((item) => item.filename)).toEqual(['avtal-0.txt']);
    expect(archive.objects.has(rows[0]!.storage_key)).toBe(false);
  });
});

describe('restoreDocuments', () => {
  it('puts back exactly what is missing and leaves the rest alone', async () => {
    const store = new MemoryBlobStore();
    const rows = await seed(store, ['ett', 'två', 'tre']);
    const archive = new MemoryArchive();
    await backupDocuments({ db: fakeDb(rows), source: store, archive });

    // The whole bucket disappears.
    store.objects.clear();
    const result = await restoreDocuments({
      db: fakeDb(rows),
      archive,
      destination: store,
    });

    expect(result.restored).toBe(3);
    expect(result.lost).toEqual([]);
    for (const row of rows) {
      const bytes = await store.get(row.storage_key);
      expect(createHash('sha256').update(bytes).digest('hex')).toBe(row.checksum);
    }

    const again = await restoreDocuments({ db: fakeDb(rows), archive, destination: store });
    expect(again.restored).toBe(0);
    expect(again.intact).toBe(3);
  });

  it('will not write an archived object whose bytes changed underneath it', async () => {
    const store = new MemoryBlobStore();
    const rows = await seed(store, ['ett']);
    const archive = new MemoryArchive();
    await archive.put(rows[0]!.storage_key, new TextEncoder().encode('fördärvad'));
    store.objects.clear();

    const result = await restoreDocuments({ db: fakeDb(rows), archive, destination: store });

    expect(result.restored).toBe(0);
    expect(result.refused.map((item) => item.filename)).toEqual(['avtal-0.txt']);
    expect(store.objects.size).toBe(0);
  });

  it('names what the archive does not have, because someone has to be told', async () => {
    const store = new MemoryBlobStore();
    const rows = await seed(store, ['ett']);
    store.objects.clear();

    const result = await restoreDocuments({ db: fakeDb(rows), archive: new MemoryArchive(), destination: store });

    expect(result.lost.map((item) => item.filename)).toEqual(['avtal-0.txt']);
  });
});

describe('documentBackupCheck', () => {
  const hour = 3_600_000;

  it('is critical when documents exist and no copy does', async () => {
    const store = new MemoryBlobStore();
    const rows = await seed(store, ['ett']);

    const result = await documentBackupCheck({ db: fakeDb(rows), archive: new MemoryArchive() }).run();

    expect(result.status).toBe('failing');
    expect(result.severity).toBe('critical');
    expect(result.title).toContain('kan inte återställas');
  });

  it('is fine when there are no documents yet', async () => {
    const result = await documentBackupCheck({ db: fakeDb([]), archive: new MemoryArchive() }).run();
    expect(result.status).toBe('ok');
  });

  it('passes a fresh, complete copy', async () => {
    const store = new MemoryBlobStore();
    const rows = await seed(store, ['ett', 'två']);
    const archive = new MemoryArchive();
    await backupDocuments({ db: fakeDb(rows), source: store, archive });

    const result = await documentBackupCheck({ db: fakeDb(rows), archive }).run();

    expect(result.status).toBe('ok');
    expect(result.fields).toMatchObject({ archived: 2, probed: 2 });
  });

  it('is critical when the schedule stopped, which is the failure that looks like nothing', async () => {
    const store = new MemoryBlobStore();
    const rows = await seed(store, ['ett']);
    const archive = new MemoryArchive();
    await backupDocuments({
      db: fakeDb(rows),
      source: store,
      archive,
      now: () => new Date(Date.now() - 72 * hour),
    });

    const result = await documentBackupCheck({ db: fakeDb(rows), archive }).run();

    expect(result.status).toBe('failing');
    expect(result.severity).toBe('critical');
    expect(result.title).toContain('kopieringen har stannat');
  });

  it('catches the worse case: a fresh manifest over an archive that is missing objects', async () => {
    const store = new MemoryBlobStore();
    const rows = await seed(store, ['ett', 'två']);
    const archive = new MemoryArchive();
    await backupDocuments({ db: fakeDb(rows), source: store, archive });

    // The manifest stays current while the objects vanish — a job that runs and fails.
    archive.objects.delete(rows[0]!.storage_key);

    const result = await documentBackupCheck({ db: fakeDb(rows), archive }).run();

    expect(result.status).toBe('failing');
    expect(result.severity).toBe('critical');
    expect(result.title).toContain('finns inte i den');
  });

  it('tells the recoverable case apart from the lost one', async () => {
    const store = new MemoryBlobStore();
    const rows = await seed(store, ['ett']);
    const archive = new MemoryArchive();
    await backupDocuments({ db: fakeDb(rows), source: store, archive });
    store.objects.clear();
    await backupDocuments({ db: fakeDb(rows), source: store, archive });

    const result = await documentBackupCheck({ db: fakeDb(rows), archive }).run();

    expect(result.status).toBe('failing');
    expect(result.severity).toBe('warning');
    expect(result.detail).toContain('restore-documents');
  });

  it('reads back a manifest it wrote', async () => {
    const archive = new LocalObjectArchive(
      await (await import('node:fs/promises')).mkdtemp(
        (await import('node:path')).join((await import('node:os')).tmpdir(), 'arkiv-'),
      ),
    );
    const manifest = {
      takenAt: new Date('2026-09-15T03:00:00.000Z').toISOString(),
      documents: 2,
      objects: 2,
      bytes: 10,
      copiedThisRun: 2,
      expectedDigest: 'abc',
      recoverable: [],
      lost: [],
      mismatched: [],
      source: 'blob-store',
      archive: archive.target,
    };

    await writeManifest(archive, manifest);

    expect(await archive.exists(MANIFEST_KEY)).toBe(true);
    expect(await readManifest(archive)).toEqual(manifest);
  });
});

describe('documentBackupCheck with the product storage in hand', () => {
  it('notices an original gone from Storage within a minute, not at the next nightly run', async () => {
    const store = new MemoryBlobStore();
    const rows = await seed(store, ['ett', 'två']);
    const archive = new MemoryArchive();
    await backupDocuments({ db: fakeDb(rows), source: store, archive });

    // The bucket loses a file. The manifest is still fresh and still says everything is fine.
    store.objects.delete(rows[0]!.storage_key);

    const result = await documentBackupCheck({ db: fakeDb(rows), archive, source: store }).run();

    expect(result.status).toBe('failing');
    expect(result.severity).toBe('critical');
    expect(result.title).toContain('försvunnit ur Storage');
    expect(result.detail).toContain('restore-documents');
  });

  it('says plainly when neither side has it', async () => {
    const store = new MemoryBlobStore();
    const rows = await seed(store, ['ett']);
    const archive = new MemoryArchive();
    await writeManifest(archive, {
      takenAt: new Date().toISOString(),
      documents: 1,
      objects: 1,
      bytes: 3,
      copiedThisRun: 1,
      expectedDigest: 'x',
      recoverable: [],
      lost: [],
      mismatched: [],
      source: 'blob-store',
      archive: archive.target,
    });
    store.objects.clear();

    const result = await documentBackupCheck({ db: fakeDb(rows), archive, source: store }).run();

    expect(result.status).toBe('failing');
    expect(result.detail).toContain('borta');
  });
});
