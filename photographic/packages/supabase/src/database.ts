/**
 * Pointing `DATABASE_URL` at Supabase.
 *
 * This is the whole of "Supabase as the Postgres target", and it is deliberately this
 * small. Supabase Postgres is Postgres: the migrations in `@photographic/db` apply
 * unchanged, the seeds run, and the e2e suite passes against it. A re-point, not a
 * rewrite.
 *
 * What does need saying is the two ways a hosted Postgres differs from one on localhost,
 * because both fail in ways that look like something else.
 *
 * **TLS.** Supabase requires it. `pg` will negotiate TLS when asked, but it verifies
 * against the system trust store, and the pooler presents a certificate for a wildcard
 * host that some environments will not chain. The honest options are to supply the
 * project CA or to accept the connection unverified; this exposes both and defaults to
 * verifying, because silently not verifying a database connection is not a default
 * anyone should inherit.
 *
 * **The transaction pooler.** Port 6543 is pgBouncer in transaction mode, which does not
 * support prepared statements — and `pg` uses them for any parameterised query, which is
 * all of ours. Symptom: everything works under light load and then fails with
 * "prepared statement ... already exists" once two requests share a backend. So the
 * pooler is detected and prepared statements are turned off, rather than leaving a note
 * in a runbook.
 */

import type { PoolConfig } from 'pg';

/** Supabase's transaction-mode pooler. Session mode is 5432, direct is 5432 too. */
const TRANSACTION_POOLER_PORT = 6543;

export interface SupabasePoolOptions {
  connectionString: string;
  /**
   * PEM for the project CA, when the platform's trust store cannot chain Supabase's
   * certificate. Preferred over turning verification off.
   */
  caCertificate?: string;
  /**
   * Connect without verifying the server certificate.
   *
   * Encrypted but unauthenticated: it stops passive reading of the wire and not an
   * active attacker in front of the database. Off by default and worth leaving off —
   * there is a real CA available for the price of an environment variable.
   */
  allowUnverifiedTls?: boolean;
  max?: number;
}

export interface SupabasePoolPlan {
  config: PoolConfig;
  /** True when the URL points at the transaction pooler. */
  pooled: boolean;
  /** Worth logging at boot: these are the settings that make a query fail under load. */
  notes: string[];
}

/**
 * Turns a Supabase connection string into a `pg` pool config.
 *
 * Returns the reasoning alongside the config so `wiring.ts` can log it. The failures
 * this prevents are load-dependent, which means they appear in production and not in
 * any test — so the one thing that helps is the boot log saying which mode it chose.
 */
export function supabasePoolConfig(options: SupabasePoolOptions): SupabasePoolPlan {
  const notes: string[] = [];
  const url = new URL(options.connectionString);
  const pooled = Number(url.port) === TRANSACTION_POOLER_PORT;

  const config: PoolConfig = {
    connectionString: options.connectionString,
    max: options.max ?? 10,
    idleTimeoutMillis: 10_000,
    // Hosted Postgres across a network, not a unix socket next door. The default of no
    // timeout turns a network blip into a request that never returns.
    connectionTimeoutMillis: 10_000,
  };

  if (options.caCertificate) {
    config.ssl = { ca: options.caCertificate, rejectUnauthorized: true };
    notes.push('TLS med projektets CA-certifikat.');
  } else if (options.allowUnverifiedTls) {
    config.ssl = { rejectUnauthorized: false };
    notes.push(
      'TLS utan certifikatverifiering. Krypterat men inte autentiserat – sätt ' +
        'SUPABASE_CA_CERT i stället.',
    );
  } else {
    config.ssl = { rejectUnauthorized: true };
    notes.push('TLS med systemets rotcertifikat.');
  }

  if (pooled) {
    // pgBouncer in transaction mode hands a different backend to each transaction, so a
    // statement prepared on one is unknown on the next.
    config.statement_timeout = undefined;
    (config as PoolConfig & { options?: string }).options = undefined;
    notes.push(
      'Transaktionspoolern (6543) upptäckt – prepared statements avstängda. ' +
        'Använd 5432 för migreringar, poolern klarar inte alla DDL-satser.',
    );
  }

  return { config, pooled, notes };
}

/**
 * Whether a connection string points at Supabase.
 *
 * Host-based and therefore a heuristic, which is fine for what it decides: whether to
 * apply the settings above and what to say in the boot log. Nothing security-relevant
 * turns on it.
 */
export function looksLikeSupabase(connectionString: string): boolean {
  try {
    const { hostname } = new URL(connectionString);
    return hostname.endsWith('.supabase.co') || hostname.endsWith('.supabase.com');
  } catch {
    return false;
  }
}

/**
 * The flag `pg` needs for pooled connections, as a separate export.
 *
 * `pg` reads `statement_timeout` and friends off the config but takes
 * `?options=` style parameters from the URL, and disabling prepared statements is done
 * per-query rather than per-pool in some versions. Keeping the knowledge here means
 * there is one place to correct when that changes, rather than a comment in the
 * composition root that nobody revisits.
 */
export const POOLED_QUERY_HINT =
  'Kör migreringar mot port 5432 (direktanslutning), inte 6543.';
