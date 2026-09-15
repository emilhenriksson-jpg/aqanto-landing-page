/**
 * A zip writer that never holds the archive in memory.
 *
 * An export is an event log plus every file a person has uploaded, and the storage limit
 * is ten gigabytes. Building that as a `Buffer` and then writing it works in every test
 * and fails for exactly the people with the most to lose — which is the failure mode the
 * NDJSON decision was made to avoid, so doing it here would undo that.
 *
 * So entries stream. Each is written as it is produced, and because the size and
 * checksum of a streamed entry are not known until it has been written, this uses zip's
 * data descriptor: general-purpose bit 3 set, zeroes in the local header, and the real
 * CRC and sizes appended after the data. Every zip reader worth naming handles it —
 * that is what the bit is for — and it is the only way to write an entry whose length
 * you learn last.
 *
 * Entries are stored, not deflated. The archive's bulk is PDFs and images, which are
 * already compressed, so deflate would spend CPU per byte to save almost nothing; the
 * NDJSON would compress well but is the small half. Stored also means an entry can be
 * copied straight through without a compressor holding state.
 *
 * Zip64 is not implemented. A 4 GB archive or a single 4 GB member would need it, and
 * an export that large is a conversation rather than a download — `assertWithinZipLimits`
 * refuses it with something a person can read instead of writing a corrupt archive.
 */

import { crc32 } from 'node:zlib';

const LOCAL_FILE_HEADER = 0x04034b50;
const CENTRAL_FILE_HEADER = 0x02014b50;
const END_OF_CENTRAL_DIRECTORY = 0x06054b50;
const DATA_DESCRIPTOR = 0x08074b50;

/** Bit 3: sizes and CRC follow the data rather than preceding it. */
const FLAG_DATA_DESCRIPTOR = 0x0008;
/** Bit 11: the filename is UTF-8. Swedish filenames are the normal case here. */
const FLAG_UTF8 = 0x0800;

const METHOD_STORED = 0;
const VERSION_NEEDED = 20;

/** The point past which a non-zip64 archive cannot be described. */
export const ZIP32_LIMIT = 0xffffffff;

export interface ZipSink {
  write(chunk: Uint8Array): Promise<void> | void;
}

interface DirectoryEntry {
  name: Buffer;
  crc: number;
  size: number;
  offset: number;
}

export class ZipTooLargeError extends Error {}

/**
 * Writes a zip to a sink, one entry at a time.
 *
 * Deliberately not an `AsyncIterable` of bytes: the caller is streaming *into* this from
 * a database cursor, so the control flow is push rather than pull, and inverting it
 * would mean buffering somewhere to bridge the two.
 */
export class ZipWriter {
  private readonly entries: DirectoryEntry[] = [];
  private offset = 0;
  private open = false;
  private finished = false;

  constructor(private readonly sink: ZipSink) {}

  /** Total bytes written so far. Used to refuse an archive that outgrows zip32. */
  get bytesWritten(): number {
    return this.offset;
  }

  /**
   * Streams one entry. `content` is consumed exactly once.
   *
   * Accepts an async iterable rather than bytes so a 400 MB PDF and a paged NDJSON
   * query look the same to this class, and neither is ever fully resident.
   */
  async add(name: string, content: AsyncIterable<Uint8Array> | Iterable<Uint8Array>): Promise<void> {
    if (this.finished) throw new Error('zip is already finished');
    if (this.open) throw new Error('previous entry was not closed');
    this.open = true;

    const nameBytes = Buffer.from(name, 'utf8');
    const entryOffset = this.offset;

    await this.put(localHeader(nameBytes));

    let crc = 0;
    let size = 0;
    for await (const chunk of content) {
      if (chunk.byteLength === 0) continue;
      // Incremental, so the checksum costs one pass over bytes that are already moving
      // and never requires a second copy of the entry.
      crc = crc32(Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength), crc);
      size += chunk.byteLength;
      await this.put(chunk);
    }

    await this.put(dataDescriptor(crc, size));

