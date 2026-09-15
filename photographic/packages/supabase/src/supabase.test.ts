/**
 * The Supabase adapters, offline.
 *
 * No project and no network. Tokens are minted here with a real key pair and verified
 * through the real `jose` path, and Storage is driven through an injected `fetch` that
 * answers like the Storage API does — including the 409 that is its dedup signal.
 *
 * The assertions that matter are the refusals: a token from the wrong issuer, a token
 * for the wrong audience, an expired one, and an unverified email not being allowed to
 * adopt an existing account.
 */

import { NotFoundError } from '@photographic/core';
import type { PersonId } from '@photographic/core';
import { exportJWK, generateKeyPair, SignJWT, type JWK } from 'jose';
import { beforeAll, describe, expect, it } from 'vitest';

import {
  describeSupabase,
  looksLikeSupabase,
  supabaseConfigFromEnv,
  supabasePoolConfig,
  SupabaseAuth,
  SupabaseStorageBlobStore,
  type PersonDirectory,
  type SupabaseConfig,
} from './index.js';

const PROJECT = 'https://abcdefgh.supabase.co';

const config: SupabaseConfig = {
  url: PROJECT,
  anonKey: 'anon',
  serviceRoleKey: 'service-role',
  storageBucket: 'documents',
  jwtSecret: null,
  jwksUrl: `${PROJECT}/auth/v1/.well-known/jwks.json`,
  issuer: `${PROJECT}/auth/v1`,
  audience: 'authenticated',
};

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

describe('supabaseConfigFromEnv', () => {
  it('returns null when there is no project, which is the development path', () => {
    // A missing Supabase configuration is a normal state, not an error: the ports mean
    // the process runs against local Postgres and local disk without caring.
    expect(supabaseConfigFromEnv({})).toBeNull();
  });

  it('derives the issuer and JWKS URL from the project URL', () => {
    const resolved = supabaseConfigFromEnv({ SUPABASE_URL: `${PROJECT}/` });

    expect(resolved?.url).toBe(PROJECT);
    expect(resolved?.issuer).toBe(`${PROJECT}/auth/v1`);
    expect(resolved?.jwksUrl).toBe(`${PROJECT}/auth/v1/.well-known/jwks.json`);
    expect(resolved?.audience).toBe('authenticated');
  });

  it('refuses a plain-http project URL', () => {
    // The service role key is a root credential for the project; it does not go over
    // clear text.
    expect(() => supabaseConfigFromEnv({ SUPABASE_URL: 'http://example.supabase.co' })).toThrow(
      /https/,
    );
  });

  it('allows loopback, which is how the local Supabase CLI stack runs', () => {
    expect(supabaseConfigFromEnv({ SUPABASE_URL: 'http://127.0.0.1:54321' })?.url).toBe(
      'http://127.0.0.1:54321',
    );
  });
});

describe('describeSupabase', () => {
  it('says plainly when nothing is configured', () => {
    const readiness = describeSupabase(null);
    expect(readiness.configured).toBe(false);
    expect(readiness.storage).toBe(false);
    expect(readiness.missing.join(' ')).toContain('SUPABASE_URL');
  });

  it('reports storage and auth separately, because they are independent', () => {
    // A project can be the Postgres target with no storage credential. Collapsing these
    // into one valid/invalid flag would mean refusing to boot over a key nothing uses.
    const readiness = describeSupabase({ ...config, serviceRoleKey: null });

    expect(readiness.configured).toBe(true);
    expect(readiness.storage).toBe(false);
    expect(readiness.auth).toBe(true);
    expect(readiness.missing.join(' ')).toContain('SERVICE_ROLE');
  });
});

// ---------------------------------------------------------------------------
// Database
// ---------------------------------------------------------------------------

