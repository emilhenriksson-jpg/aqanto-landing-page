/**
 * The archive at the size the product promises, produced without holding it.
 *
 * Ten gigabytes is the storage limit, so it is the size of the export the person with the
 * most to lose will ask for — and that person is the one who most needs to be able to
 * leave. This is therefore not a stress test. It is the test that the exit promise is
 * keepable at all, and it is here because the previous implementation was correct for
 * every archive anyone had tried and impossible for the one that mattered.
 *
 * Two things are asserted, and they are the two that were broken:
 *
 *   1. Nothing accumulates. Memory is measured while several gigabytes go past, and the
 *      bound is a constant rather than a fraction of the archive.
 *   2. Past four gigabytes it stays a readable zip. That is where zip32 stops being able
 *      to describe an entry or an offset, and where the writer used to refuse outright.
 *
 * Bytes are streamed rather than allocated: a 64 KiB buffer is reused, which is how a
 * document actually arrives from a blob store. The default size crosses the four-gigabyte
 * cliff, and `PHOTOGRAPHIC_NEAR_LIMIT_GB` takes it to ten for a full run.
 */

import { execFile } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ZipWriter, type ZipSink } from './zip.js';

const run = promisify(execFile);

const GIB = 1024 * 1024 * 1024;
/** Just past what zip32 can address, which is the boundary worth crossing by default. */
const DEFAULT_GB = 4.25;
const archiveGb = Number(process.env['PHOTOGRAPHIC_NEAR_LIMIT_GB'] ?? DEFAULT_GB);
const bigEntryBytes = Math.round(archiveGb * GIB);

/** One buffer, reused. A blob store hands over pieces; nothing here holds the file. */
const CHUNK = new Uint8Array(64 * 1024).fill(0x50);

async function* streamOf(byteLength: number): AsyncGenerator<Uint8Array> {
  let left = byteLength;
  while (left > 0) {
    const take = Math.min(CHUNK.byteLength, left);
    left -= take;
    yield take === CHUNK.byteLength ? CHUNK : CHUNK.subarray(0, take);
  }
}

/** Counts and discards, which is what a streaming upload does from memory's point of view. */
class CountingSink implements ZipSink {
  bytes = 0;
  write(chunk: Uint8Array): void {
    this.bytes += chunk.byteLength;
  }
}

describe(`an archive of ${archiveGb} GB`, () => {
  it(
    'is written without accumulating it in the process',
    async () => {
      const sink = new CountingSink();
      const zip = new ZipWriter(sink);

      global.gc?.();
      const before = process.memoryUsage();

      await zip.add('documents/emil/stor.bin', streamOf(bigEntryBytes));
      // A small entry after the big one, so its local header sits past the four-gigabyte
      // mark and its directory entry needs a 64-bit offset.
      await zip.addBytes('manifest.json', new TextEncoder().encode('{"formatVersion":1}'));
      const result = await zip.finish();

      const after = process.memoryUsage();

      expect(result.entryCount).toBe(2);
      expect(result.byteSize).toBe(sink.bytes);
      expect(result.byteSize).toBeGreaterThan(bigEntryBytes);

      // The bound is a constant. An implementation that held the archive, or any fraction
      // of it, fails here by orders of magnitude rather than marginally.
      const grewBy = after.heapUsed - before.heapUsed;
      expect(grewBy).toBeLessThan(64 * 1024 * 1024);
      expect(after.arrayBuffers - before.arrayBuffers).toBeLessThan(64 * 1024 * 1024);
    },
    { timeout: 20 * 60 * 1000 },
  );
});

/**
 * The same archive, on disk, opened by something that is not ours.
 *
 * Skipped unless asked for: it writes the whole archive to a temporary file, which is
 * minutes of disk rather than seconds of CPU. Worth running when the zip64 code changes,
 * because "our writer and our reader agree" is not evidence of anything.
 */
describe.skipIf(!process.env['PHOTOGRAPHIC_NEAR_LIMIT_DISK'])(
  `a ${archiveGb} GB archive on disk`,
  () => {
    let dir: string;
    let archive: string;

    beforeAll(async () => {
      dir = await mkdtemp(join(tmpdir(), 'photographic-near-limit-'));
      archive = join(dir, 'export.zip');
    });

    afterAll(async () => {
      await rm(dir, { recursive: true, force: true });
    });

    it(
      'is read correctly by python zipfile, entries and sizes',
      async () => {
        const file = createWriteStream(archive);
        // One listener for the life of the stream. Attached per write, this warns about a
        // leak after ten writes and then goes quiet, which is how a real leak hides.
        let failure: Error | null = null;
        file.on('error', (error) => {
          failure = error;
        });

        const sink: ZipSink = {
          write: (chunk) =>
            new Promise<void>((resolve, reject) => {
              if (failure) {
                reject(failure);
                return;
              }
              // Backpressure, honestly: the writer waits for the drain rather than queueing
              // gigabytes inside the stream. This is what `BlobUpload.write` does too.
              if (file.write(chunk)) resolve();
              else file.once('drain', () => resolve());
            }),
        };

        const zip = new ZipWriter(sink);
        await zip.add('documents/emil/stor.bin', streamOf(bigEntryBytes));
        await zip.addBytes('manifest.json', new TextEncoder().encode('{"formatVersion":1}'));
        const result = await zip.finish();
        await new Promise<void>((resolve, reject) => file.end(() => resolve()).on('error', reject));

        expect((await stat(archive)).size).toBe(result.byteSize);

        const { stdout } = await run('python3', [
          '-c',
          'import sys,zipfile\n' +
            'z = zipfile.ZipFile(sys.argv[1])\n' +
            'print("\\n".join(f"{i.filename} {i.file_size} {i.header_offset}" for i in z.infolist()))\n' +
            'sys.stdout.write(z.read("manifest.json").decode("utf-8"))\n',
          archive,
        ]);

        expect(stdout).toContain(`documents/emil/stor.bin ${bigEntryBytes} 0`);
        expect(stdout).toContain('{"formatVersion":1}');
        // The small entry's offset is past what a 32-bit field can hold, which is the
        // condition that makes the zip64 directory records necessary.
        const offset = Number(/manifest\.json \d+ (\d+)/.exec(stdout)?.[1] ?? 0);
        expect(offset).toBeGreaterThan(0xffffffff);
      },
      { timeout: 60 * 60 * 1000 },
    );
  },
);
