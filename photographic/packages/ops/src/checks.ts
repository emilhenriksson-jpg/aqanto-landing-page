/**
 * The checks that need no database, and the runner that makes a failing check safe.
 *
 * Every check in this package answers exactly one question and names it in Swedish,
 * because the answer is read on a phone by the person who has to act on it.
 */

import type { Check, CheckResult } from './alert.js';
import { failing, ok } from './alert.js';

/**
 * Runs every check and turns a thrown error into a result rather than a crash.
 *
 * A probe that throws is itself a finding — a database that will not answer, a filesystem
 * that is gone — so it becomes a `failing` result under the check's own key. It is not
 * swallowed and it is not allowed to take the watchdog down with it, which is the failure
 * mode that made every previous silent failure possible.
 */
export async function runChecks(checks: Check[]): Promise<CheckResult[]> {
  return Promise.all(
    checks.map(async (check) => {
      try {
        return await check.run();
      } catch (error) {
        return {
          key: check.key,
          status: 'unknown' as const,
          severity: 'critical' as const,
          title: `Kontrollen ${check.key} kunde inte köras`,
          detail:
            'Själva mätningen misslyckades, så vi vet inte om tillståndet är friskt. ' +
            (error instanceof Error ? error.message : String(error)),
        };
      }
    }),
  );
}

// ---------------------------------------------------------------------------
// Persistence: is the memory actually being written anywhere it survives?
// ---------------------------------------------------------------------------

export interface PersistenceFacts {
  environment: 'development' | 'test' | 'production';
  /** From the composition root: which `Services` were built. */
  persistence: 'postgres' | 'memory';
  /** From the composition root: which `BlobStore` documents land in. */
  storageKind: string;
}

/**
 * The worst failure in the system, and the only one that is both silent and total.
 *
 * Without `DATABASE_URL` the process serves a complete in-memory implementation that
 * accepts every write and loses all of it on the next restart; without storage
 * credentials, document originals go to a container filesystem that empties on its own.
 * Both look identical from outside — the API answers, the web app renders, Claude
 * connects — and the deploy is green the whole time.
 *
 * A boot-time refusal is the real fix and belongs in `apps/rest`. This is the second
 * layer: if the process is somehow up in that state anyway, a person is told. It is a
 * static check on facts the composition root already computed, so it costs nothing to run
 * every pass, and running it every pass rather than once at boot means it also covers the
 * case where the refusal is relaxed for a reason someone thought was temporary.
 */
export function persistenceCheck(facts: PersistenceFacts): Check {
  return {
    key: 'persistence_fallback',
    run: async () => {
      const inMemory = facts.persistence !== 'postgres';
      const localDisk = facts.storageKind === 'local';
      const fields = {
        environment: facts.environment,
        persistence: facts.persistence,
        storage: facts.storageKind,
      };

      if (facts.environment !== 'production' || (!inMemory && !localDisk)) {
        return ok({
          key: 'persistence_fallback',
          severity: 'critical',
          title: 'Minnet skrivs till Postgres och Storage',
          fields,
        });
      }

      const what = inMemory && localDisk ? 'databasen och lagringen' : inMemory ? 'databasen' : 'lagringen';
      return failing({
        key: 'persistence_fallback',
        severity: 'critical',
        title: `Produktionen kör utan ${what} — minnet försvinner vid omstart`,
        detail:
          'Processen föll tillbaka på reservimplementationen. Allt som sparas nu är borta ' +
          'vid nästa omstart. Kontrollera DATABASE_URL respektive SUPABASE_URL/' +
          'SUPABASE_SERVICE_ROLE_KEY som Fly-secrets och deploya om.',
        fields,
      });
    },
  };
}

// ---------------------------------------------------------------------------
// Delivery: are the codes and invitations we claim to send actually going out?
// ---------------------------------------------------------------------------

export interface DeliveryFailureLogOptions {
  now?: () => Date;
  /** Ring buffer size. Only the count inside the window matters, so this stays small. */
  capacity?: number;
}

/**
 * Counts failed deliveries in a rolling window.
 *
 * In-process on purpose: a delivery failure is an event in this process, and the
 * alternative — a table — would mean a write on the path of a person trying to log in.
 * The window is what makes it useful: one 46elks timeout is weather, four in fifteen
 * minutes means nobody can sign in and nobody knows.
 */
export class DeliveryFailureLog {
  private readonly failures: Array<{ at: Date; channel: string }> = [];
  private readonly now: () => Date;
  private readonly capacity: number;

  constructor(options: DeliveryFailureLogOptions = {}) {
    this.now = options.now ?? (() => new Date());
    this.capacity = options.capacity ?? 100;
  }

  record(channel: string): void {
    this.failures.push({ at: this.now(), channel });
    if (this.failures.length > this.capacity) this.failures.shift();
  }

  countSince(windowMs: number): number {
    const cutoff = this.now().getTime() - windowMs;
    return this.failures.filter((failure) => failure.at.getTime() >= cutoff).length;
  }
}

/** Structurally `CodeSender` from `@photographic/connect`, without the dependency. */
export interface CodeSenderLike {
  send(input: { channel: 'email' | 'sms'; destination: string; code: string }): Promise<void>;
}

/**
 * Wraps the sign-up code sender so a failure is counted on its way past.
 *
 * A wrapper rather than a change inside `@photographic/delivery`, for the same reason
 * `recordingGrants` wraps the token store in `wiring.ts`: `send` throwing *is* the moment
 * a delivery failed, it happens exactly once per failure, and there is no other way to
 * reach it. The error is re-thrown untouched — the sign-up flow still decides what the
 * person sees, and it already gets that right by discarding the attempt rather than
 * burning the hourly allowance.
 */
export function countingCodeSender<T extends CodeSenderLike>(
  sender: T,
  log: DeliveryFailureLog,
): CodeSenderLike {
  return {
    send: async (input) => {
      try {
        await sender.send(input);
      } catch (error) {
        log.record(input.channel);
        throw error;
      }
    },
  };
}

export interface DeliveryCheckOptions {
  log: DeliveryFailureLog;
  /** Failures inside the window before this counts as broken. Default 3. */
  threshold?: number;
  /** Default 15 minutes. */
  windowMs?: number;
}

export function deliveryCheck(options: DeliveryCheckOptions): Check {
  const threshold = options.threshold ?? 3;
  const windowMs = options.windowMs ?? 15 * 60 * 1000;

  return {
    key: 'delivery_failures',
    run: async () => {
      const count = options.log.countSince(windowMs);
      const fields = { failures: count, windowMinutes: Math.round(windowMs / 60_000), threshold };

      if (count < threshold) {
        return ok({
          key: 'delivery_failures',
          severity: 'warning',
          title: 'Utskicken går fram',
          fields,
        });
      }

      return failing({
        key: 'delivery_failures',
        severity: 'critical',
        title: `${count} misslyckade utskick på ${fields.windowMinutes} minuter`,
        detail:
          'Ingen kan logga in medan detta pågår, eftersom SMS-koden är enda vägen in. ' +
          'Kontrollera 46elks-saldot och ELKS_API_USERNAME/ELKS_API_PASSWORD.',
        fields,
      });
    },
  };
}
