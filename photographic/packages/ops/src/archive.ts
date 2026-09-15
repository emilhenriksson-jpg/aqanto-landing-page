/**
 * The off-site copy of the document originals.
 *
 * This exists because of one sentence in Supabase's own documentation: "Database backups do
 * not include objects you store via the Storage API, as the database only includes metadata
 * about these objects." So the daily backup covers memories, events, rooms and proposals —
 * and covers **none** of the files people uploaded. Until this archive is running, the
 * documents are the one part of a person's memory that cannot be recovered at all, while
 * everything around them can.
 *
 * Two constraints shape the whole file, and they are constraints rather than preferences:
 *
 * 1. **It must not live where the thing it protects lives.** A second bucket in the same
 *    Supabase project is deleted with the project — Supabase say so explicitly about
 *    deletion removing "all associated data, including any backups stored in S3" — and a
 *    directory on the Fly machine is gone at the next deploy. `assertOffSite` therefore
 *    refuses those two configurations rather than trusting whoever wrote the environment.
 * 2. **It is a separate interface from `BlobStore`, on purpose.** `BlobStore` is
 *    content-addressed: `put(bytes)` decides the key from the bytes, which is exactly right
 *    for the product and useless for a manifest, which has to live at a name a reader can
 *    guess. So the archive takes a key, and `archiveBlobStore` adapts it back for the
 *    verification instrument that already exists.
 */

import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, join, sep } from 'node:path';

import { AwsClient } from 'aws4fetch';
import { NotFoundError } from '@photographic/core';
import type { BlobStore, BlobUpload, StoredBlob } from '@photographic/documents';

export type ArchiveKind = 's3' | 'local';

export interface ObjectArchive {
  readonly kind: ArchiveKind;
  /** Where it points, without credentials. Safe to log and to put in a report. */
  readonly target: string;
  put(key: string, bytes: Uint8Array, contentType?: string): Promise<void>;
  /** Null when the key is not there. Absence is an ordinary answer here, not an error. */
  get(key: string): Promise<Uint8Array | null>;
  exists(key: string): Promise<boolean>;
}

/** Where the record of the last backup lives. A fixed name, so a check can find it. */
export const MANIFEST_KEY = 'photographic/document-archive-manifest.json';

export class ArchiveConfigurationError extends Error {}

// ---------------------------------------------------------------------------
// S3-compatible: Cloudflare R2, Backblaze B2, AWS S3, MinIO
// ---------------------------------------------------------------------------

export interface SignedFetcher {
  fetch(url: string, init?: RequestInit): Promise<Response>;
}

export interface S3ObjectArchiveOptions {
  /** Bucket endpoint, e.g. `https://<account>.r2.cloudflarestorage.com/photographic-docs`. */
  baseUrl: string;
  client: SignedFetcher;
  prefix?: string;
  timeoutMs?: number;
}

export class S3ObjectArchive implements ObjectArchive {
  readonly kind = 's3' as const;
  private readonly baseUrl: string;
  private readonly prefix: string;
  private readonly client: SignedFetcher;
  private readonly timeoutMs: number;

  constructor(options: S3ObjectArchiveOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.prefix = options.prefix ? `${options.prefix.replace(/^\/+|\/+$/g, '')}/` : '';
    this.client = options.client;
    this.timeoutMs = options.timeoutMs ?? 60_000;
  }

  get target(): string {
    return `${this.baseUrl}/${this.prefix}`;
  }

