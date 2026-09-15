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

import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
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

/**
 * An upload in progress, whose length nobody knows yet.
 *
 * The export is why this exists. `put` takes bytes, so anything written through it is
 * resident in the process first — fine for a 4 MB PDF, fatal for a ten-gigabyte archive
 * on a two-gigabyte machine. Here the caller pushes chunks, the implementation gets rid
 * of them as they arrive, and `write` does not resolve until it has, which is what makes
 * a slow network slow down the producer instead of filling memory.
 *
 * The key is given by the caller rather than derived from the content, because a
 * content-addressed key is not knowable until the last byte has been read. Streamed
 * objects are therefore not deduplicated, and are not meant to be: an export archive is
 * unique to the moment it was taken.
 */
export interface BlobUpload {
  /** Resolves once the chunk is no longer the caller's problem. Backpressure lives here. */
  write(chunk: Uint8Array): Promise<void>;
  /** Finishes the object and reports what was written, checksum included. */
  complete(): Promise<StoredBlob>;
  /** Abandons it. Idempotent, and never throws: it is called from failure paths. */
  abort(): Promise<void>;
}

export interface BlobStore {
  put(bytes: Uint8Array, options?: { contentType?: string }): Promise<StoredBlob>;
  /** Throws `NotFoundError` when the key is unknown. */
  get(key: string): Promise<Uint8Array>;
  /**
   * The same bytes, in pieces.
   *
   * Required rather than optional, because the two paths that need it — writing a
   * document into an archive and serving an archive back — are the two paths where a
   * whole object in memory is the difference between a download and a dead machine.
   * Throws `NotFoundError` when the key is unknown, like `get`.
   */
  getStream(key: string): AsyncIterable<Uint8Array>;
  /** Begins a streamed upload under a caller-chosen key. */
  createUpload(options: { key: string; contentType?: string }): Promise<BlobUpload>;
  exists(key: string): Promise<boolean>;
  /** Idempotent: deleting an absent key is not an error. */
  delete(key: string): Promise<void>;
}

/**
 * Where a streamed object goes when the caller has not said.
 *
 * Exports live under one prefix so they are recognisable in a bucket listing, and are
 * never mistaken for the content-addressed `sha256/...` objects that documents use — a
 * lifecycle rule that expired one must never reach the other.
 */
