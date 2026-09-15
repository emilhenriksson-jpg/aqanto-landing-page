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
 * Zip64 is implemented, because the product limit is ten gigabytes and zip32 stops at
 * four. It is used where it is needed rather than everywhere: an entry whose length is
 * not known in advance is written as zip64 (its data descriptor has to be sized before
 * the bytes are, and guessing low is a corrupt archive), an entry whose length is known
 * and small is written exactly as before, and the archive-level zip64 records appear
 * only once the directory outgrows what zip32 can address. A ten-kilobyte export of
 * someone's first week therefore has the same bytes it had before this existed.
 */

import { crc32 } from 'node:zlib';

const LOCAL_FILE_HEADER = 0x04034b50;
const CENTRAL_FILE_HEADER = 0x02014b50;
const END_OF_CENTRAL_DIRECTORY = 0x06054b50;
const ZIP64_END_OF_CENTRAL_DIRECTORY = 0x06064b50;
const ZIP64_END_OF_CENTRAL_DIRECTORY_LOCATOR = 0x07064b50;
const DATA_DESCRIPTOR = 0x08074b50;

/** Bit 3: sizes and CRC follow the data rather than preceding it. */
const FLAG_DATA_DESCRIPTOR = 0x0008;
/** Bit 11: the filename is UTF-8. Swedish filenames are the normal case here. */
const FLAG_UTF8 = 0x0800;

const METHOD_STORED = 0;
const VERSION_NEEDED = 20;
/** What a reader must understand to read a zip64 member or directory. */
const VERSION_NEEDED_ZIP64 = 45;

const ZIP64_EXTRA_ID = 0x0001;

/** The point past which a non-zip64 archive cannot be described. */
export const ZIP32_LIMIT = 0xffffffff;
/** Past 65 535 entries the zip32 end record cannot count them either. */
const ZIP32_ENTRY_LIMIT = 0xffff;

/**
 * The archive ceiling, well above the ten gigabytes a person may store.
 *
 * Zip64's own limit is 2^64, which is not a limit — so this is a sanity bound rather
 * than a format one: an export that has passed sixteen gibibytes is a bug somewhere
 * upstream (a loop re-adding the same document, say), and discovering that after writing
 * a terabyte into object storage would be an expensive way to find out.
 */
export const MAX_ARCHIVE_BYTES = 16 * 1024 * 1024 * 1024;

export interface ZipSink {
  write(chunk: Uint8Array): Promise<void> | void;
}

export interface ZipWriterOptions {
  /** Refuses to write past this. Defaults to `MAX_ARCHIVE_BYTES`. */
  maxBytes?: number;
}

export interface ZipEntryOptions {
  /**
   * The entry's exact length, when the caller knows it.
   *
   * Known and under four gigabytes means the entry is described in plain zip32, which is
   * what almost every entry in a real archive is. Unknown means zip64: the data
   * descriptor's field width has to be decided before the bytes are counted, and a
   * four-byte descriptor on an entry that turns out to be larger is a corrupt archive
   * that reads fine until the one file someone needed.
   */
  size?: number;
}

interface DirectoryEntry {
  name: Buffer;
  crc: number;
  size: number;
  offset: number;
  /** Whether the local header and data descriptor were written in zip64 form. */
  zip64: boolean;
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
  private readonly maxBytes: number;
  private offset = 0;
  private open = false;
  private finished = false;

  constructor(
    private readonly sink: ZipSink,
    options: ZipWriterOptions = {},
  ) {
    this.maxBytes = options.maxBytes ?? MAX_ARCHIVE_BYTES;
  }

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
  async add(
    name: string,
    content: AsyncIterable<Uint8Array> | Iterable<Uint8Array>,
    options: ZipEntryOptions = {},
  ): Promise<void> {
    if (this.finished) throw new Error('zip is already finished');
    if (this.open) throw new Error('previous entry was not closed');
    this.open = true;

    const nameBytes = Buffer.from(name, 'utf8');
    const entryOffset = this.offset;
    // Zip64 unless the caller can promise this entry is small. The promise is the
    // exception: a paged query and a blob store read both hand over bytes without saying
    // how many are coming.
    const zip64 = options.size === undefined || options.size > ZIP32_LIMIT;

    await this.put(localHeader(nameBytes, zip64));

    let crc = 0;
    let size = 0;
    for await (const chunk of content) {
      if (chunk.byteLength === 0) continue;
      // Incremental, so the checksum costs one pass over bytes that are already moving
      // and never requires a second copy of the entry.
      crc = crc32(Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength), crc);
      size += chunk.byteLength;
      await this.put(chunk);
      // Checked mid-entry as well as after it. A single member is what would run away
      // here, and the whole point of a bound is to stop before the bytes are spent.
      this.assertWithinBound();
    }

