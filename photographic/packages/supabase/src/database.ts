/**
 * Pointing `DATABASE_URL` at Supabase.
 *
 * This is the whole of "Supabase as the Postgres target", and it is deliberately this
 * small. Supabase Postgres is Postgres: the migrations in `@photographic/db` apply
 * unchanged, the seeds run, and the e2e suite passes against it. A re-point, not a
 * rewrite.
 *
 * What is left here is one thing: the transaction pooler. TLS moved out, to
 * `@photographic/db`'s `resolveDatabaseTls`, because deciding it here meant deciding it
 * only for the app — the migration runner builds its own pool and never called this, and
 * the Dockerfile runs migrations at boot. One function now answers for both.
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

  /**
   * TLS is deliberately not set here.
   *
   * It used to be, and that was the bug: the CA was composed in this function, which
   * only the app calls, while `pnpm db:migrate` built a bare pool through
   * `@photographic/db`'s `createPool` and never saw it — and the Dockerfile runs the
   * migration at boot, so the path with no CA was the first thing to run.
   *
   * `createPool` now resolves TLS for every connection from one function, so both paths
   * get the same answer. Setting `ssl` here again would put the decision back in two
   * places, which is how they drift.
   */

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
