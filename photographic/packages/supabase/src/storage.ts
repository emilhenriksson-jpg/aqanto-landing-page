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

import { NotFoundError } from '@photographic/core';
import type { BlobStore, StoredBlob } from '@photographic/documents';
import { blobKeyFor, checksumOf } from '@photographic/documents';

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
}

export class SupabaseStorageBlobStore implements BlobStore {
  private readonly base: string;
  private readonly headers: Record<string, string>;
  private readonly fetch: FetchLike;
  private readonly bucket: string;

  constructor(options: SupabaseStorageOptions) {
    this.bucket = options.bucket;
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
