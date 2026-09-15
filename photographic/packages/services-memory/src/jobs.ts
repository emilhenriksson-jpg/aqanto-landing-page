/**
 * Background work.
 *
 * Everything expensive happens here rather than on the request: rebuilding the profile,
 * summarising a document, purging the trash. The reason is voice. A spoken session
 * cannot wait for a profile to be packed, and the moment a rebuild sits on the write
 * path, saving a fact mid-conversation becomes something the person can hear.
 *
 * `runOnce` drains the queue and returns how many ran, which is what makes the
 * acceptance test able to say "and then the background work happened" without sleeping.
 */

import type { JobPort } from '@photographic/core';

interface QueuedJob {
  kind: string;
  payload: Record<string, unknown>;
  dedupeKey: string | null;
  runAfter: Date;
}

/** The dedupe key a recurring job reuses, so there is one row per kind and not a pile. */
export function recurringKey(kind: string): string {
  return `recurring:${kind}`;
}

export class MemoryJobs implements JobPort {
  private queue: QueuedJob[] = [];
  private readonly handlers = new Map<
    string,
    (payload: Record<string, unknown>) => Promise<void>
  >();

  /** Surfaced so a test can assert a handler failed rather than silently doing nothing. */
  readonly failures: Array<{ kind: string; error: unknown }> = [];

  constructor(private readonly now: () => Date = () => new Date()) {}

  async enqueue(input: {
    kind: string;
    payload?: Record<string, unknown>;
    dedupeKey?: string;
    runAfter?: Date;
  }): Promise<void> {
    const dedupeKey = input.dedupeKey ?? null;

    // Ten saves in one conversation should produce one profile rebuild, not ten. The
    // newest payload wins, because a rebuild is idempotent and the latest request is
    // the one with the most complete picture.
    if (dedupeKey) {
      const existing = this.queue.findIndex((j) => j.dedupeKey === dedupeKey);
      if (existing >= 0) {
        this.queue[existing] = {
          kind: input.kind,
          payload: input.payload ?? {},
          dedupeKey,
          runAfter: input.runAfter ?? this.now(),
        };
        return;
      }
    }

    this.queue.push({
      kind: input.kind,
      payload: input.payload ?? {},
      dedupeKey,
      runAfter: input.runAfter ?? this.now(),
    });
  }

  work(kind: string, handler: (payload: Record<string, unknown>) => Promise<void>): void {
    this.handlers.set(kind, handler);
  }

  /**
   * Schedules work that has to keep happening, rather than work someone asked for.
   *
   * The `PgJobs` equivalent of this exists because `purge_trash` and `expire_invites` had
   * a handler registered and nothing that ever enqueued it: the handler existed, so the
   * feature read as built, and invites simply never expired. This is the same fix for the
   * in-memory root. Each recurring job re-enqueues itself for its next run (see
   * `runOnce`), and this seeds the first one — one entry per kind, because the dedupe key
   * is the kind.
   */
  async scheduleRecurring(definitions: Array<{ kind: string; everySeconds: number }>): Promise<void> {
    for (const definition of definitions) {
      await this.enqueue({
        kind: definition.kind,
        dedupeKey: recurringKey(definition.kind),
        runAfter: new Date(this.now().getTime() + definition.everySeconds * 1000),
        payload: { recurring: definition.everySeconds },
      });
    }
  }

  /**
   * Runs everything currently due, once.
   *
   * A job with no handler is dropped rather than retried forever: in this
   * implementation an unhandled kind means the composition root forgot to register it,
   * and a queue that silently grows is a worse symptom than one that loses the job.
   */
  async runOnce(): Promise<number> {
    const now = this.now();
    const due = this.queue.filter((j) => j.runAfter <= now);
    this.queue = this.queue.filter((j) => j.runAfter > now);

    let ran = 0;
    for (const job of due) {
      const handler = this.handlers.get(job.kind);
      if (!handler) continue;
      try {
        await handler(job.payload);
        ran += 1;
        // Recurrence lives here rather than in each handler, mirroring `PgJobs.runOnce`,
        // so a maintenance job cannot be the one that forgot to schedule its next run.
        const every = job.payload['recurring'];
        if (typeof every === 'number' && every > 0) {
          await this.enqueue({
            kind: job.kind,
            dedupeKey: recurringKey(job.kind),
            runAfter: new Date(this.now().getTime() + every * 1000),
            payload: { recurring: every },
          });
        }
      } catch (error) {
        this.failures.push({ kind: job.kind, error });
      }
    }
    return ran;
  }

  /**
   * Drains the queue including work that other work enqueues.
   *
   * A profile rebuild can queue a bundle refresh, so one pass is not enough to reach a
   * settled state. The cap turns a handler that re-enqueues itself into a loud failure
   * instead of a hang.
   */
  async drain(maxPasses = 20): Promise<number> {
    let total = 0;
    for (let pass = 0; pass < maxPasses; pass += 1) {
      const ran = await this.runOnce();
      total += ran;
      if (ran === 0) return total;
    }
    throw new Error('Jobbkön tog inte slut; ett jobb köar troligen sig själv.');
  }

  get depth(): number {
    return this.queue.length;
  }
}