describe('supabasePoolConfig', () => {
  it('does not set ssl, because TLS is decided in one place and this is not it', () => {
    // It used to set it here, which is the bug: this function is only called by the app,
    // while `pnpm db:migrate` builds its own pool — and the Dockerfile runs the
    // migration at boot, so the path with no CA ran first. `resolveDatabaseTls` in
    // `@photographic/db` now answers for both.
    const plan = supabasePoolConfig({
      connectionString: 'postgres://postgres:pw@db.abcdefgh.supabase.co:5432/postgres',
    });

    expect(plan.config.ssl).toBeUndefined();
  });

  it('detects the transaction pooler and warns about migrations', () => {
    // Port 6543 is pgBouncer in transaction mode. It works under light load and then
    // fails with "prepared statement already exists" once two requests share a backend,
    // which is exactly the failure no test catches.
    const plan = supabasePoolConfig({
      connectionString: 'postgres://postgres:pw@aws-0-eu-central-1.pooler.supabase.com:6543/postgres',
    });

    expect(plan.pooled).toBe(true);
    expect(plan.notes.join(' ')).toContain('5432');
  });

  it('leaves the session pooler alone, which is why it is the one to deploy on', () => {
    // Session mode is port 5432, so it does not take the transaction-pooler branch:
    // prepared statements stay on and DDL is safe. That is what lets one DATABASE_URL
    // serve both the boot migration and the app.
    const plan = supabasePoolConfig({
      connectionString: 'postgres://postgres.abcdefgh:pw@aws-0-eu-central-1.pooler.supabase.com:5432/postgres',
    });

    expect(plan.pooled).toBe(false);
  });

  it('sets a connection timeout, because this is a network away', () => {
    const plan = supabasePoolConfig({
      connectionString: 'postgres://postgres:pw@db.abcdefgh.supabase.co:5432/postgres',
    });
    expect(plan.config.connectionTimeoutMillis).toBeGreaterThan(0);
  });
});