  async put(key: string, bytes: Uint8Array, contentType?: string): Promise<void> {
    const response = await this.client.fetch(this.urlFor(key), {
      method: 'PUT',
      body: bytes as unknown as RequestInit['body'],
      headers: {
        'content-type': contentType ?? 'application/octet-stream',
        'content-length': String(bytes.byteLength),
      },
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!response.ok) throw await archiveError('PUT', key, response);
  }

  async get(key: string): Promise<Uint8Array | null> {
    const response = await this.client.fetch(this.urlFor(key), {
      method: 'GET',
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (response.status === 404) return null;
    if (!response.ok) throw await archiveError('GET', key, response);
    return new Uint8Array(await response.arrayBuffer());
  }

  async exists(key: string): Promise<boolean> {
    const response = await this.client.fetch(this.urlFor(key), {
      method: 'HEAD',
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (response.status === 404) return false;
    if (!response.ok) throw await archiveError('HEAD', key, response);
    return true;
  }

  private urlFor(key: string): string {
    return `${this.baseUrl}/${this.prefix}${key}`;
  }
}

// ---------------------------------------------------------------------------
// A directory
// ---------------------------------------------------------------------------

/**
 * For a drill, and for the copy a person keeps on a disk they can hold.
 *
 * Not a production archive on the Fly machine — `assertOffSite` refuses that, because a
 * copy on the machine being backed up is not a copy of anything.
 */
export class LocalObjectArchive implements ObjectArchive {
  readonly kind = 'local' as const;

  constructor(private readonly root: string) {}

  get target(): string {
    return this.root;
  }

  async put(key: string, bytes: Uint8Array): Promise<void> {
    const path = this.pathFor(key);
    await mkdir(dirname(path), { recursive: true });
    // Write-then-rename, so an interrupted backup never leaves a truncated object behind a
    // name that claims to be a whole one.
    const temporary = `${path}.${process.pid}.tmp`;
    await writeFile(temporary, bytes);
    const { rename } = await import('node:fs/promises');
    await rename(temporary, path);
  }

  async get(key: string): Promise<Uint8Array | null> {
    try {
      return new Uint8Array(await readFile(this.pathFor(key)));
    } catch {
      return null;
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

  private pathFor(key: string): string {
    const safe = key.split('/').filter((part) => part.length > 0 && part !== '.' && part !== '..');
    if (safe.length === 0) throw new ArchiveConfigurationError('Tom nyckel.');
    return join(this.root, safe.join(sep));
  }
}

// ---------------------------------------------------------------------------
// Reading an archive with the instrument that already exists
// ---------------------------------------------------------------------------

/**
 * Presents an archive as a read-only `BlobStore`.
 *
 * So that `verifyDocuments` — which walks `app.document`, fetches every original and
 * re-hashes it — can be pointed at the backup without a second implementation of the same
 * check. The write methods throw: a verifier that could write is a verifier that can repair
 * the thing it is measuring, and then it always passes.
 */
export function archiveBlobStore(archive: ObjectArchive): BlobStore {
  const refuse = (): never => {
    throw new ArchiveConfigurationError('Arkivet är läsbart här, inte skrivbart.');
  };
  return {
    put: async (): Promise<StoredBlob> => refuse(),
    createUpload: async (): Promise<BlobUpload> => refuse(),
    delete: async (): Promise<void> => refuse(),
    exists: (key) => archive.exists(key),
    get: async (key) => {
      const bytes = await archive.get(key);
      if (!bytes) throw new NotFoundError('Filen finns inte i arkivet.');
      return bytes;
    },
    // One chunk. `ObjectArchive` hands back whole objects, so there is nothing to stream
    // from underneath; this satisfies the interface honestly rather than pretending to a
    // memory profile it does not have. The verifier re-hashes what it reads either way.
    getStream: async function* (key) {
      const bytes = await archive.get(key);
      if (!bytes) throw new NotFoundError('Filen finns inte i arkivet.');
      yield bytes;
    },
  };
}

// ---------------------------------------------------------------------------
// Selection from the environment, and the refusal that makes it a backup
// ---------------------------------------------------------------------------

export interface ArchiveSelection {
  archive: ObjectArchive;
  /** How stale the last backup may be before the alarm fires. */
  maxAgeMs: number;
}

/**
 * Reads the archive configuration, or returns null when there is none.
 *
 * | Variable | Where it lives | What it does |
 * | --- | --- | --- |
 * | `DOCUMENT_ARCHIVE_S3_BASE_URL` | secret | Bucket endpoint at a *different provider* — R2, B2, S3. |
 * | `DOCUMENT_ARCHIVE_S3_ACCESS_KEY_ID` / `_SECRET_ACCESS_KEY` | secret | Its credentials. Scope them to that one bucket. |
 * | `DOCUMENT_ARCHIVE_S3_REGION` | env | `auto` for R2; the real region elsewhere. |
 * | `DOCUMENT_ARCHIVE_S3_PREFIX` | env | Optional key prefix. |
 * | `DOCUMENT_ARCHIVE_DIR` | env | A directory instead. Drills and laptops only. |
 * | `DOCUMENT_ARCHIVE_MAX_AGE_HOURS` | env | Default 26 — a daily backup plus two hours of slack. |
 */
export function createArchiveFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  options: { fetch?: (url: string, init?: RequestInit) => Promise<Response> } = {},
): ArchiveSelection | null {
  const maxAgeMs = hours(env.DOCUMENT_ARCHIVE_MAX_AGE_HOURS, 26);

  const baseUrl = env.DOCUMENT_ARCHIVE_S3_BASE_URL?.trim();
  if (baseUrl) {
    const accessKeyId = required(
      env.DOCUMENT_ARCHIVE_S3_ACCESS_KEY_ID,
      'DOCUMENT_ARCHIVE_S3_BASE_URL kräver DOCUMENT_ARCHIVE_S3_ACCESS_KEY_ID.',
    );
    const secretAccessKey = required(
      env.DOCUMENT_ARCHIVE_S3_SECRET_ACCESS_KEY,
      'DOCUMENT_ARCHIVE_S3_BASE_URL kräver DOCUMENT_ARCHIVE_S3_SECRET_ACCESS_KEY.',
    );
    assertOffSite({ target: baseUrl, kind: 's3', env });

    const aws = new AwsClient({
      accessKeyId,
      secretAccessKey,
      service: 's3',
      region: env.DOCUMENT_ARCHIVE_S3_REGION ?? 'auto',
    });
    const client: SignedFetcher = options.fetch
      ? { fetch: (url, init) => options.fetch!(url, init) }
      : { fetch: (url, init) => aws.fetch(url, init) };

    return {
      archive: new S3ObjectArchive({
        baseUrl,
        client,
        ...(env.DOCUMENT_ARCHIVE_S3_PREFIX ? { prefix: env.DOCUMENT_ARCHIVE_S3_PREFIX } : {}),
      }),
      maxAgeMs,
    };
  }

  const dir = env.DOCUMENT_ARCHIVE_DIR?.trim();
  if (dir) {
    assertOffSite({ target: dir, kind: 'local', env });
    return { archive: new LocalObjectArchive(dir), maxAgeMs };
  }

  return null;
}

/**
 * Refuses the two configurations that look like a backup and are not.
 *
 * This is a guard rather than a comment because both mistakes are easy to make from good
 * intentions — "it is already S3-compatible", "the disk is right there" — and both fail
 * silently until the day they are needed, which is the day the project or the machine is
 * gone. The check is on the destination only; a person who wants to point the archive at
 * some other Supabase project can, because `SUPABASE_URL` is what is compared.
 */
export function assertOffSite(input: {
  target: string;
  kind: ArchiveKind;
  env: NodeJS.ProcessEnv;
}): void {
  if (input.kind === 's3') {
    const host = hostOf(input.target);
    const supabaseHost = input.env.SUPABASE_URL ? hostOf(input.env.SUPABASE_URL) : null;
    if (supabaseHost && host === supabaseHost) {
      throw new ArchiveConfigurationError(
        'Arkivet pekar på samma Supabase-projekt som dokumenten ligger i. En kopia som ' +
          'raderas tillsammans med projektet är ingen kopia — peka den på en annan ' +
          'leverantör (R2, B2, S3).',
      );
    }
    return;
  }

  if (input.env.NODE_ENV === 'production') {
    throw new ArchiveConfigurationError(
      'DOCUMENT_ARCHIVE_DIR är en katalog på maskinen, och maskinen byts ut vid varje ' +
        'deploy. Använd DOCUMENT_ARCHIVE_S3_* i produktion; katalogen finns för övningar.',
    );
  }
}

function hostOf(value: string): string {
  try {
    return new URL(value).host.toLowerCase();
  } catch {
    return value.toLowerCase();
  }
}

function hours(value: string | undefined, fallback: number): number {
  const parsed = Number.parseFloat(value ?? '');
  return (Number.isFinite(parsed) && parsed > 0 ? parsed : fallback) * 3_600_000;
}

function required(value: string | undefined, message: string): string {
  if (!value) throw new ArchiveConfigurationError(message);
  return value;
}

async function archiveError(method: string, key: string, response: Response): Promise<Error> {
  let detail: string;
  try {
    detail = (await response.text()).slice(0, 300);
  } catch {
    detail = '';
  }
  return new Error(`Dokumentarkivet ${method} ${key} misslyckades: ${response.status} ${detail}`.trim());
}
