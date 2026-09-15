/**
 * The export as an escape hatch, tested where it used to break.
 *
 * Three failures, all of them about the person with the most data — who is precisely the
 * person who most needs to be able to leave:
 *
 *   - The archive was assembled in memory and then uploaded, on a machine with two
 *     gigabytes, against a ten-gigabyte product limit. Here the whole build is driven
 *     through a blob store that streams, and the memory used is measured rather than
 *     assumed.
 *   - An export claimed by a process that then died sat at `running` for ever: the person
 *     asked to take their memory with them and got a spinner. Here a worker is killed the
 *     honest way — claim, never finish, let the lease lapse — and the export comes back.
 *   - The download link lasted a week and could be replayed by anyone holding it, for the
 *     single most concentrated object in the product. Here it is spent by a completed
 *     transfer and answers afterwards exactly as a link that never existed.
 *
 * `packages/db/src/services/account.test.ts` covers the ordinary export path; this file is
 * only the durability.
 */

import type { Actor, RoomId } from '@photographic/core';
import { MemoryBlobStore } from '@photographic/documents/testing';
import type { BlobStore, BlobUpload, StoredBlob } from '@photographic/documents';
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createPool, createPostgresServices, reset, type PostgresServices } from '../index.js';
import { PgExports } from './exports.js';

const pool = createPool();
const utf8 = (text: string) => new TextEncoder().encode(text);

let wired: PostgresServices;
let blobs: MemoryBlobStore;
let exports: PgExports;
let emil: Actor;
let personalRoom: RoomId;

beforeAll(async () => {
  await reset(pool);
  blobs = new MemoryBlobStore();
  wired = await createPostgresServices({ pool, blobs });

  const registered = await wired.services.identity.register({
    email: 'export-durability@photographic.test',
    displayName: 'Emil',
  });
  emil = wired.actorFor(registered.person.id);
  personalRoom = registered.personalRoom.id;
  exports = new PgExports(pool, blobs, { worker: 'test-worker' });

  await wired.services.ingest.remember(emil, {
    roomId: personalRoom,
    body: 'allergisk mot ketchup',
    confirmed: true,
  });
});

afterAll(async () => {
  await wired.close();
});

/**
 * A blob store that streams uploads away and never keeps them.
 *
 * What a real multipart upload looks like from memory's point of view, and the only way to
 * put gigabytes through the build in a test without a bucket. Documents come from the
 * generator, so the *source* is not resident either.
 */
class StreamingTestStore implements BlobStore {
  uploaded = 0;
  uploadChecksum: string | null = null;
  aborted = 0;
  completed = 0;
  /** Documents this store pretends to hold: key to byte length. */
  readonly documents = new Map<string, number>();

  async put(bytes: Uint8Array): Promise<StoredBlob> {
    const checksum = createHash('sha256').update(bytes).digest('hex');
    return { key: `sha256/${checksum}`, checksum, byteSize: bytes.byteLength, deduplicated: false };
  }

  async get(): Promise<Uint8Array> {
    throw new Error('this store only streams');
  }

  getStream(key: string): AsyncIterable<Uint8Array> {
    const size = this.documents.get(key) ?? 0;
    return {
      async *[Symbol.asyncIterator]() {
        const chunk = new Uint8Array(256 * 1024).fill(0x41);
        let left = size;
        while (left > 0) {
          const take = Math.min(chunk.byteLength, left);
          left -= take;
          yield take === chunk.byteLength ? chunk : chunk.subarray(0, take);
        }
      },
    };
  }

  async createUpload(): Promise<BlobUpload> {
    const hash = createHash('sha256');
    let byteSize = 0;
    const self = this;

    return {
      async write(chunk) {
        hash.update(chunk);
        byteSize += chunk.byteLength;
        self.uploaded += chunk.byteLength;
      },
      async complete() {
        self.completed += 1;
        self.uploadChecksum = hash.digest('hex');
        return { key: 'exports/streamed.zip', checksum: self.uploadChecksum, byteSize, deduplicated: false };
      },
      async abort() {
        self.aborted += 1;
      },
    };
  }

  async exists(): Promise<boolean> {
    return true;
  }

  async delete(): Promise<void> {}
}

