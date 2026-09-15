/**
 * Which blob store the *verifier* should read, mirroring what the process would use.
 *
 * A deliberate second reading of the same environment, and worth being explicit about why,
 * since two defaults that can disagree is exactly the shape this codebase warns against.
 * `apps/rest/src/wiring.ts:resolveBlobStore` stays authoritative: it is the composition
 * root and it is what production runs. This copy exists because the restore verifier is a
 * command-line tool that must be able to read a *scratch* target — a different bucket, a
 * different project, a directory on a laptop — without booting the API, and because that
 * function is being edited on another branch right now for the boot-time refusals.
 *
 * The precedence is identical and the invariant to keep is that it stays identical: an
 * explicit S3 configuration wins, then Supabase, then local disk. If you change one, change
 * both, or the verifier will check a store the product does not use — which would make a
 * restore look proven when nothing was read.
 */

import { defaultBlobRoot } from '@photographic/db';
import type { BlobStore } from '@photographic/documents';
import { createS3BlobStore, LocalBlobStore } from '@photographic/documents';
import { supabaseConfigFromEnv, SupabaseStorageBlobStore } from '@photographic/supabase';

export interface ResolvedBlobStore {
  blobs: BlobStore;
  kind: 's3' | 'supabase' | 'local';
  /** Where it points, without credentials. Safe to print and to put in a report. */
  target: string;
}

export function resolveBlobStoreFromEnv(env: NodeJS.ProcessEnv = process.env): ResolvedBlobStore {
  const s3BaseUrl = env.BLOB_S3_BASE_URL;
  if (s3BaseUrl && env.BLOB_S3_ACCESS_KEY_ID && env.BLOB_S3_SECRET_ACCESS_KEY) {
    return {
      blobs: createS3BlobStore({
        baseUrl: s3BaseUrl,
        accessKeyId: env.BLOB_S3_ACCESS_KEY_ID,
        secretAccessKey: env.BLOB_S3_SECRET_ACCESS_KEY,
        ...(env.BLOB_S3_REGION ? { region: env.BLOB_S3_REGION } : {}),
        ...(env.BLOB_S3_PREFIX ? { prefix: env.BLOB_S3_PREFIX } : {}),
      }),
      kind: 's3',
      target: `${s3BaseUrl}${env.BLOB_S3_PREFIX ? `/${env.BLOB_S3_PREFIX}` : ''}`,
    };
  }

  const supabase = supabaseConfigFromEnv(env);
  if (supabase?.serviceRoleKey) {
    return {
      blobs: new SupabaseStorageBlobStore({
        url: supabase.url,
        serviceRoleKey: supabase.serviceRoleKey,
        bucket: supabase.storageBucket,
      }),
      kind: 'supabase',
      target: `${supabase.url}/storage/v1/object/${supabase.storageBucket}`,
    };
  }

  // `defaultBlobRoot` reads `PHOTOGRAPHIC_BLOB_ROOT` itself, which is also how a scratch
  // target is pointed somewhere else for a drill.
  const root = defaultBlobRoot();
  return { blobs: new LocalBlobStore({ root }), kind: 'local', target: root };
}
