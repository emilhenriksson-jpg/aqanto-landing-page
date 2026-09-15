/**
 * What this package needs from the outside world, and nothing more.
 *
 * Deliberately narrower than the ports in `@photographic/core`. This package holds the
 * parts of document handling that have no opinion about where rows live: reading bytes,
 * pulling text out of them, cutting that text into chunks, and counting storage. It is
 * written against these interfaces so it can be tested without a database, and so both
 * `DocumentPort` implementations can call the same pipeline.
 *
 * Note where permission is *not*. Nothing here takes an actor, because nothing here
 * decides anything about access. Membership is resolved by the caller before this
 * package is reached, against real memberships — a write is authorized by what the
 * OAuth token can do, never by anything found inside the uploaded file.
 */

import type { LlmPort } from '@photographic/core';

export type { BlobStore, StoredBlob } from './blob-store.js';

/**
 * The slice of `LlmPort` documents use. A full `LlmPort` satisfies it structurally.
 *
 * `embed` is here even though no embedding is written yet: the summariser and the
 * eventual embedder are the same dependency, and narrowing this to `summarise` now
 * would have to be widened again by whoever turns embeddings on.
 */
export type DocumentLlm = Pick<LlmPort, 'embed' | 'summarise'>;

/**
 * Per-person storage accounting, as the pipeline needs it.
 *
 * Two methods rather than one because they answer different questions at different
 * costs. `usage` is a read for a meter on a screen; `reserve` is an atomic
 * check-and-increment on the write path, and the two must not be the same call — a
 * read followed by a write lets two concurrent uploads past a limit neither should
 * have passed.
 */
export interface StorageLedger {
  usage(personId: string): Promise<{ bytesUsed: number; limitBytes: number; objectCount: number }>;

  /**
   * Charges `byteSize` against the person, or refuses.
   *
   * `deduplicated` means these exact bytes were already on their account: nothing new
   * was charged, and such an upload is always allowed even at the limit, because it
   * consumes nothing and is the one path that most needs to be idempotent.
   */
  reserve(input: {
    personId: string;
    checksum: string;
    byteSize: number;
    storageKey: string;
  }): Promise<{
    allowed: boolean;
    deduplicated: boolean;
    bytesUsed: number;
    limitBytes: number;
    objectCount: number;
  }>;

  /** Gives the space back. True when the object became unreferenced and can be deleted. */
  release(input: { personId: string; checksum: string }): Promise<boolean>;
}
