/**
 * Supabase, kept in one package on purpose.
 *
 * Every line of Supabase-specific code in the product is here. That is not tidiness —
 * it is the thing that makes the build plan's promise checkable: if the platform can be
 * swapped later, then there is a finite, visible set of files to replace, and someone
 * can read them in an afternoon.
 *
 * Three capabilities, each behind an interface that already existed:
 *
 *   - **Postgres.** `supabasePoolConfig` turns a Supabase connection string into a `pg`
 *     config. That is all. The migrations, seeds and both e2e suites are unchanged; a
 *     re-point rather than a rewrite.
 *   - **Storage.** `SupabaseStorageBlobStore` implements `BlobStore` from
 *     `@photographic/documents`, alongside the local and S3 implementations. The memory
 *     model never learns which one is installed.
 *   - **Auth.** `SupabaseAuth` verifies a Supabase access token and maps the subject to
 *     a `PersonId`. Identity only.
 *
 * What is deliberately not here: any authorization. No row-level security policy, no
 * permission question asked of Supabase, nothing that reads a room membership out of a
 * token's claims. Room permissions stay in the API layer, which is one place, testable,
 * and portable — build-plan decision 4.
 */

export {
  DEFAULT_STORAGE_BUCKET,
  describeSupabase,
  supabaseConfigFromEnv,
  type Env,
  type SupabaseConfig,
  type SupabaseReadiness,
} from './config.js';

export {
  SupabaseStorageBlobStore,
  type FetchLike,
  type SupabaseStorageOptions,
} from './storage.js';

export {
  SUPABASE_CREDENTIAL_PROVIDER,
  SupabaseAuth,
  type PersonDirectory,
  type SupabaseAuthOptions,
  type SupabaseIdentity,
} from './auth.js';

export {
  POOLED_QUERY_HINT,
  looksLikeSupabase,
  supabasePoolConfig,
  type SupabasePoolOptions,
  type SupabasePoolPlan,
} from './database.js';