    this.entries.push({ name: nameBytes, crc, size, offset: entryOffset });
    this.open = false;
    this.assertWithinZipLimits();
  }

  /** Convenience for the small entries — the manifest, the README. */
  async addBytes(name: string, bytes: Uint8Array): Promise<void> {
    await this.add(name, [bytes]);
  }

  /** Writes the central directory. Nothing may be added afterwards. */
  async finish(): Promise<{ byteSize: number; entryCount: number }> {
    if (this.finished) throw new Error('zip is already finished');
    if (this.open) throw new Error('an entry is still open');
    this.finished = true;

    const directoryOffset = this.offset;
    for (const entry of this.entries) {
      await this.put(centralHeader(entry));
    }
    const directorySize = this.offset - directoryOffset;

    await this.put(endRecord(this.entries.length, directorySize, directoryOffset));

    return { byteSize: this.offset, entryCount: this.entries.length };
  }

  private async put(chunk: Uint8Array): Promise<void> {
    await this.sink.write(chunk);
    this.offset += chunk.byteLength;
  }

  /**
   * Refuses to keep going past what a zip32 central directory can address.
   *
   * Checked after each entry rather than at the end, so the failure arrives before
   * several more gigabytes have been written — and as an error rather than as an archive
   * that looks fine until someone tries to open it.
   */
  private assertWithinZipLimits(): void {
    if (this.offset > ZIP32_LIMIT) {
      throw new ZipTooLargeError(
        'Exporten är större än 4 GB, vilket det här arkivformatet inte klarar. ' +
          'Exportera ett rum i taget, eller hör av dig så hjälper vi till.',
      );
    }
    const last = this.entries.at(-1);
    if (last && last.size > ZIP32_LIMIT) {
      throw new ZipTooLargeError(
        `Filen "${last.name.toString('utf8')}" är större än 4 GB och går inte att lägga i arkivet.`,
      );
    }
  }
}

function localHeader(name: Buffer): Buffer {
  const header = Buffer.alloc(30 + name.byteLength);
  header.writeUInt32LE(LOCAL_FILE_HEADER, 0);
  header.writeUInt16LE(VERSION_NEEDED, 4);
  header.writeUInt16LE(FLAG_DATA_DESCRIPTOR | FLAG_UTF8, 6);
  header.writeUInt16LE(METHOD_STORED, 8);
  header.writeUInt32LE(0, 10); // mtime/mdate: not carried, see the manifest for times
  // Zeroes, because these are not known yet. That is what bit 3 means.
  header.writeUInt32LE(0, 14); // crc
  header.writeUInt32LE(0, 18); // compressed size
  header.writeUInt32LE(0, 22); // uncompressed size
  header.writeUInt16LE(name.byteLength, 26);
  header.writeUInt16LE(0, 28); // extra
  name.copy(header, 30);
  return header;
}

function dataDescriptor(crc: number, size: number): Buffer {
  const descriptor = Buffer.alloc(16);
  descriptor.writeUInt32LE(DATA_DESCRIPTOR, 0);
  descriptor.writeUInt32LE(crc, 4);
  descriptor.writeUInt32LE(size, 8); // compressed == uncompressed, stored
  descriptor.writeUInt32LE(size, 12);
  return descriptor;
}

function centralHeader(entry: DirectoryEntry): Buffer {
  const header = Buffer.alloc(46 + entry.name.byteLength);
  header.writeUInt32LE(CENTRAL_FILE_HEADER, 0);
  header.writeUInt16LE(VERSION_NEEDED, 4); // version made by
  header.writeUInt16LE(VERSION_NEEDED, 6);
  header.writeUInt16LE(FLAG_DATA_DESCRIPTOR | FLAG_UTF8, 8);
  header.writeUInt16LE(METHOD_STORED, 10);
  header.writeUInt32LE(0, 12);
  header.writeUInt32LE(entry.crc, 16);
  header.writeUInt32LE(entry.size, 20);
  header.writeUInt32LE(entry.size, 24);
  header.writeUInt16LE(entry.name.byteLength, 28);
  header.writeUInt16LE(0, 30); // extra
  header.writeUInt16LE(0, 32); // comment
  header.writeUInt16LE(0, 34); // disk
  header.writeUInt16LE(0, 36); // internal attrs
  // 0o644 in the high word, so the files are readable when unzipped on a unix box
  // rather than arriving with no permission bits at all.
  header.writeUInt32LE(0o644 << 16, 38);
  header.writeUInt32LE(entry.offset, 42);
  entry.name.copy(header, 46);
  return header;
}

function endRecord(count: number, directorySize: number, directoryOffset: number): Buffer {
  const record = Buffer.alloc(22);
  record.writeUInt32LE(END_OF_CENTRAL_DIRECTORY, 0);
  record.writeUInt16LE(0, 4); // this disk
  record.writeUInt16LE(0, 6); // disk with the directory
  record.writeUInt16LE(count, 8);
  record.writeUInt16LE(count, 10);
  record.writeUInt32LE(directorySize, 12);
  record.writeUInt32LE(directoryOffset, 16);
  record.writeUInt16LE(0, 20); // comment
  return record;
}
