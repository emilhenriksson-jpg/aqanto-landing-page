import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import {
  archiveBlobStore,
  ArchiveConfigurationError,
  assertOffSite,
  createArchiveFromEnv,
  LocalObjectArchive,
  S3ObjectArchive,
} from './archive.js';

const bytes = new TextEncoder().encode('en avtalstext');

describe('LocalObjectArchive', () => {
  it('round-trips an object and reports absence as null rather than throwing', async () => {
    const archive = new LocalObjectArchive(await mkdtemp(join(tmpdir(), 'arkiv-')));

    expect(await archive.exists('sha256/ab/cd/abcd')).toBe(false);
    expect(await archive.get('sha256/ab/cd/abcd')).toBeNull();

    await archive.put('sha256/ab/cd/abcd', bytes);

    expect(await archive.exists('sha256/ab/cd/abcd')).toBe(true);
    expect(await archive.get('sha256/ab/cd/abcd')).toEqual(bytes);
  });

  it('refuses to escape its own root', async () => {
    const archive = new LocalObjectArchive(await mkdtemp(join(tmpdir(), 'arkiv-')));
    await archive.put('../../utanför', bytes);
    expect(await archive.exists('utanför')).toBe(true);
  });
});

describe('S3ObjectArchive', () => {
  function fakeS3() {
    const objects = new Map<string, Uint8Array>();
    const client = {
      fetch: vi.fn(async (url: string, init?: RequestInit) => {
        const key = new URL(url).pathname;
        if (init?.method === 'PUT') {
          objects.set(key, new Uint8Array(init.body as unknown as ArrayBuffer));
          return new Response('', { status: 200 });
        }
        const found = objects.get(key);
        if (!found) return new Response('', { status: 404 });
        if (init?.method === 'HEAD') return new Response('', { status: 200 });
        return new Response(found, { status: 200 });
      }),
    };
    return { client, objects };
  }

  it('puts and gets under a prefixed key', async () => {
    const { client, objects } = fakeS3();
    const archive = new S3ObjectArchive({
      baseUrl: 'https://acct.r2.cloudflarestorage.com/photographic',
      client,
      prefix: 'prod',
    });

    await archive.put('sha256/ab/cd/abcd', bytes);

    expect([...objects.keys()]).toEqual(['/photographic/prod/sha256/ab/cd/abcd']);
    expect(await archive.get('sha256/ab/cd/abcd')).toEqual(bytes);
    expect(await archive.exists('sha256/ab/cd/abcd')).toBe(true);
    expect(await archive.exists('sha256/ff/ff/ffff')).toBe(false);
  });

  it('turns an unexpected status into an error that names the key', async () => {
    const archive = new S3ObjectArchive({
      baseUrl: 'https://acct.r2.cloudflarestorage.com/photographic',
      client: { fetch: async () => new Response('AccessDenied', { status: 403 }) },
    });

    await expect(archive.get('sha256/ab/cd/abcd')).rejects.toThrow('403');
  });
});

describe('assertOffSite', () => {
  it('refuses an archive in the same Supabase project as the documents', () => {
    expect(() =>
      assertOffSite({
        kind: 's3',
        target: 'https://abc.supabase.co/storage/v1/s3/backup',
        env: { SUPABASE_URL: 'https://abc.supabase.co' },
      }),
    ).toThrow(ArchiveConfigurationError);
  });

  it('allows a different provider', () => {
    expect(() =>
      assertOffSite({
        kind: 's3',
        target: 'https://acct.r2.cloudflarestorage.com/photographic',
        env: { SUPABASE_URL: 'https://abc.supabase.co' },
      }),
    ).not.toThrow();
  });

  it('refuses a directory on the machine in production, and allows it for a drill', () => {
    expect(() => assertOffSite({ kind: 'local', target: '/data/backup', env: { NODE_ENV: 'production' } })).toThrow(
      /katalog på maskinen/,
    );
    expect(() => assertOffSite({ kind: 'local', target: '/tmp/backup', env: {} })).not.toThrow();
  });
});

describe('createArchiveFromEnv', () => {
  it('is null when nothing is configured, so the caller can say so out loud', () => {
    expect(createArchiveFromEnv({})).toBeNull();
  });

  it('refuses a half-configured archive rather than backing up nowhere', () => {
    expect(() =>
      createArchiveFromEnv({ DOCUMENT_ARCHIVE_S3_BASE_URL: 'https://acct.r2.cloudflarestorage.com/x' }),
    ).toThrow('DOCUMENT_ARCHIVE_S3_ACCESS_KEY_ID');
  });

  it('reads the staleness threshold, defaulting to a nightly run plus slack', () => {
    const selection = createArchiveFromEnv({ DOCUMENT_ARCHIVE_DIR: '/tmp/arkiv' });
    expect(selection?.maxAgeMs).toBe(26 * 3_600_000);

    const tighter = createArchiveFromEnv({
      DOCUMENT_ARCHIVE_DIR: '/tmp/arkiv',
      DOCUMENT_ARCHIVE_MAX_AGE_HOURS: '6',
    });
    expect(tighter?.maxAgeMs).toBe(6 * 3_600_000);
  });
});

describe('archiveBlobStore', () => {
  it('reads through so the existing verifier can be pointed at the archive', async () => {
    const archive = new LocalObjectArchive(await mkdtemp(join(tmpdir(), 'arkiv-')));
    await archive.put('sha256/ab/cd/abcd', bytes);
    const store = archiveBlobStore(archive);

    expect(await store.get('sha256/ab/cd/abcd')).toEqual(bytes);
    await expect(store.get('sha256/ff/ff/ffff')).rejects.toThrow();
  });

  it('cannot write, so a verifier can never repair what it is measuring', async () => {
    const archive = new LocalObjectArchive(await mkdtemp(join(tmpdir(), 'arkiv-')));
    const store = archiveBlobStore(archive);

    await expect(store.put(bytes)).rejects.toThrow(ArchiveConfigurationError);
    await expect(store.delete('sha256/ab/cd/abcd')).rejects.toThrow(ArchiveConfigurationError);
  });
});
