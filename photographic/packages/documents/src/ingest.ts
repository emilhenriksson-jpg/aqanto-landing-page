/**
 * The upload pipeline, in the order it has to happen.
 *
 * Both `DocumentPort` implementations — the reference one in `services-memory` and the
 * Postgres one in `db` — call this. Not for the code saving: it is so there is one
 * answer to what order the steps go in, because the order is the part carrying the
 * guarantees.
 *
 *   1. Refuse an oversized file. Before anything is read or written.
 *   2. Write the bytes. Content-addressed, so this is where the checksum comes from —
 *      which is why the storage limit cannot be checked before this point without
 *      trusting a client-declared length.
 *   3. Reserve the space. May refuse; the bytes stay, unreferenced and cheap, and the
 *      retry is free.
 *   4. Extract text, then chunk it. Neither may fail the upload: the file is already
 *      safe, and a scanned PDF with no text layer is a normal thing to be handed.
 *
 * What does not happen here is permission. That is resolved by the caller, against real
 * memberships, before any of this runs — a write is authorized by what the token can
 * do, never by anything found inside the file.
 */

import { MAX_DOCUMENT_BYTES, ValidationError } from '@photographic/core';

import type { BlobStore, StoredBlob } from './blob-store.js';
import { chunkDocument, type DocumentChunk } from './chunk.js';
import { extractText, type ExtractionResult } from './extract/index.js';
import type { ExtractionLimits, Extractor } from './extract/types.js';
import { formatBytes } from './limit.js';

export interface IngestedDocument {
  stored: StoredBlob;
  extraction: ExtractionResult;
  /** Empty when there was no text to chunk. */
  chunks: DocumentChunk[];
}

export interface IngestOptions {
  blobs: BlobStore;
  bytes: Uint8Array;
  filename: string;
  mimeType: string;
  maxBytes?: number;
  limits?: ExtractionLimits;
  extractors?: readonly Extractor[];
  /**
   * Called once the checksum is known and before any text is read.
   *
   * Throws to refuse the upload — which is what the storage limit does. Given the
   * stored blob rather than the raw size so an implementation can tell a genuinely new
   * object from a re-upload of bytes the person already keeps.
   */
  reserve?: (stored: StoredBlob) => Promise<void>;
}

/**
 * Rejects a file we will not accept at all, as opposed to one we cannot read.
 *
 * The distinction matters to the person: "too big" is something they can act on, while
 * "we could not extract text" still leaves them a document they can download.
 */
export function assertAcceptableUpload(input: {
  filename: string;
  byteSize: number;
  maxBytes?: number;
}): void {
  const max = input.maxBytes ?? MAX_DOCUMENT_BYTES;

  if (input.byteSize <= 0) {
    throw new ValidationError(`"${input.filename}" är tom.`);
  }
  if (input.byteSize > max) {
    throw new ValidationError(
      `"${input.filename}" är ${formatBytes(input.byteSize)}. Största filstorlek är ${formatBytes(max)}.`,
    );
  }
}

export async function ingestDocument(options: IngestOptions): Promise<IngestedDocument> {
  assertAcceptableUpload({
    filename: options.filename,
    byteSize: options.bytes.byteLength,
    ...(options.maxBytes === undefined ? {} : { maxBytes: options.maxBytes }),
  });

  const stored = await options.blobs.put(options.bytes, { contentType: options.mimeType });

  if (options.reserve) await options.reserve(stored);

  const extraction = await extractText(
    { bytes: options.bytes, filename: options.filename, mimeType: options.mimeType },
    {
      ...(options.limits ? { limits: options.limits } : {}),
      ...(options.extractors ? { extractors: options.extractors } : {}),
    },
  );

  const chunks = extraction.outcome === 'extracted' ? chunkDocument(extraction.text) : [];

  return { stored, extraction, chunks };
}
