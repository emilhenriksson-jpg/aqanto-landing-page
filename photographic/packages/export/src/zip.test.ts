/**
 * The zip writer.
 *
 * The assertion that matters is that other people's tools can open what this produces.
 * An archive format only this codebase can read would defeat the entire purpose — the
 * point of an export is that it outlives us — so these tests use two independent
 * readers and never our own parser agreeing with our own writer.
 *
 * Two readers rather than one, because they are good at different things and because
 * one of them is wrong. `unzip -t` verifies every CRC, which is what catches a bad data
 * descriptor. Python's `zipfile` is used for names and content, because Info-ZIP's
 * unzip 6.00 — still the default on Debian and Ubuntu — ignores the UTF-8 filename flag
 * and mangles `uppsägning` into mojibake whatever the locale. That is a limitation of
 * that reader, not of the archive: `zipfile` reads the same bytes, reports the flag set,
 * and gets the name right. Worth knowing, because a Swedish person unzipping on a Linux
 * box may see it, and the file is intact either way.
 */

import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ZipTooLargeError, ZipWriter, type ZipSink } from './zip.js';

const run = promisify(execFile);

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'photographic-zip-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** Collects into memory — fine for a test, which is the only place it is fine. */
class BufferSink implements ZipSink {
  readonly chunks: Uint8Array[] = [];
  write(chunk: Uint8Array): void {
    this.chunks.push(new Uint8Array(chunk));
  }
  bytes(): Buffer {
    return Buffer.concat(this.chunks.map((c) => Buffer.from(c)));
  }
}

interface Opened {
  /** Output of `unzip -t`: the CRC verification. */
  list: string;
  extractDir: string;
  bytes: Buffer;
  /** Entry names as a standards-correct reader sees them. */
  names(): Promise<string[]>;
  /** One entry's content, read through Python's `zipfile`. */
  read(name: string): Promise<string>;
}

async function writeAndUnzip(build: (zip: ZipWriter) => Promise<void>): Promise<Opened> {
  const sink = new BufferSink();
  const zip = new ZipWriter(sink);
  await build(zip);
  await zip.finish();

  const archive = join(dir, 'export.zip');
  await writeFile(archive, sink.bytes());

  // `unzip -t` verifies every CRC. A wrong data descriptor fails here rather than
  // producing files that are subtly corrupt.
  const tested = await run('unzip', ['-t', archive]);
  const extractDir = join(dir, 'out');
  await run('unzip', ['-q', archive, '-d', extractDir]);

  const python = async (script: string): Promise<string> => {
    const { stdout } = await run('python3', ['-c', script, archive]);
    return stdout;
  };

  return {
    list: tested.stdout,
    extractDir,
    bytes: sink.bytes(),
    names: async () =>
      (
        await python(
          'import sys,zipfile\n' +
            'print("\\n".join(i.filename for i in zipfile.ZipFile(sys.argv[1]).infolist()))',
        )
      )
        .split('\n')
        .filter(Boolean),
    read: async (name) =>
      python(
        'import sys,zipfile\n' +
          `sys.stdout.write(zipfile.ZipFile(sys.argv[1]).read(${JSON.stringify(name)}).decode("utf-8"))`,
      ),
  };
}

const utf8 = (text: string) => new TextEncoder().encode(text);

