/**
 * Just enough zip parsing to refuse an archive before handing it to a real unzipper.
 *
 * `.docx` and `.xlsx` are zip archives, and the libraries that read them decompress as
 * they go. That is the whole attack: a 42 kB file whose central directory promises
 * four gigabytes, fed to a parser that believes it. `ExtractionLimits` declares
 * `maxExpansionRatio` and `maxArchiveEntries`, and this is what makes those two numbers
 * mean something rather than being documentation.
 *
 * Only the central directory is read — the authoritative index a zip reader itself
 * uses, sitting at the end of the file. Local file headers are cheaper to reach but are
 * the half an attacker can make disagree with reality for free.
 */

/** Little-endian signatures, as they appear on disk. */
const END_OF_CENTRAL_DIRECTORY = 0x06054b50;
const CENTRAL_FILE_HEADER = 0x02014b50;
const ZIP64_END_LOCATOR = 0x07064b50;

/** The comment field is 16 bits, so the record cannot start further back than this. */
const MAX_COMMENT_LENGTH = 0xffff;
const END_RECORD_LENGTH = 22;

export interface ArchiveSummary {
  entryCount: number;
  /** Sum of the declared uncompressed sizes across every entry. */
  uncompressedBytes: number;
  /** True when the archive uses zip64, whose 64-bit sizes we do not read. */
  zip64: boolean;
}

export class NotAnArchiveError extends Error {}

/**
 * Reads the declared shape of a zip archive without decompressing anything.
 *
 * Throws `NotAnArchiveError` when the central directory cannot be found, which is the
 * honest answer: the caller should treat the file as corrupt rather than assume it is
 * safe because parsing failed.
 */
export function inspectArchive(bytes: Uint8Array): ArchiveSummary {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const endOffset = findEndOfCentralDirectory(view, bytes.byteLength);
  if (endOffset === -1) throw new NotAnArchiveError('Hittade inget zip-index.');

  const declaredEntries = view.getUint16(endOffset + 10, true);
  let directoryOffset = view.getUint32(endOffset + 16, true);

  // 0xffff / 0xffffffff are zip64's "look in the 64-bit record" sentinels. We do not
  // parse that record: an archive large enough to need it is already far past every
  // limit a document upload has, so saying so is more useful than reading it.
  const zip64 =
    declaredEntries === 0xffff ||
    directoryOffset === 0xffffffff ||
    hasZip64Locator(view, endOffset);

  if (zip64) {
    return { entryCount: declaredEntries, uncompressedBytes: Number.MAX_SAFE_INTEGER, zip64: true };
  }

  let entryCount = 0;
  let uncompressedBytes = 0;

  while (directoryOffset + 46 <= bytes.byteLength) {
    if (view.getUint32(directoryOffset, true) !== CENTRAL_FILE_HEADER) break;

    uncompressedBytes += view.getUint32(directoryOffset + 24, true);
    entryCount += 1;

    const nameLength = view.getUint16(directoryOffset + 28, true);
    const extraLength = view.getUint16(directoryOffset + 30, true);
    const commentLength = view.getUint16(directoryOffset + 32, true);
    directoryOffset += 46 + nameLength + extraLength + commentLength;

    // A directory claiming more entries than the file could hold is malformed; stop
    // rather than looping on a corrupt offset.
    if (entryCount > 1_000_000) break;
  }

  if (entryCount === 0) throw new NotAnArchiveError('Zip-indexet är tomt eller skadat.');

  // Trust whichever count is larger. A header understating its own entries is the
  // cheapest way to get past a check that believes it.
  return {
    entryCount: Math.max(entryCount, declaredEntries),
    uncompressedBytes,
    zip64: false,
  };
}

function findEndOfCentralDirectory(view: DataView, length: number): number {
  if (length < END_RECORD_LENGTH) return -1;
  const earliest = Math.max(0, length - END_RECORD_LENGTH - MAX_COMMENT_LENGTH);

  for (let offset = length - END_RECORD_LENGTH; offset >= earliest; offset -= 1) {
    if (view.getUint32(offset, true) === END_OF_CENTRAL_DIRECTORY) return offset;
  }
  return -1;
}

function hasZip64Locator(view: DataView, endOffset: number): boolean {
  const at = endOffset - 20;
  if (at < 0) return false;
  return view.getUint32(at, true) === ZIP64_END_LOCATOR;
}