    // A caller that declared a size and then produced a different number of bytes has
    // written an entry whose local header and descriptor disagree. Said as an error
    // rather than repaired, because the archive is already on its way to storage.
    if (options.size !== undefined && options.size !== size) {
      this.open = false;
      throw new Error(
        `entry "${name}" was declared as ${options.size} bytes and produced ${size}`,
      );
    }

    await this.put(dataDescriptor(crc, size, zip64));

    this.entries.push({ name: nameBytes, crc, size, offset: entryOffset, zip64 });
    this.open = false;
    this.assertWithinBound();
  }

  /** Convenience for the small entries — the manifest, the README. */
  async addBytes(name: string, bytes: Uint8Array): Promise<void> {
    await this.add(name, [bytes], { size: bytes.byteLength });
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

    // The zip64 end records, when the directory has outgrown what the zip32 end record
    // can address. Written only then: a small archive keeps exactly the trailer it had
    // before zip64 existed here, which is the widest reader compatibility available.
    if (
      this.entries.length > ZIP32_ENTRY_LIMIT ||
      directorySize > ZIP32_LIMIT ||
      directoryOffset > ZIP32_LIMIT
    ) {
      const zip64EndOffset = this.offset;
      await this.put(zip64EndRecord(this.entries.length, directorySize, directoryOffset));
      await this.put(zip64Locator(zip64EndOffset));
    }

    await this.put(endRecord(this.entries.length, directorySize, directoryOffset));

    return { byteSize: this.offset, entryCount: this.entries.length };
  }

  private async put(chunk: Uint8Array): Promise<void> {
    await this.sink.write(chunk);
    this.offset += chunk.byteLength;
  }

  /**
   * Refuses to keep going past the archive bound.
   *
   * Checked while writing rather than at the end, so the failure arrives before several
   * more gigabytes have been written — and as an error rather than as an archive that
   * looks fine until someone tries to open it.
   */
  private assertWithinBound(): void {
    if (this.offset > this.maxBytes) {
      throw new ZipTooLargeError(
        `Exporten passerade ${Math.round(this.maxBytes / 1024 ** 3)} GB och avbröts. ` +
          'Hör av dig — det här är något vi behöver titta på, inte något du gjorde fel.',
      );
    }
  }
}

function localHeader(name: Buffer, zip64: boolean): Buffer {
  // The zip64 extra field is 20 bytes: two bytes of id, two of length, and the two
  // eight-byte sizes it carries. Both sizes are zero here for the same reason the
  // 32-bit ones are — bit 3 says they arrive after the data — but the field's presence
  // is what tells a reader the descriptor is eight-byte rather than four.
  const extraLength = zip64 ? 20 : 0;
  const header = Buffer.alloc(30 + name.byteLength + extraLength);
  header.writeUInt32LE(LOCAL_FILE_HEADER, 0);
  header.writeUInt16LE(zip64 ? VERSION_NEEDED_ZIP64 : VERSION_NEEDED, 4);
  header.writeUInt16LE(FLAG_DATA_DESCRIPTOR | FLAG_UTF8, 6);
  header.writeUInt16LE(METHOD_STORED, 8);
  header.writeUInt32LE(0, 10); // mtime/mdate: not carried, see the manifest for times
  // Zeroes, because these are not known yet. That is what bit 3 means.
  header.writeUInt32LE(0, 14); // crc
  header.writeUInt32LE(zip64 ? ZIP32_LIMIT : 0, 18); // compressed size
  header.writeUInt32LE(zip64 ? ZIP32_LIMIT : 0, 22); // uncompressed size
  header.writeUInt16LE(name.byteLength, 26);
  header.writeUInt16LE(extraLength, 28);
  name.copy(header, 30);

  if (zip64) {
    const extra = 30 + name.byteLength;
    header.writeUInt16LE(ZIP64_EXTRA_ID, extra);
    header.writeUInt16LE(16, extra + 2);
    header.writeBigUInt64LE(0n, extra + 4); // uncompressed size, in the descriptor
    header.writeBigUInt64LE(0n, extra + 12); // compressed size, in the descriptor
  }

  return header;
}

function dataDescriptor(crc: number, size: number, zip64: boolean): Buffer {
  if (!zip64) {
    const descriptor = Buffer.alloc(16);
    descriptor.writeUInt32LE(DATA_DESCRIPTOR, 0);
    descriptor.writeUInt32LE(crc, 4);
    descriptor.writeUInt32LE(size, 8); // compressed == uncompressed, stored
    descriptor.writeUInt32LE(size, 12);
    return descriptor;
  }

  const descriptor = Buffer.alloc(24);
  descriptor.writeUInt32LE(DATA_DESCRIPTOR, 0);
  descriptor.writeUInt32LE(crc, 4);
  descriptor.writeBigUInt64LE(BigInt(size), 8);
  descriptor.writeBigUInt64LE(BigInt(size), 16);
  return descriptor;
}