describe('the archive is never resident', () => {
  it(
    'streams a multi-gigabyte export through without accumulating it',
    async () => {
      // A person with several gigabytes of documents, which is what the ten-gigabyte limit
      // is for and what the old implementation could not do at all. The bytes are generated
      // and discarded at both ends, so what is being measured is exactly what the build
      // holds on to.
      const store = new StreamingTestStore();
      const streaming = new PgExports(pool, store, { worker: 'stream-worker' });

      const big = await wired.services.identity.register({
        email: 'stor-export@photographic.test',
        displayName: 'Stor',
      });
      const bigActor = wired.actorFor(big.person.id);

      const documentBytes = 512 * 1024 * 1024;
      for (let i = 0; i < 6; i += 1) {
        const key = `sha256/big-${i}`;
        store.documents.set(key, documentBytes);
        await pool.query(
          `INSERT INTO app.document
             (room_id, filename, mime_type, byte_size, storage_key, checksum, uploaded_by,
              extraction_status, extracted_at)
           VALUES ($1, $2, 'application/pdf', $3, $4, $5, $6, 'extracted', now())`,
          [
            big.personalRoom.id,
            `stor-${i}.pdf`,
            documentBytes,
            key,
            `big-${i}`,
            big.person.id,
          ],
        );
      }

      const requested = await streaming.request(bigActor);

      global.gc?.();
      const before = process.memoryUsage();
      const finished = await streaming.run(requested.id);
      const after = process.memoryUsage();

      expect(finished?.status).toBe('ready');
      // Three gigabytes of documents plus the log, through a two-gigabyte machine.
      expect(finished!.byteSize!).toBeGreaterThan(6 * documentBytes);
      expect(store.uploaded).toBe(finished!.byteSize);
      // The archive's digest is computed as it streams rather than by reading it back.
      expect(finished?.checksum).toBe(store.uploadChecksum);

      // A constant, not a fraction of the archive. Holding even one document would show up
      // here as hundreds of megabytes.
      expect(after.heapUsed - before.heapUsed).toBeLessThan(96 * 1024 * 1024);
      expect(after.arrayBuffers - before.arrayBuffers).toBeLessThan(96 * 1024 * 1024);
    },
    { timeout: 10 * 60 * 1000 },
  );

  it('abandons the half-written object when a build fails', async () => {
    // A multipart upload nobody aborted is billed for its parts, and an archive left under
    // a key a download link can reach is worse than no archive.
    const store = new StreamingTestStore();
    const failing = new PgExports(pool, store, { worker: 'failing-worker' });
    const requested = await failing.request(emil);

    store.documents.clear();
    const broken = new Proxy(store, {
      get(target, property, receiver) {
        if (property === 'createUpload') {
          return async () => ({
            write: async () => {
              throw new Error('lagringen svarade inte');
            },
            complete: async () => {
              throw new Error('unreachable');
            },
            abort: async () => {
              target.aborted += 1;
            },
          });
        }
        return Reflect.get(target, property, receiver);
      },
    });

    const result = await new PgExports(pool, broken as unknown as BlobStore, {
      worker: 'failing-worker',
    }).run(requested.id);

    // Back to pending rather than failed: a storage blip must not be the end of someone's
    // attempt to take their memory with them.
    expect(result?.status).toBe('pending');
    expect(result?.error).toMatch(/lagringen/);
    expect(store.aborted).toBe(1);
  });

  it('fails visibly once the attempts are spent', async () => {
    const store = new StreamingTestStore();
    const requested = await new PgExports(pool, store).request(emil);
    await pool.query(`UPDATE app.export_job SET attempts = max_attempts WHERE id = $1`, [
      requested.id,
    ]);

    // A subclass rather than a spread: spreading a class instance drops every prototype
    // method, which is a bug this repository has already paid for once.
    class Unreachable extends StreamingTestStore {
      override async createUpload(): Promise<BlobUpload> {
        throw new Error('lagringen är borta');
      }
    }

    const result = await new PgExports(pool, new Unreachable()).run(requested.id);
    expect(result?.status).toBe('failed');
    expect(result?.finishedAt).not.toBeNull();
  });
});

