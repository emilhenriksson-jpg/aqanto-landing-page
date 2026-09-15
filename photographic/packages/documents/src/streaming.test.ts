/**
 * Uploads that stream, and reads that arrive in pieces.
 *
 * The export is why these exist: an archive of the ten gigabytes a person is allowed to
 * store cannot go through `put`, which takes bytes, on a machine with two gigabytes. What
 * is worth testing is not that the interface exists but the two properties the export
 * depends on — that nothing is held, and that a failed upload leaves nothing behind.
 *
 * The S3 side is checked against a fake signer rather than a bucket. That is enough to
 * catch what actually goes wrong in a multipart upload: the request sequence, the part
 * boundary, the ETags going back in order, and the abort on the failure path.
 */

import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { NotFoundError } from '@photographic/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  LocalBlobStore,
  MULTIPART_PART_BYTES,
  S3BlobStore,
  exportKeyFor,
  type SignedFetcher,
} from './blob-store.js';

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'photographic-streaming-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const utf8 = (text: string) => new TextEncoder().encode(text);

describe('the local store', () => {
  it('streams an upload to its key and reports what it wrote', async () => {
    const store = new LocalBlobStore({ root });
    const upload = await store.createUpload({ key: exportKeyFor('export-1') });

    await upload.write(utf8('PK\u0003\u0004'));
    await upload.write(utf8('resten av arkivet'));
    const stored = await upload.complete();

    expect(stored.key).toBe('exports/export-1.zip');
    expect(stored.byteSize).toBe(21);
    expect(stored.checksum).toMatch(/^[0-9a-f]{64}$/);
    expect(new TextDecoder().decode(await store.get(stored.key))).toBe('PK\u0003\u0004resten av arkivet');
  });

  it('leaves nothing behind when an upload is abandoned', async () => {
    // The export's failure path. A truncated archive under a key a download link points at
    // would be worse than no archive at all.
    const store = new LocalBlobStore({ root });
    const key = exportKeyFor('export-2');
    const upload = await store.createUpload({ key });

    await upload.write(utf8('halva arkivet'));
    await upload.abort();

    expect(await store.exists(key)).toBe(false);
    // Not even the temporary file, which would otherwise fill a Fly machine's disk one
    // failed export at a time.
    await expect(stat(join(root, 'exports'))).resolves.toBeTruthy();
    const left = await readFile(join(root, 'exports', 'export-2.zip')).catch(() => null);
    expect(left).toBeNull();
  });

  it('hands a stored object back in pieces, and says so when there is none', async () => {
    const store = new LocalBlobStore({ root });
    const stored = await store.put(utf8('ett dokument'));

    let read = '';
    for await (const chunk of store.getStream(stored.key)) {
      read += new TextDecoder().decode(chunk);
    }
    expect(read).toBe('ett dokument');

    // The same `NotFoundError` `get` gives, and raised on the first read rather than
    // silently yielding nothing — the export decides whether to note a missing file on it.
    await expect(async () => {
      for await (const _chunk of store.getStream('sha256/finns-inte')) void _chunk;
    }).rejects.toThrow(NotFoundError);
  });
});

