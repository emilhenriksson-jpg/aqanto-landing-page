/**
 * Supabase Storage as a `BlobStore`.
 *
 * One of three implementations of the same interface — `LocalBlobStore`,
 * `S3BlobStore`, this — and the reason the interface exists. Nothing in the memory
 * model knows which of them is installed, so moving document originals to Cloudflare
 * R2 later is a line in the composition root rather than a migration.
 *
 * Content-addressed like the others: the key is the SHA-256 of the bytes, so the same
 * file uploaded twice occupies one object and a retried upload is idempotent. That
 * matters more than it sounds — the retry path for a 40 MB PDF on a phone is a second
 * upload of the same file.
 *
 * Talks to the Storage REST API with the service role key rather than a person's token.
 * Photographic has already decided, in its own API layer, whether this person may write
 * to this room; handing Supabase a user token and letting it decide would be the
 * row-level security duplication the build plan rules out, and would put room
 * permissions in two places that can drift.
 */

import { createReadStream } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';

import { NotFoundError } from '@photographic/core';
import type { BlobStore, BlobUpload, StoredBlob } from '@photographic/documents';
import { blobKeyFor, checksumOf, createSpooledUpload } from '@photographic/documents';

const MISSING_BLOB_MESSAGE = 'Filen finns inte längre i lagringen.';

/** Just enough of `fetch` to be faked in a test without a network. */
export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface SupabaseStorageOptions {
  /** Project URL, without a trailing slash. */
  url: string;
  /** Service role key. Never logged, never returned, never sent anywhere else. */
  serviceRoleKey: string;
  bucket: string;
  /** Injected so tests run offline. */
  fetch?: FetchLike;
  /** Where a streamed upload is spooled. Defaults under the temp directory. */
  spoolDir?: string;
  /** Ceiling for a spooled upload. Defaults to `DEFAULT_SPOOL_MAX_BYTES`. */
  spoolMaxBytes?: number;
}

/**
 * How large a spooled export may get before this refuses.
 *
 * Two gibibytes, which is what a Fly machine's disk can be relied on to have free. It is
 * below the product's ten, and deliberately: refusing with an instruction beats filling
 * the disk out from under the database connection and the request path.
 */
export const DEFAULT_SPOOL_MAX_BYTES = 2 * 1024 * 1024 * 1024;

export class SupabaseStorageBlobStore implements BlobStore {
  private readonly base: string;
  private readonly headers: Record<string, string>;
  private readonly fetch: FetchLike;
  private readonly bucket: string;
  private readonly spoolDir: string;
  private readonly spoolMaxBytes: number;

  constructor(options: SupabaseStorageOptions) {
    this.bucket = options.bucket;
    this.spoolDir = options.spoolDir ?? join(tmpdir(), 'photographic-export-spool');
    this.spoolMaxBytes =
      options.spoolMaxBytes ??
      Number(process.env.SUPABASE_EXPORT_SPOOL_MAX_BYTES ?? DEFAULT_SPOOL_MAX_BYTES);
    this.base = `${options.url.replace(/\/+$/, '')}/storage/v1/object`;
    this.fetch = options.fetch ?? ((url, init) => globalThis.fetch(url, init));
    this.headers = {
      // Both headers, because the Storage API reads the key from `apikey` and the
      // identity from the bearer token, and sending only one authenticates as anon.
      apikey: options.serviceRoleKey,
      authorization: `Bearer ${options.serviceRoleKey}`,
    };
  }

  async put(bytes: Uint8Array, options?: { contentType?: string }): Promise<StoredBlob> {
    const checksum = checksumOf(bytes);
    const key = blobKeyFor(checksum);

    const response = await this.fetch(this.urlFor(key), {
      method: 'POST',
      headers: {
        ...this.headers,
        'content-type': options?.contentType || 'application/octet-stream',
        // No overwrite. The key is the checksum, so an object that already exists has
        // exactly these bytes and rewriting it would spend bandwidth to change nothing.
        'x-upsert': 'false',
        'cache-control': 'max-age=31536000',
      },
      // Cast because the DOM `BodyInit` union is not in scope under a node-only lib,
      // and a `Uint8Array` is a perfectly good request body at runtime.
      body: bytes as unknown as RequestInit['body'],
    });

    if (response.ok) {
      return { key, checksum, byteSize: bytes.byteLength, deduplicated: false };
    }

    // 409 is the dedup path, not a failure: another upload of the same bytes got there
    // first. Treated as success because, content-addressed, it *is* success.
    if (response.status === 409) {
      return { key, checksum, byteSize: bytes.byteLength, deduplicated: true };
    }

    throw await storageError('POST', key, response);
  }

  async get(key: string): Promise<Uint8Array> {
    const response = await this.fetch(this.urlFor(key), {
      method: 'GET',
      headers: this.headers,
    });

    if (response.status === 404) throw new NotFoundError(MISSING_BLOB_MESSAGE);
    if (!response.ok) throw await storageError('GET', key, response);

    return new Uint8Array(await response.arrayBuffer());
  }

