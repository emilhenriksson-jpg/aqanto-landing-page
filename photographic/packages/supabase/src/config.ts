/**
 * Supabase configuration, read once and reported honestly.
 *
 * The shape of this file follows from a decision in the build plan: Supabase is
 * Postgres, Auth and Storage, and **not** the authorization engine. Room permissions
 * stay in the API layer — one place, testable, portable — so nothing here asks Supabase
 * a permission question, and no row-level security policy is installed. That is also
 * what makes "the platform can be swapped later" an honest claim rather than a slogan.
 *
 * Everything is optional. A missing Supabase configuration is a normal state, not an
 * error: development runs against local Postgres and local disk, and the whole point of
 * the ports is that the process does not care which. So `describeSupabase` returns what
 * is present and what is missing, and the caller decides whether that is a problem.
 * Guessing at a URL or falling back to a hosted project nobody named would be far worse
 * than saying plainly that it is not configured.
 */

export interface SupabaseConfig {
  /** Project URL, e.g. `https://abcdefgh.supabase.co`. No trailing slash. */
  url: string;

  /**
   * The publishable key. Safe in a browser, and deliberately never used by this
   * process for anything: it carries no more authority than an anonymous caller, so a
   * server holding it can do nothing useful with it. Kept only so the API can hand it
   * to the web app rather than the web app hardcoding it.
   */
  anonKey: string | null;

  /**
   * The service role key. Bypasses every policy, so it is a root credential for the
   * project and must never leave this process or reach a log line.
   *
   * Required for Storage, because Photographic uploads on a person's behalf after
   * deciding for itself whether they may write to the room. Handing Supabase a user
   * token and letting it decide would be exactly the RLS duplication the build plan
   * rules out.
   */
  serviceRoleKey: string | null;

  /** Bucket for document originals. Private; nothing here ever makes a public URL. */
  storageBucket: string;

  /**
   * The legacy shared JWT secret, for projects still issuing HS256 tokens.
   *
   * Null on a project using asymmetric keys, which is the current default and the
   * better one: verification then needs only the public JWKS, so this process never
   * holds a credential that could *mint* a token for any user in the project.
   */
  jwtSecret: string | null;

  /** Where to fetch signing keys for asymmetric (RS256/ES256) verification. */
  jwksUrl: string;

  /** Expected `iss` on a Supabase-issued access token. */
  issuer: string;

  /**
   * Expected `aud`. Supabase uses `authenticated` for a signed-in user.
   *
   * Checked rather than ignored: a token minted for a different audience in the same
   * project — a service token, say — must not authenticate a person.
   */
  audience: string;
}

export type Env = Record<string, string | undefined>;

export const DEFAULT_STORAGE_BUCKET = 'documents';
const DEFAULT_AUDIENCE = 'authenticated';

/**
 * Builds the config from the environment, or returns null when there is no project.
 *
 * `SUPABASE_URL` alone decides. Without it there is nothing to configure and the
 * process uses local Postgres and local disk, which is the intended development path.
 */
export function supabaseConfigFromEnv(env: Env = process.env): SupabaseConfig | null {
  const url = normaliseUrl(env.SUPABASE_URL);
  if (!url) return null;

  return {
    url,
    anonKey: env.SUPABASE_ANON_KEY ?? env.SUPABASE_PUBLISHABLE_KEY ?? null,
    serviceRoleKey: env.SUPABASE_SERVICE_ROLE_KEY ?? null,
    storageBucket: env.SUPABASE_STORAGE_BUCKET ?? DEFAULT_STORAGE_BUCKET,
    jwtSecret: env.SUPABASE_JWT_SECRET ?? null,
    jwksUrl: env.SUPABASE_JWKS_URL ?? `${url}/auth/v1/.well-known/jwks.json`,
    issuer: env.SUPABASE_JWT_ISSUER ?? `${url}/auth/v1`,
    audience: env.SUPABASE_JWT_AUDIENCE ?? DEFAULT_AUDIENCE,
  };
}

export interface SupabaseReadiness {
  configured: boolean;
  /** True when documents can be stored in Supabase Storage. */
  storage: boolean;
  /** True when a Supabase access token can be verified. */
  auth: boolean;
  /** What is missing, in Swedish, for an operator reading a boot log. */
  missing: string[];
}

/**
 * What this configuration can and cannot do.
 *
 * Split by capability rather than as one valid/invalid flag, because the capabilities
 * are genuinely independent: a project can be the Postgres target with no Storage
 * credential, and `DATABASE_URL` pointing at Supabase needs none of these at all.
 * Collapsing them would mean refusing to boot over a key that nothing was going to use.
 */
export function describeSupabase(config: SupabaseConfig | null): SupabaseReadiness {
  if (!config) {
    return {
      configured: false,
      storage: false,
      auth: false,
      missing: ['SUPABASE_URL är inte satt – kör mot lokal Postgres och lokal disk.'],
    };
  }

  const missing: string[] = [];

  const storage = config.serviceRoleKey !== null;
  if (!storage) {
    missing.push(
      'SUPABASE_SERVICE_ROLE_KEY saknas – dokument kan inte lagras i Supabase Storage.',
    );
  }

  // Either mechanism is enough. Asymmetric is preferred and needs no secret here.
  const auth = true;
  if (!config.jwtSecret) {
    missing.push(
      'SUPABASE_JWT_SECRET saknas – tokens verifieras mot projektets publika JWKS ' +
        '(vilket är det normala för nya projekt).',
    );
  }

  return { configured: true, storage, auth, missing };
}

function normaliseUrl(value: string | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim().replace(/\/+$/, '');
  if (trimmed === '') return null;

  try {
    const parsed = new URL(trimmed);
    // Plain http would put a service role key on the wire in clear text. Loopback is
    // allowed because that is how the local Supabase CLI stack runs.
    if (parsed.protocol !== 'https:' && !isLoopback(parsed.hostname)) {
      throw new Error(`SUPABASE_URL måste vara https: ${trimmed}`);
    }
    return trimmed;
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('SUPABASE_URL')) throw error;
    throw new Error(`SUPABASE_URL är inte en giltig URL: ${value}`);
  }
}

function isLoopback(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';
}