describe('the S3 store', () => {
  interface Call {
    url: string;
    method: string;
    bodyBytes: number;
  }

  function fakeS3(options: { failPart?: number } = {}): {
    client: SignedFetcher;
    calls: Call[];
  } {
    const calls: Call[] = [];

    const client: SignedFetcher = {
      fetch: async (url, init) => {
        const method = init?.method ?? 'GET';
        const body = init?.body;
        const bodyBytes =
          body instanceof Uint8Array
            ? body.byteLength
            : typeof body === 'string'
              ? body.length
              : 0;
        calls.push({ url, method, bodyBytes });

        if (method === 'POST' && url.includes('uploads')) {
          return new Response(
            '<InitiateMultipartUploadResult><UploadId>upload-42</UploadId></InitiateMultipartUploadResult>',
            { status: 200 },
          );
        }
        if (method === 'PUT' && url.includes('partNumber')) {
          const number = Number(/partNumber=(\d+)/.exec(url)?.[1] ?? 0);
          if (options.failPart === number) return new Response('nope', { status: 500 });
          return new Response('', { status: 200, headers: { etag: `"etag-${number}"` } });
        }
        if (method === 'POST' && url.includes('uploadId')) {
          return new Response('<CompleteMultipartUploadResult></CompleteMultipartUploadResult>', {
            status: 200,
          });
        }
        if (method === 'DELETE') return new Response('', { status: 204 });
        return new Response('', { status: 200 });
      },
    };

    return { client, calls };
  }

  const store = (client: SignedFetcher) =>
    new S3BlobStore({ baseUrl: 'https://s3.example.com/photographic', client });

  it('sends a part as soon as one has filled, and holds nothing else', async () => {
    // The memory bound is this: one part in hand. An implementation that waited for
    // `complete` would be the buffering it replaced, with extra steps.
    const { client, calls } = fakeS3();
    const upload = await store(client).createUpload({
      key: exportKeyFor('export-3'),
      contentType: 'application/zip',
    });

    const chunk = new Uint8Array(1024 * 1024);
    for (let written = 0; written < MULTIPART_PART_BYTES * 2; written += chunk.byteLength) {
      await upload.write(chunk);
    }

    const partsSoFar = calls.filter((call) => call.url.includes('partNumber'));
    expect(partsSoFar).toHaveLength(2);
    expect(partsSoFar[0]?.bodyBytes).toBe(MULTIPART_PART_BYTES);

    const stored = await upload.complete();
    expect(stored.byteSize).toBe(MULTIPART_PART_BYTES * 2);

    const complete = calls.at(-1);
    expect(complete?.method).toBe('POST');
    expect(complete?.url).toContain('uploadId=upload-42');
  });

  it('completes with the parts in order, each with the ETag S3 gave it', async () => {
    // Out of order or with an ETag dropped, S3 either refuses or assembles the archive
    // wrongly — and a wrongly assembled zip reads as corrupt to the person, not to us.
    const bodies: string[] = [];
    const { client } = fakeS3();
    const recording: SignedFetcher = {
      fetch: async (url, init) => {
        if (typeof init?.body === 'string') bodies.push(init.body);
        return client.fetch(url, init);
      },
    };

    const upload = await store(recording).createUpload({ key: exportKeyFor('export-4') });
    const chunk = new Uint8Array(MULTIPART_PART_BYTES);
    await upload.write(chunk);
    await upload.write(chunk);
    await upload.write(new Uint8Array(16));
    await upload.complete();

    const xml = bodies.find((body) => body.includes('CompleteMultipartUpload'));
    expect(xml).toContain('<PartNumber>1</PartNumber><ETag>"etag-1"</ETag>');
    expect(xml).toContain('<PartNumber>2</PartNumber><ETag>"etag-2"</ETag>');
    expect(xml).toContain('<PartNumber>3</PartNumber><ETag>"etag-3"</ETag>');
    expect(xml!.indexOf('etag-1')).toBeLessThan(xml!.indexOf('etag-2'));
  });

  it('aborts the upload when the caller gives up, so the parts are not billed for ever', async () => {
    const { client, calls } = fakeS3();
    const upload = await store(client).createUpload({ key: exportKeyFor('export-5') });

    await upload.write(new Uint8Array(1024));
    await upload.abort();

    const aborted = calls.at(-1);
    expect(aborted?.method).toBe('DELETE');
    expect(aborted?.url).toContain('uploadId=upload-42');
  });

  it('fails the write that a part upload failed on, rather than at the end', async () => {
    // The export's error message should name the part that failed while the build can still
    // be abandoned, not after another nine gigabytes have gone out.
    const { client } = fakeS3({ failPart: 1 });
    const upload = await store(client).createUpload({ key: exportKeyFor('export-6') });

    await expect(upload.write(new Uint8Array(MULTIPART_PART_BYTES))).rejects.toThrow(
      /PUT part 1/,
    );
  });
});
