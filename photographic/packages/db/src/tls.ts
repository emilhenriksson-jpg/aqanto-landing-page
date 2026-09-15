/**
 * How a Postgres connection gets its TLS, decided in one place.
 *
 * It used to be decided in two, which is the bug this file exists to remove. The app
 * composed `ssl: { ca }` in `supabasePoolConfig`; the migration runner built a bare
 * `new Pool({ connectionString })` and never looked at the CA at all — and the Dockerfile
 * runs the migration at boot, so the one path with no CA was the first thing to run.
 * Against Supabase that fails the container before it serves anything.
 *
 * Two `pg` behaviours make the obvious fixes wrong, both measured against the live
 * project rather than assumed:
 *
 *   - `?sslmode=require` is an alias for `verify-full` in `pg`/`pg-connection-string`,
 *     not libpq's encrypt-but-don't-verify. The library says so in a deprecation warning.
 *     Against Supabase's private root that is a hard failure, and the message —
 *     "self-signed certificate in certificate chain" — reads like a client mistake rather
 *     than a policy choice.
 *   - An `sslmode` in the URL **overrides** an explicit `ssl` option, silently discarding
 *     the CA. So `ssl: { ca }` next to `?sslmode=require` does nothing, which is exactly
 *     the combination Supabase's own docs lead you to.
 *
 * And the trap that makes a careless fix worse than the bug: with no `sslmode` and no
 * `ssl` option, `pg` connects in **plaintext**, and Supabase's pooler accepts it. A fix
 * that merely stopped erroring could quietly hand a database of people's private memory
 * an unauthenticated, unencrypted connection. So the rule here is that a remote host
 * either gets verified TLS or gets an error. Never plaintext, never unverified.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { ConnectionOptions } from 'node:tls';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * `Supabase Root 2021 CA`, shipped with the package.
 *
 * A public root certificate, not a secret — bundling one is what every runtime does with
 * its trust store. Shipped so the default deploy is verified with no extra configuration,
 * because the alternative is a required secret that, when forgotten, fails the first boot.
 *
 * Provenance, because a CA obtained from the server it authenticates would be circular:
 * fetched from `supabase-downloads.s3.amazonaws.com` over a publicly-trusted certificate,
 * and its fingerprint compared against the root presented by
 * `aws-0-eu-central-1.pooler.supabase.com:5432`. The two matched. `tls.test.ts` pins the
 * fingerprint, so replacing this file with a different certificate fails a test rather
 * than silently changing who we trust.
 */
export const BUNDLED_CA_PATH = join(__dirname, '..', 'certs', 'supabase-prod-ca-2021.crt');

/** sha256 of the bundled root. Pinned in a test; see `BUNDLED_CA_PATH`. */
export const SUPABASE_ROOT_CA_SHA256 =
  '80:70:25:AD:50:D4:ED:21:9D:2C:9C:7D:29:9C:00:4F:82:4E:B0:0C:F7:F6:5A:FE:F6:07:D0:7B:72:E6:CA:FA';

export type Env = Record<string, string | undefined>;

/** Where the CA came from, for the boot log. */
export type CaSource = 'env-inline' | 'env-file' | 'bundled' | 'url-sslmode' | 'none';

export interface DatabaseTls {
  /**
   * What to pass as `ssl`. `undefined` means "do not set it" — either the URL's own
   * `sslmode` is in charge, or the host is loopback and TLS is not wanted.
   */
  ssl: ConnectionOptions | false | undefined;
  source: CaSource;
  /** Worth logging at boot: this is the setting that fails under load, not at startup. */
  notes: string[];
}

export class DatabaseTlsError extends Error {}

/**
 * Modes that mean "encrypt but do not authenticate", plus the ones that mean "maybe".
 *
 * Refused for a remote host. Encryption without authentication stops passive reading of
 * the wire and does nothing about an active attacker in front of the database, and for
 * this database that is the wrong trade even as a stopgap — there is a real CA available
 * for the price of nothing, since it ships with this package.
 */
const UNVERIFIED_MODES = new Set(['no-verify', 'disable', 'allow', 'prefer']);

/** Modes where `pg` reads the CA from the URL itself and this module steps aside. */
const URL_MANAGED_MODES = new Set(['verify-full', 'verify-ca']);

export function isLoopbackHost(hostname: string): boolean {
  return (
    hostname === 'localhost' ||
    hostname === '127.0.0.1' ||
    hostname === '::1' ||
    hostname === '[::1]' ||
    hostname.endsWith('.localhost')
  );
}

function hostOf(connectionString: string): { hostname: string; sslmode: string | null } {
  try {
    const url = new URL(connectionString);
    return {
      hostname: url.hostname,
      sslmode: url.searchParams.get('sslmode'),
    };
  } catch {
    // A connection string `pg` can parse but `URL` cannot (a socket path, say). Treated
    // as local: refusing to start over an unparseable URL would be worse than letting
    // `pg` report what is actually wrong with it.
    return { hostname: 'localhost', sslmode: null };
  }
}

