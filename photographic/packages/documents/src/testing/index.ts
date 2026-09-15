/**
 * Fakes for the two things document handling reaches outside itself for.
 *
 * Both are real implementations of their interface rather than stubs that record calls:
 * `MemoryBlobStore` genuinely deduplicates by checksum and genuinely refuses a missing
 * key, and `MemoryStorageLedger` genuinely enforces the limit atomically enough for a
 * single-threaded test. A fake that only remembers what it was asked cannot catch the
 * bugs these two have.
 */

import { createHash } from 'node:crypto';

import { NotFoundError, STORAGE_LIMIT_BYTES } from '@photographic/core';

import {
  blobKeyFor,
  checksumOf,
  type BlobStore,
  type BlobUpload,
  type StoredBlob,
} from '../blob-store.js';
import type { StorageLedger } from '../deps.js';

export class MemoryBlobStore implements BlobStore {
  private readonly objects = new Map<string, Uint8Array>();

  /** How many distinct objects are held. Deduplicated uploads do not add to this. */
  get size(): number {
    return this.objects.size;
  }

  async put(bytes: Uint8Array): Promise<StoredBlob> {
    const checksum = checksumOf(bytes);
    const key = blobKeyFor(checksum);

    if (this.objects.has(key)) {
      return { key, checksum, byteSize: bytes.byteLength, deduplicated: true };
    }

    // Copied, not referenced. A caller reusing its buffer would otherwise mutate what
    // it already stored, and the checksum would no longer describe the bytes.
    this.objects.set(key, new Uint8Array(bytes));
    return { key, checksum, byteSize: bytes.byteLength, deduplicated: false };
  }

  async get(key: string): Promise<Uint8Array> {
    const found = this.objects.get(key);
    if (!found) throw new NotFoundError('Filen finns inte längre i lagringen.');
    return new Uint8Array(found);
  }

  getStream(key: string): AsyncIterable<Uint8Array> {
    const objects = this.objects;
    return {
      async *[Symbol.asyncIterator]() {
        const found = objects.get(key);
        if (!found) throw new NotFoundError('Filen finns inte längre i lagringen.');
        // Handed over in pieces rather than whole, so a caller that assumes one chunk
        // fails here rather than against a real store.
        for (let at = 0; at < found.byteLength; at += 64 * 1024) {
          yield new Uint8Array(found.subarray(at, Math.min(at + 64 * 1024, found.byteLength)));
        }
      },
    };
  }

  /**
   * A streamed upload that keeps the bytes, because a test needs to read them back.
   *
   * The one thing it does not fake is the interface: `write` resolves before `complete`
   * is allowed to see the object, and a stream nobody completed leaves nothing behind —
   * which is the property the export's failure path depends on.
   */
  async createUpload(options: { key: string }): Promise<BlobUpload> {
    const objects = this.objects;
    const chunks: Uint8Array[] = [];
    const hash = createHash('sha256');
    let byteSize = 0;
    let settled = false;

    return {
      async write(chunk: Uint8Array) {
        if (settled) throw new Error('upload is already finished');
        hash.update(chunk);
        byteSize += chunk.byteLength;
        chunks.push(new Uint8Array(chunk));
      },
      async complete() {
        settled = true;
        objects.set(options.key, new Uint8Array(Buffer.concat(chunks.map((c) => Buffer.from(c)))));
        return { key: options.key, checksum: hash.digest('hex'), byteSize, deduplicated: false };
      },
      async abort() {
        settled = true;
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

interface LedgerEntry {
  byteSize: number;
  storageKey: string;
  refCount: number;
}

export class MemoryStorageLedger implements StorageLedger {
  private readonly entries = new Map<string, Map<string, LedgerEntry>>();

  constructor(private readonly limitBytes: number = STORAGE_LIMIT_BYTES) {}

  async usage(personId: string): Promise<{
    bytesUsed: number;
    limitBytes: number;
    objectCount: number;
  }> {
    const owned = this.entries.get(personId);
    if (!owned) return { bytesUsed: 0, limitBytes: this.limitBytes, objectCount: 0 };

    let bytesUsed = 0;
    for (const entry of owned.values()) bytesUsed += entry.byteSize;
    return { bytesUsed, limitBytes: this.limitBytes, objectCount: owned.size };
  }

  async reserve(input: {
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
  }> {
    const owned = this.entries.get(input.personId) ?? new Map<string, LedgerEntry>();
    this.entries.set(input.personId, owned);

    const existing = owned.get(input.checksum);
    if (existing) {
      existing.refCount += 1;
      return { allowed: true, deduplicated: true, ...(await this.usage(input.personId)) };
    }

    const before = await this.usage(input.personId);
    if (before.bytesUsed + input.byteSize > this.limitBytes) {
      return { allowed: false, deduplicated: false, ...before };
    }

    owned.set(input.checksum, {
      byteSize: input.byteSize,
      storageKey: input.storageKey,
      refCount: 1,
    });
    return { allowed: true, deduplicated: false, ...(await this.usage(input.personId)) };
  }

  async release(input: { personId: string; checksum: string }): Promise<boolean> {
    const owned = this.entries.get(input.personId);
    const existing = owned?.get(input.checksum);
    if (!owned || !existing) return false;

    existing.refCount -= 1;
    if (existing.refCount > 0) return false;

    owned.delete(input.checksum);
    return true;
  }
}
