/**
 * Blob storage, content-addressed by SHA-256.
 *
 * The key *is* the checksum, so the same bytes uploaded by two people in two rooms
 * occupy one object. That is not only a storage saving: it makes re-upload
 * idempotent, which matters because the retry path for a 40 MB PDF on a phone is a
 * second upload of the same file.
 *
 * `LocalBlobStore` is for development and tests. `S3BlobStore` talks to anything
 * S3-compatible (AWS, R2, MinIO) over signed HTTP.
 */

import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, sep } from 'node:path';
import { AwsClient } from 'aws4fetch';
import { NotFoundError } from '@photographic/core';

export interface StoredBlob {
  /** Content-addressed storage key, stable across stores. */
  key: string;
  /** Lowercase hex SHA-256 of the bytes. */
  checksum: string;
  byteSize: number;
  /** True when these exact bytes were already stored and nothing was written. */
  deduplicated: boolean;
}

export interface BlobStore {
  put(bytes: Uint8Array, options?: { contentType?: string }): Promise<StoredBlob>;
  /** Throws `NotFoundError` when the key is unknown. */
  get(key: string): Promise<Uint8Array>;
  exists(key: string): Promise<boolean>;
  /** Idempotent: deleting an absent key is not an error. */
  delete(key: string): Promise<void>;
}

export function checksumOf(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * Fans out over two levels of prefix. A single flat directory with a few hundred
 * thousand entries is slow on every filesystem worth naming, and S3 partitions on
 * key prefix.
 */
export function blobKeyFor(checksum: string): string {
  return `sha256/${checksum.slice(0, 2)}/${checksum.slice(2, 4)}/${checksum}`;
}

const MISSING_BLOB_MESSAGE = 'Filen finns inte längre i lagringen.';

// ---------------------------------------------------------------------------
// Local filesystem
// ---------------------------------------------------------------------------

export class LocalBlobStore implements BlobStore {
  private readonly root: string;

  constructor(options: { root: string }) {
    this.root = options.root;
  }

  async put(bytes: Uint8Array): Promise<StoredBlob> {
    const checksum = checksumOf(bytes);
    const key = blobKeyFor(checksum);
    const path = this.pathFor(key);

    if (await this.exists(key)) {
      return { key, checksum, byteSize: bytes.byteLength, deduplicated: true };
    }

    await mkdir(dirname(path), { recursive: true });
    // Write-then-rename so a crashed upload never leaves a truncated blob behind
    // under a key that claims to be its own checksum.
    const temp = `${path}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(temp, bytes);
    await rename(temp, path);

    return { key, checksum, byteSize: bytes.byteLength, deduplicated: false };
  }

  async get(key: string): Promise<Uint8Array> {
    try {
      return new Uint8Array(await readFile(this.pathFor(key)));
    } catch {
      throw new NotFoundError(MISSING_BLOB_MESSAGE);
    }
  }

  async exists(key: string): Promise<boolean> {
    try {
      await stat(this.pathFor(key));
      return true;
    } catch {
      return false;
    }
  }

  async delete(key: string): Promise<void> {
    await rm(this.pathFor(key), { force: true });
  }

  private pathFor(key: string): string {
    const safe = key.split('/').filter((part) => part.length > 0 && part !== '.' && part !== '..');
    if (safe.length === 0) throw new NotFoundError(MISSING_BLOB_MESSAGE);
    return join(this.root, safe.join(sep));
  }
}

// ---------------------------------------------------------------------------
// S3-compatible
// ---------------------------------------------------------------------------

/** Just enough of `aws4fetch`'s `AwsClient` to be faked in a test. */
export interface SignedFetcher {
  fetch(url: string, init?: RequestInit): Promise<Response>;
}

export interface S3BlobStoreOptions {
  /** Bucket endpoint, e.g. `https://s3.eu-north-1.amazonaws.com/photographic-docs`. */
  baseUrl: string;
  client: SignedFetcher;
  /** Optional key prefix, e.g. `prod`. */
  prefix?: string;
}

export class S3BlobStore implements BlobStore {
  private readonly baseUrl: string;
  private readonly client: SignedFetcher;
  private readonly prefix: string;

  constructor(options: S3BlobStoreOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.client = options.client;
    this.prefix = options.prefix ? `${options.prefix.replace(/^\/+|\/+$/g, '')}/` : '';
  }

  async put(bytes: Uint8Array, options?: { contentType?: string }): Promise<StoredBlob> {
    const checksum = checksumOf(bytes);
    const key = blobKeyFor(checksum);

    if (await this.exists(key)) {
      return { key, checksum, byteSize: bytes.byteLength, deduplicated: true };
    }

    const response = await this.client.fetch(this.urlFor(key), {
      method: 'PUT',
      body: bytes,
      headers: {
        'content-type': options?.contentType ?? 'application/octet-stream',
        'content-length': String(bytes.byteLength),
      },
    });
    if (!response.ok) throw await storageError('PUT', key, response);

    return { key, checksum, byteSize: bytes.byteLength, deduplicated: false };
  }

  async get(key: string): Promise<Uint8Array> {
    const response = await this.client.fetch(this.urlFor(key), { method: 'GET' });
    if (response.status === 404) throw new NotFoundError(MISSING_BLOB_MESSAGE);
    if (!response.ok) throw await storageError('GET', key, response);
    return new Uint8Array(await response.arrayBuffer());
  }

  async exists(key: string): Promise<boolean> {
    const response = await this.client.fetch(this.urlFor(key), { method: 'HEAD' });
    if (response.status === 404) return false;
    if (!response.ok) throw await storageError('HEAD', key, response);
    return true;
  }

  async delete(key: string): Promise<void> {
    const response = await this.client.fetch(this.urlFor(key), { method: 'DELETE' });
    if (!response.ok && response.status !== 404) throw await storageError('DELETE', key, response);
  }

  private urlFor(key: string): string {
    return `${this.baseUrl}/${this.prefix}${key}`;
  }
}

export interface S3BlobStoreConfig {
  baseUrl: string;
  accessKeyId: string;
  secretAccessKey: string;
  region?: string;
  sessionToken?: string;
  prefix?: string;
}

export function createS3BlobStore(config: S3BlobStoreConfig): S3BlobStore {
  const client = new AwsClient({
    accessKeyId: config.accessKeyId,
    secretAccessKey: config.secretAccessKey,
    sessionToken: config.sessionToken,
    service: 's3',
    region: config.region ?? 'auto',
  });
  return new S3BlobStore({ baseUrl: config.baseUrl, client, prefix: config.prefix });
}

async function storageError(method: string, key: string, response: Response): Promise<Error> {
  let detail = '';
  try {
    detail = (await response.text()).slice(0, 300);
  } catch {
    detail = '';
  }
  return new Error(`blob store ${method} ${key} failed: ${response.status} ${detail}`.trim());
}