function readCa(env: Env): { ca: string; source: CaSource } | null {
  const inline = env.SUPABASE_CA_CERT ?? env.DATABASE_CA_CERT;
  if (inline && inline.includes('BEGIN CERTIFICATE')) {
    return { ca: inline, source: 'env-inline' };
  }
  if (inline) {
    // Set but not a PEM — almost always a path, or a value mangled by a shell. Named
    // explicitly, because "self-signed certificate in certificate chain" is what this
    // looks like otherwise and it points nowhere near the real mistake.
    throw new DatabaseTlsError(
      'SUPABASE_CA_CERT är satt men innehåller inget certifikat. Den ska innehålla ' +
        'hela PEM-blocket (-----BEGIN CERTIFICATE----- …). För en filväg, använd ' +
        'SUPABASE_CA_CERT_FILE i stället.',
    );
  }

  const path = env.SUPABASE_CA_CERT_FILE ?? env.DATABASE_CA_CERT_FILE;
  if (path) {
    try {
      return { ca: readFileSync(path, 'utf8'), source: 'env-file' };
    } catch (error) {
      throw new DatabaseTlsError(
        `Kunde inte läsa CA-certifikatet på ${path}: ` +
          (error instanceof Error ? error.message : String(error)),
      );
    }
  }

  try {
    return { ca: readFileSync(BUNDLED_CA_PATH, 'utf8'), source: 'bundled' };
  } catch {
    return null;
  }
}

/**
 * Decides the TLS options for a connection string.
 *
 * Called by `createPool`, so both the migration runner and the app get the same answer
 * from the same code. Throws rather than degrading: every failure mode here is either a
 * configuration mistake with a fix, or a request to connect to a remote database without
 * authenticating it.
 */
export function resolveDatabaseTls(input: {
  connectionString: string;
  env?: Env;
}): DatabaseTls {
  const env = input.env ?? process.env;
  const { hostname, sslmode } = hostOf(input.connectionString);
  const notes: string[] = [];

  // Local development: a Postgres on the same machine over a loopback interface. There
  // is no network to intercept, and requiring TLS here would mean every contributor
  // configuring certificates to run the test suite.
  if (isLoopbackHost(hostname)) {
    if (sslmode && sslmode !== 'disable') {
      notes.push(`sslmode=${sslmode} ignoreras för en loopback-anslutning.`);
    }
    return { ssl: false, source: 'none', notes };
  }

  if (sslmode) {
    const mode = sslmode.toLowerCase();

    if (URL_MANAGED_MODES.has(mode)) {
      // `pg` reads `sslrootcert` from the URL itself in these modes. Stepping aside is
      // correct — and setting `ssl` anyway would be discarded, which is the trap.
      notes.push(
        `sslmode=${mode} i DATABASE_URL styr TLS. CA:t läses ur sslrootcert, inte ur ` +
          'SUPABASE_CA_CERT.',
      );
      return { ssl: undefined, source: 'url-sslmode', notes };
    }

    if (UNVERIFIED_MODES.has(mode)) {
      throw new DatabaseTlsError(
        `sslmode=${mode} i DATABASE_URL ger en anslutning som inte autentiserar ` +
          'databasen. Ta bort sslmode ur URL:en – då används det medföljande ' +
          'CA-certifikatet och anslutningen blir verifierad.',
      );
    }

    if (mode === 'require') {
      // The one that wastes an afternoon. `pg` treats `require` as `verify-full` against
      // the system trust store, which cannot contain Supabase's private root — and the
      // presence of `sslmode` means an explicit `ssl: { ca }` is thrown away, so the
      // obvious fix does nothing.
      throw new DatabaseTlsError(
        'sslmode=require fungerar inte mot Supabase med den här drivrutinen: pg ' +
          'behandlar "require" som "verify-full" mot systemets rotcertifikat, och ett ' +
          'sslmode i URL:en gör att ett uttryckligt CA ignoreras. Ta bort ' +
          '"?sslmode=require" ur DATABASE_URL – TLS slås på ändå, med det medföljande ' +
          'CA-certifikatet, och blir verifierad.',
      );
    }

    throw new DatabaseTlsError(`Okänt sslmode i DATABASE_URL: ${sslmode}`);
  }

  const ca = readCa(env);
  if (!ca) {
    // Never the silent alternative. Without an `ssl` option `pg` would connect in
    // plaintext and Supabase's pooler would accept it, so falling through here would
    // turn a loud boot failure into an unencrypted connection nobody notices.
    throw new DatabaseTlsError(
      `Ingen TLS-konfiguration för ${hostname}. Anslutningen skulle bli okrypterad, ` +
        'vilket inte är acceptabelt för den här databasen. Sätt SUPABASE_CA_CERT ' +
        '(hela PEM-blocket) eller SUPABASE_CA_CERT_FILE (en filväg).',
    );
  }

  if (ca.source === 'bundled') {
    notes.push('TLS verifieras mot det medföljande Supabase-rotcertifikatet.');
  } else {
    notes.push(`TLS verifieras mot CA:t från ${ca.source === 'env-inline' ? 'SUPABASE_CA_CERT' : 'SUPABASE_CA_CERT_FILE'}.`);
  }

  return {
    ssl: {
      ca: ca.ca,
      // Stated rather than left to the default. This is the whole point of the file, and
      // a future edit that flipped it should have to delete something explicit.
      rejectUnauthorized: true,
    },
    source: ca.source,
    notes,
  };
}