export function exportKeyFor(exportId: string): string {
  return `exports/${exportId}.zip`;
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

/**
 * How much of a streamed upload is held before it is sent.
 *
 * Eight mebibytes, against S3's five-mebibyte minimum for every part but the last. It is
 * also the memory bound for an export: one part in hand, one in flight. Larger would buy
 * fewer requests at the cost of the only number that matters here, on a machine with two
 * gigabytes for everything.
 */
export const MULTIPART_PART_BYTES = 8 * 1024 * 1024;

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

  getStream(key: string): AsyncIterable<Uint8Array> {
    const path = this.pathFor(key);
    return {
      async *[Symbol.asyncIterator]() {
        // Opened lazily, inside the iterator, so a caller that never iterates leaves no
        // descriptor behind. `stat` first so a missing key is the same `NotFoundError`
        // `get` gives rather than a stream that fails on first read.
        try {
          await stat(path);
        } catch {
          throw new NotFoundError(MISSING_BLOB_MESSAGE);
        }
        const handle = await open(path, 'r');
        try {
          for await (const chunk of handle.createReadStream({ autoClose: false })) {
            yield new Uint8Array(chunk as Buffer);
          }
        } finally {
          await handle.close();
        }
      },
    };
  }

  async createUpload(options: { key: string }): Promise<BlobUpload> {
    const path = this.pathFor(options.key);
    await mkdir(dirname(path), { recursive: true });

    // Written to a temporary name and renamed at the end, like `put` does: a crashed
    // export must not leave a truncated archive under a key a download link points at.
    const temp = `${path}.${process.pid}.${Date.now()}.part`;
    const handle = await open(temp, 'w');
    const hash = createHash('sha256');
    let byteSize = 0;
    let closed = false;

    return {
      async write(chunk) {
        hash.update(chunk);
        byteSize += chunk.byteLength;
        await handle.write(chunk);
      },
      async complete() {
        closed = true;
        await handle.close();
        await rename(temp, path);
        return { key: options.key, checksum: hash.digest('hex'), byteSize, deduplicated: false };
      },
      async abort() {
        if (!closed) {
          closed = true;
          await handle.close().catch(() => {});
        }
        await rm(temp, { force: true }).catch(() => {});
      },
    };
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

  getStream(key: string): AsyncIterable<Uint8Array> {
    const client = this.client;
    const url = this.urlFor(key);
    return {
      async *[Symbol.asyncIterator]() {
        const response = await client.fetch(url, { method: 'GET' });
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
   * A real S3 multipart upload: create, upload parts as they fill, complete.
   *
   * Parts are the reason this is the streaming path rather than a spool. Each is sent as
   * soon as it reaches `MULTIPART_PART_BYTES` and is then dropped, so the process holds
   * one part rather than one archive — a bound set by a constant here instead of by how
   * much a person happened to store.
   */
  async createUpload(options: { key: string; contentType?: string }): Promise<BlobUpload> {
    const url = this.urlFor(options.key);
    const created = await this.client.fetch(`${url}?uploads=`, {
      method: 'POST',
      headers: { 'content-type': options.contentType ?? 'application/octet-stream' },
    });
    if (!created.ok) throw await storageError('POST uploads', options.key, created);

    const uploadId = firstXmlValue(await created.text(), 'UploadId');
    if (!uploadId) {
      throw new Error(`blob store multipart ${options.key} returned no UploadId`);
    }

    const client = this.client;
    const hash = createHash('sha256');
    const parts: Array<{ number: number; etag: string }> = [];
    let pending: Uint8Array[] = [];
    let pendingBytes = 0;
    let byteSize = 0;
    let done = false;

    const flush = async (): Promise<void> => {
      if (pendingBytes === 0) return;
      const body = Buffer.concat(pending.map((chunk) => Buffer.from(chunk)));
      pending = [];
      pendingBytes = 0;

      const number = parts.length + 1;
      const response = await client.fetch(`${url}?partNumber=${number}&uploadId=${uploadId}`, {
        method: 'PUT',
        body,
        headers: { 'content-length': String(body.byteLength) },
      });
      if (!response.ok) throw await storageError(`PUT part ${number}`, options.key, response);

      // The ETag identifies the part in the completion request. Quoted in the header and
      // quoted again in the XML, so it is carried through exactly as received.
      const etag = response.headers.get('etag');
      if (!etag) throw new Error(`blob store multipart part ${number} returned no ETag`);
      parts.push({ number, etag });
    };

    return {
      async write(chunk) {
        hash.update(chunk);
        byteSize += chunk.byteLength;
        pending.push(chunk);
        pendingBytes += chunk.byteLength;
        // Awaited rather than fired off: the point of a part boundary is that the
        // producer stops here while the bytes go out.
        if (pendingBytes >= MULTIPART_PART_BYTES) await flush();
      },

      async complete() {
        await flush();
        done = true;

        // An empty archive is not a thing this produces, but a zero-part multipart
        // upload cannot be completed at all, so it becomes an ordinary empty PUT.
        if (parts.length === 0) {
          const empty = await client.fetch(url, { method: 'PUT', body: new Uint8Array(0) });
          if (!empty.ok) throw await storageError('PUT empty', options.key, empty);
          await client.fetch(`${url}?uploadId=${uploadId}`, { method: 'DELETE' });
          return { key: options.key, checksum: hash.digest('hex'), byteSize: 0, deduplicated: false };
        }

        const body =
          '<CompleteMultipartUpload>' +
          parts
            .map(
              (part) =>
                `<Part><PartNumber>${part.number}</PartNumber><ETag>${part.etag}</ETag></Part>`,
            )
            .join('') +
          '</CompleteMultipartUpload>';

        const response = await client.fetch(`${url}?uploadId=${uploadId}`, {
          method: 'POST',
          body,
          headers: { 'content-type': 'application/xml' },
        });
        if (!response.ok) throw await storageError('POST complete', options.key, response);
        // S3 can answer 200 and then describe a failure in the body. Treated as a
        // failure, because the alternative is a download link to a half-written archive.
        const text = await response.text();
        if (/<Error>/.test(text)) {
          throw new Error(`blob store multipart ${options.key} failed: ${text.slice(0, 300)}`);
        }

        return { key: options.key, checksum: hash.digest('hex'), byteSize, deduplicated: false };
      },

      async abort() {
        if (done) return;
        done = true;
        pending = [];
        pendingBytes = 0;
        // Aborting matters more than it looks: parts of an abandoned upload are billed
        // until the upload is aborted or a lifecycle rule reaps it.
        await client
          .fetch(`${url}?uploadId=${uploadId}`, { method: 'DELETE' })
          .catch(() => undefined);
      },
    };
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

/**
 * A streamed upload for a store that can only take a whole body.
 *
 * Supabase Storage's REST API is the case: it wants a request with a length, so there is
 * no way to hand it bytes as they are produced. Spooling to a temporary file is the
 * honest fallback — the archive is never resident in the process, so the machine survives
 * it, and the upload at the end streams off disk with a known length.
 *
 * It is a fallback and not the answer. Disk on a Fly machine is smaller than the ten
 * gigabytes a person may store, so `maxBytes` refuses before ENOSPC does, with something
 * an operator can act on: point `BLOB_S3_*` at an S3-compatible endpoint — Supabase's own
 * included — and the multipart path takes over with no ceiling but the product's.
 */
export function createSpooledUpload(options: {
  key: string;
  contentType?: string;
  spoolDir: string;
  maxBytes: number;
  /** Sends the finished file. Given a path and a length so it can stream it. */
  send: (spooled: { path: string; byteSize: number }) => Promise<void>;
  onSpool?: (detail: { key: string; maxBytes: number }) => void;
}): Promise<BlobUpload> {
  return (async () => {
    await mkdir(options.spoolDir, { recursive: true });
    const path = join(options.spoolDir, `${randomUUID()}.part`);
    const handle = await open(path, 'w');
    const hash = createHash('sha256');
    let byteSize = 0;
    let closed = false;
    options.onSpool?.({ key: options.key, maxBytes: options.maxBytes });

    const close = async () => {
      if (closed) return;
      closed = true;
      await handle.close().catch(() => {});
    };

    return {
      async write(chunk: Uint8Array) {
        if (byteSize + chunk.byteLength > options.maxBytes) {
          throw new Error(
            `Den här lagringen kan ta emot högst ${Math.round(options.maxBytes / 1024 ** 3)} GB ` +
              'per export. Konfigurera S3-kompatibel lagring för att ta bort gränsen.',
          );
        }
        hash.update(chunk);
        byteSize += chunk.byteLength;
        await handle.write(chunk);
      },

      async complete() {
        await close();
        try {
          // Handed over as a path, not as bytes: the send is a stream off disk, so the
          // archive is never resident in the process at any point in this path.
          await options.send({ path, byteSize });
          return { key: options.key, checksum: hash.digest('hex'), byteSize, deduplicated: false };
        } finally {
          await rm(path, { force: true }).catch(() => {});
        }
      },

      async abort() {
        await close();
        await rm(path, { force: true }).catch(() => {});
      },
    };
  })();
}

/** The first value of an XML element, which is all S3's responses are read for here. */
function firstXmlValue(xml: string, tag: string): string | null {
  return new RegExp(`<${tag}>([^<]+)</${tag}>`).exec(xml)?.[1] ?? null;
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
