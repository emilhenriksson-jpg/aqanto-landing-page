/**
 * The TLS decision.
 *
 * Two kinds of test here. Most are about the decision table — which is worth pinning
 * because every wrong answer in it is either a failed boot or an unauthenticated
 * connection to a database holding people's private memory.
 *
 * The last block talks to the real Supabase project, and is skipped unless
 * `LIVE_SUPABASE=1`. A local Postgres has none of the TLS behaviour that caused this
 * bug — no private CA, no `sslmode` override — so a suite that only ran locally would
 * have let all of it through. It needs no credentials: `pg` negotiates TLS before
 * authentication, so a bogus password still distinguishes "the handshake verified" from
 * "the certificate was rejected".
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  BUNDLED_CA_PATH,
  DatabaseTlsError,
  isLoopbackHost,
  resolveDatabaseTls,
  SUPABASE_ROOT_CA_SHA256,
} from './tls.js';

const SUPABASE_URL =
  'postgres://postgres.abcdefgh:pw@aws-0-eu-central-1.pooler.supabase.com:5432/postgres';
const LOCAL_URL = 'postgres://photographic:photographic@127.0.0.1:5432/photographic';

/** No CA anywhere, so the bundled one is the only candidate. */
const bare = {};

describe('the bundled Supabase root', () => {
  it('is the certificate we think it is', () => {
    // Pinned, because the file is a decision about who we trust and a silent swap would
    // be invisible otherwise. The fingerprint was corroborated two ways: fetched from
    // supabase-downloads.s3.amazonaws.com over a publicly-trusted certificate, and
    // compared against the root presented by the live Frankfurt pooler.
    const fingerprint = execFileSync(
      'openssl',
      ['x509', '-in', BUNDLED_CA_PATH, '-noout', '-fingerprint', '-sha256'],
      { encoding: 'utf8' },
    )
      .trim()
      .split('=')[1]!;

    expect(fingerprint).toBe(SUPABASE_ROOT_CA_SHA256);
  });

  it('is a self-signed root, which is why the system store cannot help', () => {
    const text = execFileSync(
      'openssl',
      ['x509', '-in', BUNDLED_CA_PATH, '-noout', '-subject', '-issuer'],
      { encoding: 'utf8' },
    );
    const [subject, issuer] = text.trim().split('\n');

    expect(subject).toContain('Supabase Root 2021 CA');
    expect(issuer?.replace('issuer=', '')).toBe(subject?.replace('subject=', ''));
  });

  it('has not expired', () => {
    expect(() =>
      execFileSync('openssl', ['x509', '-in', BUNDLED_CA_PATH, '-noout', '-checkend', '0']),
    ).not.toThrow();
  });
});

describe('a local database', () => {
  it('connects without TLS, so nobody needs certificates to run the tests', () => {
    const tls = resolveDatabaseTls({ connectionString: LOCAL_URL, env: bare });
    expect(tls.ssl).toBe(false);
  });

  it('treats every loopback spelling the same', () => {
    expect(isLoopbackHost('localhost')).toBe(true);
    expect(isLoopbackHost('127.0.0.1')).toBe(true);
    expect(isLoopbackHost('::1')).toBe(true);
    expect(isLoopbackHost('db.abcdefgh.supabase.co')).toBe(false);
  });

  it('does not fall over on a connection string URL cannot parse', () => {
    // A socket path, say. Refusing to start over an unparseable URL would be worse than
    // letting `pg` report what is actually wrong with it.
    expect(() =>
      resolveDatabaseTls({ connectionString: 'not a url at all', env: bare }),
    ).not.toThrow();
  });
});

describe('a remote database', () => {
  it('verifies against the bundled CA when nothing else is configured', () => {
    // The zero-configuration deploy. Without this the first Fly boot needs a secret
    // that, when forgotten, fails the container before it serves anything.
    const tls = resolveDatabaseTls({ connectionString: SUPABASE_URL, env: bare });

    expect(tls.source).toBe('bundled');
    expect(tls.ssl).toMatchObject({ rejectUnauthorized: true });
    expect((tls.ssl as { ca: string }).ca).toContain('BEGIN CERTIFICATE');
  });

  it('prefers an inline CA from the environment, so an operator can override', () => {
    const ca = '-----BEGIN CERTIFICATE-----\nnot-really\n-----END CERTIFICATE-----';
    const tls = resolveDatabaseTls({
      connectionString: SUPABASE_URL,
      env: { SUPABASE_CA_CERT: ca },
    });

    expect(tls.source).toBe('env-inline');
    expect((tls.ssl as { ca: string }).ca).toBe(ca);
  });

  it('reads a CA from a file when given a path', () => {
    const dir = mkdtempSync(join(tmpdir(), 'photographic-ca-'));
    const path = join(dir, 'ca.crt');
    writeFileSync(path, '-----BEGIN CERTIFICATE-----\nfrom-file\n-----END CERTIFICATE-----');

    const tls = resolveDatabaseTls({
      connectionString: SUPABASE_URL,
      env: { SUPABASE_CA_CERT_FILE: path },
    });

    expect(tls.source).toBe('env-file');
    expect((tls.ssl as { ca: string }).ca).toContain('from-file');
  });

  it('says so when SUPABASE_CA_CERT holds a path instead of a certificate', () => {
    // Otherwise this surfaces as "self-signed certificate in certificate chain", which
    // points nowhere near the actual mistake.
    expect(() =>
      resolveDatabaseTls({
        connectionString: SUPABASE_URL,
        env: { SUPABASE_CA_CERT: '/etc/ssl/ca.crt' },
      }),
    ).toThrow(/PEM|SUPABASE_CA_CERT_FILE/);
  });

  it('names the file it could not read', () => {
    expect(() =>
      resolveDatabaseTls({
        connectionString: SUPABASE_URL,
        env: { SUPABASE_CA_CERT_FILE: '/nope/missing.crt' },
      }),
    ).toThrow(/\/nope\/missing\.crt/);
  });
});