describe('looksLikeSupabase', () => {
  it('recognises a Supabase host and nothing else', () => {
    expect(looksLikeSupabase('postgres://x@db.abc.supabase.co:5432/postgres')).toBe(true);
    expect(looksLikeSupabase('postgres://x@aws-0.pooler.supabase.com:6543/postgres')).toBe(true);
    expect(looksLikeSupabase('postgres://photographic@127.0.0.1:5432/photographic')).toBe(false);
    expect(looksLikeSupabase('not a url')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

describe('SupabaseAuth', () => {
  let auth: SupabaseAuth;
  let sign: (claims: Record<string, unknown>, options?: { expired?: boolean }) => Promise<string>;
  let otherKeySign: (claims: Record<string, unknown>) => Promise<string>;

  beforeAll(async () => {
    const { privateKey, publicKey } = await generateKeyPair('RS256');
    const publicJwk = (await exportJWK(publicKey)) as JWK;
    publicJwk.kid = 'test-key';
    publicJwk.alg = 'RS256';

    const foreign = await generateKeyPair('RS256');

    auth = new SupabaseAuth({ config, jwks: { keys: [publicJwk] } });

    sign = (claims, options = {}) =>
      new SignJWT(claims)
        .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
        .setIssuer(config.issuer)
        .setAudience(config.audience)
        .setIssuedAt()
        .setExpirationTime(options.expired ? '-1h' : '1h')
        .sign(privateKey);

    otherKeySign = (claims) =>
      new SignJWT(claims)
        .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
        .setIssuer(config.issuer)
        .setAudience(config.audience)
        .setIssuedAt()
        .setExpirationTime('1h')
        .sign(foreign.privateKey);
  });

  it('verifies a well-formed token and returns the subject', async () => {
    const token = await sign({ sub: 'supabase-user-1', email: 'emil@example.com', email_verified: true });
    const identity = await auth.verify(token);

    expect(identity.subject).toBe('supabase-user-1');
    expect(identity.email).toBe('emil@example.com');
    expect(identity.emailVerified).toBe(true);
  });

  it('refuses a token signed by a key that is not the project’s', async () => {
    const token = await otherKeySign({ sub: 'attacker' });
    await expect(auth.verify(token)).rejects.toThrow();
  });

  it('refuses a token from another issuer', async () => {
    const token = await new SignJWT({ sub: 'x' })
      .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
      .setIssuer('https://evil.example/auth/v1')
      .setAudience(config.audience)
      .setExpirationTime('1h')
      .sign((await generateKeyPair('RS256')).privateKey);

    await expect(auth.verify(token)).rejects.toThrow();
  });

  it('refuses a token for the wrong audience', async () => {
    // A service token in the same project has a different `aud`. Skipping this check
    // would let one authenticate as a person.
    const token = await new SignJWT({ sub: 'service' })
      .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
      .setIssuer(config.issuer)
      .setAudience('service_role')
      .setExpirationTime('1h')
      .sign((await generateKeyPair('RS256')).privateKey);

    await expect(auth.verify(token)).rejects.toThrow();
  });

  it('refuses an expired token', async () => {
    const token = await sign({ sub: 'supabase-user-1' }, { expired: true });
    await expect(auth.verify(token)).rejects.toThrow();
  });

  it('refuses a token with no subject', async () => {
    const token = await sign({ email: 'nobody@example.com' });
    await expect(auth.verify(token)).rejects.toThrow();
  });

  it('refuses an empty token without calling out to anything', async () => {
    await expect(auth.verify('   ')).rejects.toThrow();
  });

  it('reads email confirmation from whichever field the project uses', async () => {
    const viaMetadata = await auth.verify(
      await sign({ sub: 'u2', email: 'a@example.com', user_metadata: { email_verified: true } }),
    );
    expect(viaMetadata.emailVerified).toBe(true);

    const viaTimestamp = await auth.verify(
      await sign({ sub: 'u3', email: 'b@example.com', email_confirmed_at: '2026-09-01T00:00:00Z' }),
    );
    expect(viaTimestamp.emailVerified).toBe(true);

    const absent = await auth.verify(await sign({ sub: 'u4', email: 'c@example.com' }));
    expect(absent.emailVerified).toBe(false);
  });
});

describe('linkPerson', () => {
  const auth = new SupabaseAuth({ config, jwks: { keys: [] } });

  function directory(seed: {
    bySubject?: Record<string, string>;
    byEmail?: Record<string, string>;
  }): PersonDirectory & { created: Array<{ subject: string; email: string | null }>; linked: string[] } {
    const bySubject = new Map(Object.entries(seed.bySubject ?? {}));
    const byEmail = new Map(Object.entries(seed.byEmail ?? {}));
    const created: Array<{ subject: string; email: string | null }> = [];
    const linked: string[] = [];

    return {
      created,
      linked,
      findBySupabaseSubject: async (subject) => (bySubject.get(subject) ?? null) as PersonId | null,
      findByEmail: async (email) => (byEmail.get(email) ?? null) as PersonId | null,
      createFromSupabase: async (input) => {
        created.push(input);
        return `person-new` as PersonId;
      },
      linkSupabaseSubject: async ({ subject }) => {
        linked.push(subject);
      },
    };
  }

  it('resolves a known subject straight to its person', async () => {
    const people = directory({ bySubject: { 'sub-1': 'person-1' } });

    const result = await auth.linkPerson(
      { subject: 'sub-1', email: 'changed@example.com', emailVerified: true, algorithm: 'RS256' },
      people,
    );

    expect(result).toEqual({ personId: 'person-1', created: false, adopted: false });
    // Never consults the email on the common path, so changing an address in Supabase
    // cannot change which Photographic account a person reaches.
    expect(people.linked).toEqual([]);
  });

  it('adopts an existing account when the email is verified', async () => {
    const people = directory({ byEmail: { 'emil@example.com': 'person-emil' } });

    const result = await auth.linkPerson(
      { subject: 'sub-new', email: 'emil@example.com', emailVerified: true, algorithm: 'RS256' },
      people,
    );

    expect(result).toEqual({ personId: 'person-emil', created: false, adopted: true });
    expect(people.linked).toEqual(['sub-new']);
  });

  it('refuses to adopt an account on an unverified email', async () => {
    // This is the account takeover: sign up in Supabase claiming someone else's
    // address, and inherit their memory. A duplicate account is recoverable; this is not.
    const people = directory({ byEmail: { 'emil@example.com': 'person-emil' } });

    const result = await auth.linkPerson(
      { subject: 'sub-attacker', email: 'emil@example.com', emailVerified: false, algorithm: 'RS256' },
      people,
    );

    expect(result.adopted).toBe(false);
    expect(result.created).toBe(true);
    expect(result.personId).not.toBe('person-emil');
    expect(people.linked).toEqual([]);
  });

  it('creates a person for a subject with no matching account', async () => {
    const people = directory({});

    const result = await auth.linkPerson(
      { subject: 'sub-fresh', email: 'ny@example.com', emailVerified: true, algorithm: 'RS256' },
      people,
    );

    expect(result.created).toBe(true);
    expect(people.created).toEqual([{ subject: 'sub-fresh', email: 'ny@example.com' }]);
  });
});

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

describe('SupabaseStorageBlobStore', () => {
  interface Call {
    method: string;
    url: string;
    headers: Record<string, string>;
  }

  function store(
    respond: (call: Call) => Response,
  ): { blobs: SupabaseStorageBlobStore; calls: Call[] } {
    const calls: Call[] = [];
    const blobs = new SupabaseStorageBlobStore({
      url: PROJECT,
      serviceRoleKey: 'service-role',
      bucket: 'documents',
      fetch: async (url, init) => {
        const call = {
          method: init?.method ?? 'GET',
          url,
          headers: (init?.headers ?? {}) as Record<string, string>,
        };
        calls.push(call);
        return respond(call);
      },
    });
    return { blobs, calls };
  }

  const bytes = new TextEncoder().encode('ett dokument');

  it('stores bytes under a content-addressed key', async () => {
    const { blobs, calls } = store(() => new Response('{}', { status: 200 }));
    const result = await blobs.put(bytes, { contentType: 'text/plain' });

    expect(result.checksum).toHaveLength(64);
    expect(result.key).toContain(result.checksum);
    expect(result.deduplicated).toBe(false);
    expect(calls[0]?.url).toBe(`${PROJECT}/storage/v1/object/documents/${result.key}`);
  });

  it('sends both the apikey and the bearer header', async () => {
    // Sending only one authenticates as anon, which fails in a way that looks like a
    // bucket permission problem.
    const { blobs, calls } = store(() => new Response('{}', { status: 200 }));
    await blobs.put(bytes);

    expect(calls[0]?.headers['apikey']).toBe('service-role');
    expect(calls[0]?.headers['authorization']).toBe('Bearer service-role');
  });

  it('never overwrites, because the key is the checksum', async () => {
    const { blobs, calls } = store(() => new Response('{}', { status: 200 }));
    await blobs.put(bytes);

    expect(calls[0]?.headers['x-upsert']).toBe('false');
  });

  it('treats a 409 as deduplication rather than as failure', async () => {
    // Content-addressed, an object that already exists has exactly these bytes, so
    // another upload getting there first *is* success.
    const { blobs } = store(() => new Response('exists', { status: 409 }));
    const result = await blobs.put(bytes);

    expect(result.deduplicated).toBe(true);
    expect(result.checksum).toHaveLength(64);
  });

  it('reads bytes back', async () => {
    const { blobs } = store(() => new Response(bytes, { status: 200 }));
    expect(await blobs.get('sha256/ab/cd/whatever')).toEqual(bytes);
  });

  it('reports a missing object as NotFoundError, in Swedish', async () => {
    const { blobs } = store(() => new Response('', { status: 404 }));

    await expect(blobs.get('sha256/ab/cd/missing')).rejects.toThrow(NotFoundError);
    await expect(blobs.get('sha256/ab/cd/missing')).rejects.toThrow(/lagringen/);
  });

  it('answers exists without transferring the body', async () => {
    const { blobs, calls } = store((call) =>
      call.url.includes('/info/') ? new Response('{}', { status: 200 }) : new Response('body'),
    );

    expect(await blobs.exists('sha256/ab/cd/x')).toBe(true);
    expect(calls[0]?.url).toContain('/storage/v1/object/info/documents/');
  });

  it('treats deleting an absent key as done', async () => {
    // The account-deletion path deletes whatever a person's rows reference, and a blob
    // already gone is the desired state rather than an error.
    const { blobs } = store(() => new Response('', { status: 404 }));
    await expect(blobs.delete('sha256/ab/cd/gone')).resolves.toBeUndefined();
  });

  it('surfaces the response body on an unexpected failure', async () => {
    const { blobs } = store(() => new Response('Bucket not found', { status: 400 }));
    await expect(blobs.put(bytes)).rejects.toThrow(/Bucket not found/);
  });

  it('signs a time-limited URL without making the bucket public', async () => {
    const { blobs, calls } = store(
      () =>
        new Response(JSON.stringify({ signedURL: '/object/sign/documents/key?token=abc' }), {
          status: 200,
        }),
    );

    const url = await blobs.signedUrl('sha256/ab/cd/x', 3600);

    // A signed URL is a capability with an expiry. A public bucket would be a permanent
    // one, handed to anyone who learns a checksum.
    expect(url).toContain('token=abc');
    expect(calls[0]?.method).toBe('POST');
    expect(calls[0]?.url).toContain('/storage/v1/object/sign/documents/');
  });

  it('errors rather than inventing a URL when signing returns none', async () => {
    const { blobs } = store(() => new Response(JSON.stringify({}), { status: 200 }));
    await expect(blobs.signedUrl('sha256/ab/cd/x', 60)).rejects.toThrow(/signerad URL/);
  });
});
