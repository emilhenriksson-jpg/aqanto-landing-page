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
  /** Names of the entries a reader sees as zip64, by the local header's extra field. */
  zip64Entries(): Promise<string[]>;
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
    zip64Entries: async () =>
      (
        await python(
          'import struct,sys,zipfile\n' +
            'z = zipfile.ZipFile(sys.argv[1])\n' +
            'f = open(sys.argv[1], "rb")\n' +
            'for i in z.infolist():\n' +
            '    f.seek(i.header_offset)\n' +
            '    h = f.read(30)\n' +
            '    n, e = struct.unpack("<HH", h[26:30])\n' +
            '    extra = f.read(n + e)[n:]\n' +
            '    if extra[:2] == b"\\x01\\x00":\n' +
            '        print(i.filename)\n',
        )
      )
        .split('\n')
        .filter(Boolean),
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

  it('stops at the archive bound rather than writing without end', async () => {
    // Sixteen gibibytes is not reachable in a test, so the bound is set low here. What
    // is being asserted is that there is one at all: past the product's ten gigabytes
    // something upstream is wrong, and finding that out after a terabyte has gone into
    // object storage is an expensive way to find out.
    const zip = new ZipWriter(new BufferSink(), { maxBytes: 256 });

    await expect(
      zip.add('stor.bin', [new Uint8Array(128), new Uint8Array(128), new Uint8Array(128)]),
    ).rejects.toThrow(ZipTooLargeError);
  });

  it('stops mid-entry rather than after it', async () => {
    // The case the bound exists for is one runaway member. Waiting for the entry to
    // close would mean the bytes are already spent.
    const sink = new BufferSink();
    const zip = new ZipWriter(sink, { maxBytes: 1024 });
    let produced = 0;

    await expect(
      zip.add(
        'rinner.bin',
        (async function* () {
          for (let i = 0; i < 100; i += 1) {
            produced += 1;
            yield new Uint8Array(256);
          }
        })(),
      ),
    ).rejects.toThrow(ZipTooLargeError);

    expect(produced).toBeLessThan(10);
  });

  it('refuses an entry that produced a different number of bytes than it promised', async () => {
    // A declared size is what selects the smaller zip32 header, so a caller getting it
    // wrong would write an entry whose header and descriptor disagree.
    const zip = new ZipWriter(new BufferSink());

    await expect(zip.add('a.txt', [utf8('ab')], { size: 5 })).rejects.toThrow(
      /declared as 5 bytes and produced 2/,
    );
  });
});

describe('zip64', () => {
  it('writes a streamed entry in zip64 form, and readers accept it', async () => {
    // A streamed entry's length is not known when its header is written, so it gets a
    // 64-bit data descriptor whatever its eventual size. This is the ordinary case for
    // `events.ndjson` and for every document, and it has to stay readable by tools that
    // are not ours.
    const archive = await writeAndUnzip(async (zip) => {
      await zip.add('events.ndjson', (async function* () {
        yield utf8('{"seq":1}\n');
        yield utf8('{"seq":2}\n');
      })());
    });

    expect(archive.list).toContain('No errors detected');
    expect(await archive.read('events.ndjson')).toBe('{"seq":1}\n{"seq":2}\n');
    // The flag a reader uses to decide the descriptor is eight-byte rather than four.
    expect(await archive.zip64Entries()).toEqual(['events.ndjson']);
  });

  it('leaves a small entry of known length in plain zip32', async () => {
    // The manifest and the README are written from bytes already in hand. Nothing is
    // gained by describing them in a format some old tool might not read.
    const archive = await writeAndUnzip(async (zip) => {
      await zip.addBytes('manifest.json', utf8('{"formatVersion":1}'));
    });

    expect(await archive.zip64Entries()).toEqual([]);
    expect(await archive.read('manifest.json')).toBe('{"formatVersion":1}');
  });

  it('describes an entry past the four-gigabyte mark with a 64-bit offset', async () => {
    // The directory entry, not the member: a small file sitting beyond 4 GB needs a
    // 64-bit local header offset even though its own size fits in 32 bits. Asserted by
    // reading the bytes the writer produced rather than by writing 4 GB, which the
    // near-limit test does for real.
    const sink = new BufferSink();
    const zip = new ZipWriter(sink);
    await zip.addBytes('a.txt', utf8('a'));
    Object.defineProperty(zip, 'offset', { value: 0x100000000 + 64, writable: true });
    await zip.addBytes('b.txt', utf8('b'));
    await zip.finish();

    const bytes = sink.bytes();
    // The zip64 end record and its locator, which a reader looks for after seeing the
    // sentinel in the ordinary end record.
    expect(bytes.includes(Buffer.from([0x50, 0x4b, 0x06, 0x06]))).toBe(true);
    expect(bytes.includes(Buffer.from([0x50, 0x4b, 0x06, 0x07]))).toBe(true);
    expect(bytes.readUInt32LE(bytes.length - 6)).toBe(0xffffffff);
  });
});