function centralHeader(entry: DirectoryEntry): Buffer {
  // Zip64 in the directory is decided by the numbers rather than by how the entry was
  // streamed: a small entry sitting past the four-gigabyte mark needs a 64-bit offset
  // even though its own size fits.
  const needsZip64 = entry.size > ZIP32_LIMIT || entry.offset > ZIP32_LIMIT;
  const extraLength = needsZip64 ? 28 : 0;
  const header = Buffer.alloc(46 + entry.name.byteLength + extraLength);
  const version = needsZip64 || entry.zip64 ? VERSION_NEEDED_ZIP64 : VERSION_NEEDED;

  header.writeUInt32LE(CENTRAL_FILE_HEADER, 0);
  header.writeUInt16LE(version, 4); // version made by
  header.writeUInt16LE(version, 6);
  header.writeUInt16LE(FLAG_DATA_DESCRIPTOR | FLAG_UTF8, 8);
  header.writeUInt16LE(METHOD_STORED, 10);
  header.writeUInt32LE(0, 12);
  header.writeUInt32LE(entry.crc, 16);
  header.writeUInt32LE(needsZip64 ? ZIP32_LIMIT : entry.size, 20);
  header.writeUInt32LE(needsZip64 ? ZIP32_LIMIT : entry.size, 24);
  header.writeUInt16LE(entry.name.byteLength, 28);
  header.writeUInt16LE(extraLength, 30);
  header.writeUInt16LE(0, 32); // comment
  header.writeUInt16LE(0, 34); // disk
  header.writeUInt16LE(0, 36); // internal attrs
  // 0o644 in the high word, so the files are readable when unzipped on a unix box
  // rather than arriving with no permission bits at all.
  header.writeUInt32LE(0o644 << 16, 38);
  header.writeUInt32LE(needsZip64 ? ZIP32_LIMIT : entry.offset, 42);
  entry.name.copy(header, 46);

  if (needsZip64) {
    // Three eight-byte fields in the order the format fixes: uncompressed, compressed,
    // then the local header offset. Order is the whole protocol here — presence is
    // signalled by the 0xffffffff sentinels above, so a field written out of turn is
    // read as the next one.
    const extra = 46 + entry.name.byteLength;
    header.writeUInt16LE(ZIP64_EXTRA_ID, extra);
    header.writeUInt16LE(24, extra + 2);
    header.writeBigUInt64LE(BigInt(entry.size), extra + 4);
    header.writeBigUInt64LE(BigInt(entry.size), extra + 12);
    header.writeBigUInt64LE(BigInt(entry.offset), extra + 20);
  }

  return header;
}

function zip64EndRecord(count: number, directorySize: number, directoryOffset: number): Buffer {
  const record = Buffer.alloc(56);
  record.writeUInt32LE(ZIP64_END_OF_CENTRAL_DIRECTORY, 0);
  // The record's own size, counted from the byte after this field. Fixed at 44 because
  // nothing here uses the variable extensible data sector.
  record.writeBigUInt64LE(44n, 4);
  record.writeUInt16LE(VERSION_NEEDED_ZIP64, 12); // version made by
  record.writeUInt16LE(VERSION_NEEDED_ZIP64, 14);
  record.writeUInt32LE(0, 16); // this disk
  record.writeUInt32LE(0, 20); // disk with the directory
  record.writeBigUInt64LE(BigInt(count), 24);
  record.writeBigUInt64LE(BigInt(count), 32);
  record.writeBigUInt64LE(BigInt(directorySize), 40);
  record.writeBigUInt64LE(BigInt(directoryOffset), 48);
  return record;
}

function zip64Locator(zip64EndOffset: number): Buffer {
  const locator = Buffer.alloc(20);
  locator.writeUInt32LE(ZIP64_END_OF_CENTRAL_DIRECTORY_LOCATOR, 0);
  locator.writeUInt32LE(0, 4); // disk holding the zip64 end record
  locator.writeBigUInt64LE(BigInt(zip64EndOffset), 8);
  locator.writeUInt32LE(1, 16); // total disks
  return locator;
}

function endRecord(count: number, directorySize: number, directoryOffset: number): Buffer {
  const record = Buffer.alloc(22);
  const entries = Math.min(count, ZIP32_ENTRY_LIMIT);
  record.writeUInt32LE(END_OF_CENTRAL_DIRECTORY, 0);
  record.writeUInt16LE(0, 4); // this disk
  record.writeUInt16LE(0, 6); // disk with the directory
  record.writeUInt16LE(entries, 8);
  record.writeUInt16LE(entries, 10);
  // Sentinels when the real value does not fit: a reader that sees one goes to the
  // zip64 end record, which is why that record has to be written first.
  record.writeUInt32LE(Math.min(directorySize, ZIP32_LIMIT), 12);
  record.writeUInt32LE(Math.min(directoryOffset, ZIP32_LIMIT), 16);
  record.writeUInt16LE(0, 20); // comment
  return record;
}