  getStream(key: string): AsyncIterable<Uint8Array> {
    const request = () => this.fetch(this.urlFor(key), { method: 'GET', headers: this.headers });
    return {
      async *[Symbol.asyncIterator]() {
        const response = await request();
        if (response.status === 404) throw new NotFoundError(MISSING_BLOB_MESSAGE);
        if (!response.ok) throw await storageError('GET', key, response);
        if (!response.body) return;
        for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
          yield chunk;
        }
      },
    };
  }

  /**
   * A streamed upload, spooled to disk first.
   *
   * The Storage REST API takes one request with a length, so there is no way to hand it
   * an archive as it is produced. What this can guarantee is the part that matters on a
   * two-gigabyte machine: nothing is held in the process. The spool file is written as
   * the zip is produced and streamed off disk at the end.
   *
   * `SUPABASE_EXPORT_SPOOL_MAX_BYTES` bounds it below the machine's disk rather than
   * letting ENOSPC decide. Above that, the answer is an S3-compatible endpoint — Supabase
   * publishes one for this bucket — where `S3BlobStore` does a real multipart upload with
   * no ceiling but the product's.
   */
  async createUpload(options: { key: string; contentType?: string }): Promise<BlobUpload> {
    const send = async (spooled: { path: string; byteSize: number }): Promise<void> => {
      const file = createReadStream(spooled.path);
      const response = await this.fetch(this.urlFor(options.key), {
        method: 'POST',
        headers: {
          ...this.headers,
          'content-type': options.contentType || 'application/octet-stream',
          'content-length': String(spooled.byteSize),
          'x-upsert': 'true',
        },
        // A stream, so the bytes go from disk to socket without a copy in between.
        // `duplex` is required by the fetch spec for a streaming body.
        body: Readable.toWeb(file) as unknown as RequestInit['body'],
        duplex: 'half',
      } as RequestInit);

      if (!response.ok && response.status !== 409) {
        throw await storageError('POST', options.key, response);
      }
    };

    return createSpooledUpload({
      key: options.key,
      ...(options.contentType ? { contentType: options.contentType } : {}),
      spoolDir: this.spoolDir,
      maxBytes: this.spoolMaxBytes,
      send,
    });
  }

  async exists(key: string): Promise<boolean> {
    // `info/` rather than a HEAD on the object: the Storage API answers metadata here
    // without transferring the body, which a HEAD on some deployments does not.
    const response = await this.fetch(this.infoUrlFor(key), {
      method: 'GET',
      headers: this.headers,
    });

    if (response.status === 404) return false;
    if (!response.ok) throw await storageError('INFO', key, response);
    return true;
  }

  async delete(key: string): Promise<void> {
    const response = await this.fetch(this.urlFor(key), {
      method: 'DELETE',
      headers: this.headers,
    });

    // Deleting an absent key is not an error: the account-deletion path deletes
    // whatever a person's rows reference, and a blob already gone is the desired state.
    if (!response.ok && response.status !== 404) {
      throw await storageError('DELETE', key, response);
    }
  }

  /**
   * A time-limited URL for the original file.
   *
   * Not part of `BlobStore`, because not every backend can do it and a port whose
   * methods only work on one implementation is not a port. Used by the export download
   * link, where streaming a multi-gigabyte archive back through this process would be
   * paying for bandwidth twice.
   *
   * The bucket stays private throughout. A signed URL is a capability with an expiry;
   * a public bucket is a permanent one handed to anyone who learns a checksum.
   */
  async signedUrl(key: string, expiresInSeconds: number): Promise<string> {
    const response = await this.fetch(`${this.base}/sign/${this.bucket}/${key}`, {
      method: 'POST',
      headers: { ...this.headers, 'content-type': 'application/json' },
      body: JSON.stringify({ expiresIn: expiresInSeconds }),
    });

    if (response.status === 404) throw new NotFoundError(MISSING_BLOB_MESSAGE);
    if (!response.ok) throw await storageError('SIGN', key, response);

    const body = (await response.json()) as { signedURL?: string; signedUrl?: string };
    const path = body.signedURL ?? body.signedUrl;
    if (!path) throw new Error('Supabase Storage returnerade ingen signerad URL.');

    return path.startsWith('http')
      ? path
      : `${this.base.replace(/\/object$/, '')}${path.startsWith('/') ? '' : '/'}${path}`;
  }

  private urlFor(key: string): string {
    return `${this.base}/${this.bucket}/${key}`;
  }

  private infoUrlFor(key: string): string {
    return `${this.base}/info/${this.bucket}/${key}`;
  }
}

/**
 * Turns a failed response into an error worth reading.
 *
 * The body is included because Supabase Storage puts the actual reason there — a
 * missing bucket and a bad key both come back as 400 with different text — and capped
 * because it is remote input on its way to a log line.
 */
async function storageError(method: string, key: string, response: Response): Promise<Error> {
  let detail = '';
  try {
    detail = (await response.text()).slice(0, 300);
  } catch {
    detail = '';
  }
  return new Error(
    `Supabase Storage ${method} ${key} misslyckades: ${response.status} ${detail}`.trim(),
  );
}