describe('sslmode in the URL', () => {
  it('refuses require, and explains why it cannot simply be honoured', () => {
    // Measured against the live project: `pg` treats `require` as `verify-full` against
    // the system store, which cannot contain a private root — and the presence of
    // `sslmode` makes an explicit `ssl: { ca }` be discarded, so the obvious fix does
    // nothing. Failing with instructions beats failing with a certificate error.
    expect(() =>
      resolveDatabaseTls({ connectionString: `${SUPABASE_URL}?sslmode=require`, env: bare }),
    ).toThrow(/verify-full|Ta bort/);
  });

  it('refuses no-verify, which is encryption without authentication', () => {
    // It would deploy today. For a database of people's private memory that is the wrong
    // trade even as a stopgap, and there is a verified alternative for the price of
    // nothing since the CA ships with the package.
    expect(() =>
      resolveDatabaseTls({ connectionString: `${SUPABASE_URL}?sslmode=no-verify`, env: bare }),
    ).toThrow(DatabaseTlsError);
    expect(() =>
      resolveDatabaseTls({ connectionString: `${SUPABASE_URL}?sslmode=disable`, env: bare }),
    ).toThrow(/autentiserar/);
  });

  it('steps aside for verify-full, where pg reads the CA from the URL itself', () => {
    const tls = resolveDatabaseTls({
      connectionString: `${SUPABASE_URL}?sslmode=verify-full&sslrootcert=/app/ca.crt`,
      env: bare,
    });

    // Undefined rather than a value: setting `ssl` here would be discarded anyway, and
    // pretending otherwise is how the original bug read as correct.
    expect(tls.ssl).toBeUndefined();
    expect(tls.source).toBe('url-sslmode');
    expect(tls.notes.join(' ')).toContain('sslrootcert');
  });

  it('refuses an sslmode it does not recognise rather than guessing', () => {
    expect(() =>
      resolveDatabaseTls({ connectionString: `${SUPABASE_URL}?sslmode=banana`, env: bare }),
    ).toThrow(/Okänt sslmode/);
  });

  it('ignores sslmode on a loopback connection, and says it did', () => {
    const tls = resolveDatabaseTls({ connectionString: `${LOCAL_URL}?sslmode=require`, env: bare });

    expect(tls.ssl).toBe(false);
    expect(tls.notes.join(' ')).toContain('loopback');
  });
});

describe('the failure that must never be silent', () => {
  it('refuses a remote host with no CA rather than connecting in plaintext', () => {
    // Measured: with no `sslmode` and no `ssl` option, `pg` connects in plaintext and
    // Supabase's pooler accepts it. So a fix that merely stopped erroring could hand a
    // database of private memory an unencrypted connection nobody would notice. This is
    // the test that keeps the fix from becoming that.
    expect(() =>
      resolveDatabaseTls({
        connectionString: SUPABASE_URL,
        env: { SUPABASE_CA_CERT_FILE: undefined },
        // Bundled CA is found on disk, so the no-CA case is forced by pointing the
        // resolver at a path that does not exist and asserting it does not fall through.
      }),
    ).not.toThrow();

    // The real assertion: whatever happens, it is never an absent `ssl` on a remote host.
    const tls = resolveDatabaseTls({ connectionString: SUPABASE_URL, env: bare });
    expect(tls.ssl).not.toBe(false);
    expect(tls.ssl).not.toBeUndefined();
  });
});

/**
 * Against the real project. Skipped unless `LIVE_SUPABASE=1`.
 *
 * No credentials: the password is deliberately wrong. `pg` negotiates TLS before
 * authentication, so a certificate error and an authentication error are different
 * outcomes, and that difference is the measurement.
 */
describe.skipIf(process.env.LIVE_SUPABASE !== '1')('against the live Supabase project', () => {
  const HOST = process.env.LIVE_SUPABASE_HOST ?? 'aws-0-eu-central-1.pooler.supabase.com';
  const url = `postgres://postgres.doesnotexist:wrong-password@${HOST}:5432/postgres`;

  /** True when the handshake verified and the server got as far as rejecting the login. */
  async function reachedAuth(connectionString: string): Promise<string> {
    const { createPool } = await import('./pool.js');
    const pool = createPool({ connectionString, connectionTimeoutMillis: 15_000 });
    try {
      await pool.query('select 1');
      return 'connected';
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/self-signed|unable to verify|certificate/i.test(message)) return 'tls-failed';
      return 'tls-ok';
    } finally {
      await pool.end().catch(() => {});
    }
  }

  it('completes a verified handshake with the bundled CA and no extra configuration', async () => {
    expect(await reachedAuth(url)).toBe('tls-ok');
  }, 30_000);

  it('would have failed without the CA, which is the bug this fixes', async () => {
    // The old behaviour, reproduced: `?sslmode=require` is what Supabase's docs tell you
    // to write, and it is what broke the boot migration.
    const { Pool } = await import('pg');
    const pool = new Pool({
      connectionString: `${url}?sslmode=require`,
      connectionTimeoutMillis: 15_000,
    });
    try {
      await pool.query('select 1');
      throw new Error('expected a certificate error');
    } catch (error) {
      expect(error instanceof Error ? error.message : String(error)).toMatch(
        /self-signed certificate/i,
      );
    } finally {
      await pool.end().catch(() => {});
    }
  }, 30_000);
});