describe('ZipWriter', () => {
  it('produces an archive the system unzip accepts', async () => {
    const { list } = await writeAndUnzip(async (zip) => {
      await zip.addBytes('README.md', utf8('# Din export\n'));
      await zip.addBytes('events.ndjson', utf8('{"seq":1}\n{"seq":2}\n'));
    });

    expect(list).toContain('No errors detected');
  });

  it('round-trips content byte for byte', async () => {
    const events = '{"seq":1,"event_type":"item.created"}\n{"seq":2}\n';
    const { extractDir } = await writeAndUnzip(async (zip) => {
      await zip.addBytes('events.ndjson', utf8(events));
    });

    expect(await readFile(join(extractDir, 'events.ndjson'), 'utf8')).toBe(events);
  });

  it('writes an entry streamed in many chunks, without knowing its length first', async () => {
    // The reason for data descriptors. A paged database cursor does not know how many
    // bytes it will produce until it has produced them.
    const lines = Array.from({ length: 5000 }, (_, i) => `{"seq":${i}}\n`);

    const { extractDir, list } = await writeAndUnzip(async (zip) => {
      await zip.add(
        'events.ndjson',
        (async function* () {
          for (const line of lines) yield utf8(line);
        })(),
      );
    });

    expect(list).toContain('No errors detected');
    const written = await readFile(join(extractDir, 'events.ndjson'), 'utf8');
    expect(written).toBe(lines.join(''));
    expect(written.split('\n').filter(Boolean)).toHaveLength(5000);
  });

  it('stores a Swedish filename as UTF-8 with the flag set', async () => {
    // Read through `zipfile`, not `unzip`: Info-ZIP 6.00 ignores the UTF-8 flag and
    // would report mojibake here even though the archive is correct. See the file
    // comment — the bytes and the flag are what this asserts, because those are what a
    // conforming reader uses.
    const archive = await writeAndUnzip(async (zip) => {
      await zip.addBytes('documents/familjen/avtal-uppsägning.pdf', utf8('%PDF-1.4'));
    });

    expect(await archive.names()).toEqual(['documents/familjen/avtal-uppsägning.pdf']);
    expect(await archive.read('documents/familjen/avtal-uppsägning.pdf')).toBe('%PDF-1.4');
  });

  it('handles binary content without corrupting it', async () => {
    const binary = new Uint8Array(4096);
    for (let i = 0; i < binary.length; i += 1) binary[i] = (i * 31) % 256;

    const { extractDir } = await writeAndUnzip(async (zip) => {
      await zip.addBytes('documents/emil/scan.bin', binary);
    });

    const read = await readFile(join(extractDir, 'documents/emil/scan.bin'));
    expect(new Uint8Array(read)).toEqual(binary);
  });

  it('writes nested directories without needing directory entries', async () => {
    const { extractDir, list } = await writeAndUnzip(async (zip) => {
      await zip.addBytes('documents/buyersclub-ledning/a-protokoll.pdf', utf8('one'));
      await zip.addBytes('documents/mallorca/b-hyresavtal.pdf', utf8('two'));
    });

    expect(list).toContain('No errors detected');
    expect(await readFile(join(extractDir, 'documents/mallorca/b-hyresavtal.pdf'), 'utf8')).toBe('two');
  });

  it('skips empty chunks rather than writing zero-length runs', async () => {
    const { extractDir } = await writeAndUnzip(async (zip) => {
      await zip.add('a.txt', [utf8('a'), new Uint8Array(0), utf8('b')]);
    });

    expect(await readFile(join(extractDir, 'a.txt'), 'utf8')).toBe('ab');
  });

  it('writes an empty entry as an empty file, not as a broken one', async () => {
    const { extractDir, list } = await writeAndUnzip(async (zip) => {
      await zip.addBytes('tom.ndjson', new Uint8Array(0));
    });

    expect(list).toContain('No errors detected');
    expect(await readFile(join(extractDir, 'tom.ndjson'), 'utf8')).toBe('');
  });

  it('reports what it wrote', async () => {
    const sink = new BufferSink();
    const zip = new ZipWriter(sink);
    await zip.addBytes('a.txt', utf8('hello'));
    await zip.addBytes('b.txt', utf8('world'));
    const result = await zip.finish();

    expect(result.entryCount).toBe(2);
    expect(result.byteSize).toBe(sink.bytes().byteLength);
    expect(zip.bytesWritten).toBe(result.byteSize);
  });
});

describe('ZipWriter refuses to produce something broken', () => {
  it('rejects a second entry while one is still open', async () => {
    const zip = new ZipWriter(new BufferSink());
    const stuck = zip.add(
      'a.txt',
      (async function* () {
        yield utf8('a');
        await new Promise((resolve) => setTimeout(resolve, 20));
        yield utf8('b');
      })(),
    );

    await expect(zip.addBytes('b.txt', utf8('x'))).rejects.toThrow(/not closed/);
    await stuck;
  });

  it('refuses to add anything after finishing', async () => {
    const zip = new ZipWriter(new BufferSink());
    await zip.addBytes('a.txt', utf8('a'));
    await zip.finish();

    await expect(zip.addBytes('b.txt', utf8('b'))).rejects.toThrow(/already finished/);
    await expect(zip.finish()).rejects.toThrow(/already finished/);
  });

  it('refuses an archive past what zip32 can address, rather than writing a corrupt one', async () => {
    // Not reachable with real data in a test, so the limit is asserted through a sink
    // that lies about how much has been written. The alternative is an archive that
    // looks fine until someone opens it, which is the failure worth preventing.
    const zip = new ZipWriter(new BufferSink());
    Object.defineProperty(zip, 'offset', { value: 0x100000000, writable: true });

    await expect(zip.addBytes('big.bin', utf8('x'))).rejects.toThrow(ZipTooLargeError);
    await expect(zip.addBytes('big.bin', utf8('x'))).rejects.toThrow(/4 GB/);
  });
});