describe('an export whose machine went away', () => {
  it('is claimed again once its lease lapses', async () => {
    const requested = await exports.request(emil);
    // The Fly restart: claimed, lease written, process gone.
    await pool.query(
      `UPDATE app.export_job
       SET status = 'running', locked_by = 'dead-worker',
           lease_expires_at = now() - interval '1 minute', attempts = 1
       WHERE id = $1`,
      [requested.id],
    );

    const finished = await exports.run(requested.id);
    expect(finished?.status).toBe('ready');
  });

  it('is not stolen from a worker whose lease is still good', async () => {
    const requested = await exports.request(emil);
    await pool.query(
      `UPDATE app.export_job
       SET status = 'running', locked_by = 'busy-worker',
           lease_expires_at = now() + interval '5 minutes'
       WHERE id = $1`,
      [requested.id],
    );

    expect(await exports.run(requested.id)).toBeNull();
  });

  it('is requeued by the reaper, and its half-written archive deleted', async () => {
    const requested = await exports.request(emil);
    const strayKey = `exports/${requested.id}.zip`;
    await blobs.put(utf8('half a zip'));
    await pool.query(
      `UPDATE app.export_job
       SET status = 'running', locked_by = 'dead-worker',
           lease_expires_at = now() - interval '1 hour',
           pending_key = $2
       WHERE id = $1`,
      [requested.id, strayKey],
    );

    const reaped = await exports.reapStuck();
    expect(reaped.requeued).toBeGreaterThanOrEqual(1);

    const row = await exports.get(emil, requested.id);
    expect(row?.status).toBe('pending');
    expect(await blobs.exists(strayKey)).toBe(false);
  });

  it('is failed rather than requeued forever, so the person is told', async () => {
    // Silence is the worst outcome here. A person who asked for their memory and got
    // neither an archive nor an error has been told nothing at all.
    const requested = await exports.request(emil);
    await pool.query(
      `UPDATE app.export_job
       SET status = 'running', locked_by = 'dead-worker',
           lease_expires_at = now() - interval '1 hour', attempts = max_attempts
       WHERE id = $1`,
      [requested.id],
    );

    const reaped = await exports.reapStuck();
    expect(reaped.failed).toBeGreaterThanOrEqual(1);

    const row = await exports.get(emil, requested.id);
    expect(row?.status).toBe('failed');
    expect(row?.error).toMatch(/avbröts|Försök igen/);
  });

  it('is counted, so a stuck export is visible without anyone asking', async () => {
    const requested = await exports.request(emil);
    await pool.query(
      `UPDATE app.export_job
       SET status = 'running', lease_expires_at = now() - interval '1 hour'
       WHERE id = $1`,
      [requested.id],
    );

    const stats = await exports.stats();
    expect(stats.running).toBeGreaterThanOrEqual(1);
    expect(stats.expiredLeases).toBeGreaterThanOrEqual(1);

    await exports.reapStuck();
  });
});

describe('the download link', () => {
  const drain = async (stream: AsyncIterable<Uint8Array>): Promise<number> => {
    let bytes = 0;
    for await (const chunk of stream) bytes += chunk.byteLength;
    return bytes;
  };

  const readyExport = async () => {
    const job = await exports.run((await exports.request(emil)).id);
    expect(job?.status).toBe('ready');
    return job!;
  };

  it('is spent by a completed download, and then answers as unknown', async () => {
    const job = await readyExport();
    const link = await exports.createDownloadToken(emil, job.id);

    const first = await exports.resolveDownload(link!.token);
    expect(first).not.toBeNull();
    expect(await drain(first!.stream)).toBe(job.byteSize);
    await first!.complete();

    // Replaying it, forwarding it, or finding it in an inbox: all the same answer as a
    // token that was never issued.
    expect(await exports.resolveDownload(link!.token)).toBeNull();
    expect(await exports.resolveDownload('pgm_dl_nonsense')).toBeNull();
  });

  it('lets a transfer that broke be retried, which is what single-use must not cost', async () => {
    // The case the old seven-day link was protecting: a multi-gigabyte archive on a phone
    // that loses signal. `complete` is never called, so the link is still good.
    const job = await readyExport();
    const link = await exports.createDownloadToken(emil, job.id);

    const abandoned = await exports.resolveDownload(link!.token);
    expect(abandoned).not.toBeNull();
    // Read one chunk and walk away, as a dropped connection does.
    await abandoned!.stream[Symbol.asyncIterator]().next();

    const retried = await exports.resolveDownload(link!.token);
    expect(retried).not.toBeNull();
    await retried!.complete();
    expect(await exports.resolveDownload(link!.token)).toBeNull();
  });

  it('closes the resumption window rather than leaving it open', async () => {
    const job = await readyExport();
    const link = await exports.createDownloadToken(emil, job.id);

    await exports.resolveDownload(link!.token);
    await pool.query(
      `UPDATE app.export_download SET first_used_at = now() - interval '2 hours'`,
    );

    expect(await exports.resolveDownload(link!.token)).toBeNull();
  });

  it('stops after a handful of attempts, so a shared link cannot be hammered', async () => {
    const job = await readyExport();
    const link = await exports.createDownloadToken(emil, job.id);

    for (let i = 0; i < 5; i += 1) {
      await exports.resolveDownload(link!.token);
    }
    expect(await exports.resolveDownload(link!.token)).toBeNull();
  });

  it('is short-lived, and says so', async () => {
    // An hour rather than a week. The link is minted from a screen the person is already
    // looking at, so a week bought nothing and risked everything in one file.
    const job = await readyExport();
    const link = await exports.createDownloadToken(emil, job.id);

    const hours = (link!.expiresAt.getTime() - Date.now()) / 3_600_000;
    expect(hours).toBeGreaterThan(0.5);
    expect(hours).toBeLessThanOrEqual(1.01);
  });

  it('carries the archive digest, so a person can check what they received', async () => {
    const job = await readyExport();
    const link = await exports.createDownloadToken(emil, job.id);

    const resolved = await exports.resolveDownload(link!.token);
    expect(resolved?.checksum).toBe(job.checksum);
    expect(resolved?.byteSize).toBe(job.byteSize);
  });
});
