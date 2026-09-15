/**
 * The composition root.
 *
 * This is the first place in the codebase where a complete `Services` exists. Until it
 * did, the ports were a hypothesis: sixteen interfaces nobody had satisfied, which is a
 * guess about whether they *can* be satisfied coherently. Assembling them here is what
 * turns the acceptance test from a wish into something that runs, and it is where the
 * awkward seams show up — a port that needs another port, a job nobody registered, a
 * read that cannot resolve its own permissions.
 *
 * The Postgres implementation replaces the services one at a time behind these same
 * interfaces. Its definition of correct is this package's behaviour, not a paragraph of
 * prose, which is the point of writing it first.
 */

import type { PersonId, RoomId, Services } from '@photographic/core';
import type { Actor, AgentClient } from '@photographic/core';
import { FakeLlm, FakeNotify } from '@photographic/core/testing';

import { MemoryAudit } from './audit.js';
import { MemoryBundle } from './bundle.js';
import { MemoryCalendar } from './calendar.js';
import { MemoryDocuments } from './documents.js';
import { MemoryEvents } from './events.js';
import { MemoryHistory } from './history.js';
import { MemoryIdentity } from './identity.js';
import { MemoryIngest } from './ingest.js';
import { MemoryInvites } from './invites.js';
import { MemoryJobs } from './jobs.js';
import { MemoryProjection } from './projection.js';
import { MemoryRetrieval } from './retrieval.js';
import { MemoryRooms } from './rooms.js';
import { MemorySessions } from './sessions.js';
import { MemoryStore } from './store.js';
import { MemoryTrash } from './trash.js';

export * from './store.js';
export * from './identity.js';
export * from './rooms.js';
export * from './invites.js';
export * from './ingest.js';
export * from './projection.js';
export * from './bundle.js';
export * from './retrieval.js';
export * from './documents.js';
export * from './trash.js';
export * from './history.js';
export * from './events.js';
export * from './calendar.js';
export * from './sessions.js';
export * from './jobs.js';
export * from './audit.js';

export interface MemoryServicesOptions {
  /** Injected so a test can expire a thirty-day deadline without waiting thirty days. */
  clock?: () => Date;
  baseUrl?: string;
  llm?: Services['llm'];
  notify?: Services['notify'];
}

/**
 * Everything wired, with the concrete classes still reachable.
 *
 * `Services` is what adapters receive, and deliberately all they receive. The extra
 * handles here are for tests and for the jobs that need a method no port exposes, like
 * document summarisation.
 */
export interface MemoryServices {
  services: Services;
  store: MemoryStore;
  jobs: MemoryJobs;
  audit: MemoryAudit;

  /** Convenience for building an actor once a person exists. */
  actorFor(personId: PersonId, agentClient?: AgentClient, roomScope?: RoomId[]): Actor;

  /** Runs queued work to completion, including work that queued more work. */
  runJobsToCompletion(): Promise<number>;
}

/**
 * Cadence for the recurring sweeps below. Trash purging is a promise ("gone in 30 days")
 * so it runs often; invite expiry only keeps `app.invite.status` honest for the owner's
 * list -- `peek` and `accept` already refuse an overdue invite by comparing `expiresAt`
 * themselves -- so five minutes of staleness on that column costs nothing.
 */
const PURGE_TRASH_INTERVAL_MS = 60_000;
const EXPIRE_INVITES_INTERVAL_MS = 5 * 60_000;

const PURGE_TRASH_DEDUPE_KEY = 'purge_trash:recurring';
const EXPIRE_INVITES_DEDUPE_KEY = 'expire_invites:recurring';

export function createMemoryServices(options: MemoryServicesOptions = {}): MemoryServices {
  const clock = options.clock ?? (() => new Date());

  const store = new MemoryStore();
  store.now = clock;

  const llm = options.llm ?? new FakeLlm();
  const notify = options.notify ?? new FakeNotify();

  const jobs = new MemoryJobs(clock);
  const audit = new MemoryAudit(clock);

  const identity = new MemoryIdentity(store);
  const projection = new MemoryProjection(store, llm);
  // Ingest before rooms: leaving a room can take the author's own contributions with it,
  // and it does that through the ordinary trash rather than a second deletion path.
  const ingest = new MemoryIngest(store, llm, projection, jobs);
  const rooms = new MemoryRooms(store, projection, ingest);
  const invites = new MemoryInvites(store, notify, options.baseUrl);
  // Built before `bundle`: the session package's "recent" reads through it.
  const history = new MemoryHistory(store);
  const bundle = new MemoryBundle(store, projection, rooms, history);
  const retrieval = new MemoryRetrieval(store, llm);
  const documents = new MemoryDocuments(store, llm, projection, jobs);
  const trash = new MemoryTrash(store, ingest, projection);
  const events = new MemoryEvents(store);
  const calendar = new MemoryCalendar(store);
  const sessions = new MemorySessions(store);

  // Registered here rather than inside each service, so there is one list of what runs
  // in the background. A job enqueued with no handler registered is dropped, and this
  // is the only place you can notice that.
  jobs.work('rebuild_projections', async (payload) => {
    const personId = payload['personId'] as PersonId | null;
    const roomId = payload['roomId'] as RoomId | undefined;
    if (roomId) {
      await projection.buildBrief(roomId);
      // The headline rides along with the brief rather than having its own job. It is
      // the same invalidation — the room changed — and summarising it here is what keeps
      // the session-start path free of model calls.
      await projection.buildHeadline(roomId);
    }
    if (personId) await projection.buildProfile(personId);
  });

  jobs.work('summarise_document', async (payload) => {
    await documents.summarise(payload['documentId'] as never);
  });

  /**
   * `purge_trash` and `expire_invites` used to be registered here and enqueued nowhere,
   * so neither had ever run once. Both behaviours happened anyway, by other means: trash
   * purging off a raw `setInterval` in `apps/rest/src/server.ts`, and invite expiry not
   * at all in the background (only the runtime `expiresAt` check inside `peek`/`accept`,
   * which is still there and still the actual security boundary).
   *
   * The job queue is now the one mechanism for both, not a second one beside the timer:
   * it has a lease that survives a restart and a place a failure is recorded
   * (`MemoryJobs.failures`, `app.job.last_error` on Postgres), which a timer has neither
   * of. Each handler requeues its own next occurrence *before* doing the work, so a sweep
   * that throws is retried and recorded (see `MemoryJobs.runOnce`) without ending the
   * chain -- a transient failure must not silently stop future sweeps the way an
   * uncaught rejection in a `setInterval` once did.
   */
  jobs.work('purge_trash', async () => {
    await jobs.enqueue({
      kind: 'purge_trash',
      dedupeKey: PURGE_TRASH_DEDUPE_KEY,
      runAfter: new Date(clock().getTime() + PURGE_TRASH_INTERVAL_MS),
    });
    await trash.purgeExpired();
  });

  // `expired` was in the enum from the start and nothing ever wrote it, so expiry was a
  // runtime comparison and `status` did not describe reality.
  jobs.work('expire_invites', async () => {
    await jobs.enqueue({
      kind: 'expire_invites',
      dedupeKey: EXPIRE_INVITES_DEDUPE_KEY,
      runAfter: new Date(clock().getTime() + EXPIRE_INVITES_INTERVAL_MS),
    });
    await invites.expireOverdue();
  });

  // Bootstraps both chains. Enqueuing again on every boot is safe and deliberate: the
  // dedupe key means an existing pending row is simply pulled forward to run now, which
  // costs nothing because both sweeps are idempotent, and it is what makes the chain
  // self-healing if it was ever lost (a `MemoryJobs` restart always loses it, since
  // nothing here is persisted -- which is also true of every other job kind in this
  // implementation).
  //
  // `.catch` rather than `await`: this composition root is synchronous, by contract with
  // every existing caller of `createMemoryServices`, and `MemoryJobs.enqueue` has already
  // done its (synchronous, infallible) work by the time this line returns regardless. The
  // handler exists only to satisfy `no-floating-promises`, which is right to ask for one —
  // an ignored rejection here is exactly the shape of bug this file's other two timers
  // used to have.
  jobs
    .enqueue({ kind: 'purge_trash', dedupeKey: PURGE_TRASH_DEDUPE_KEY, runAfter: clock() })
    .catch(() => {});
  jobs
    .enqueue({ kind: 'expire_invites', dedupeKey: EXPIRE_INVITES_DEDUPE_KEY, runAfter: clock() })
    .catch(() => {});

  const services: Services = {
    identity,
    rooms,
    invites,
    ingest,
    projection,
    bundle,
    retrieval,
    documents,
    trash,
    history,
    events,
    calendar,
    sessions,
    llm,
    notify,
    jobs,
    audit,
  };

  return {
    services,
    store,
    jobs,
    audit,
    actorFor: (personId, agentClient = 'api', roomScope = []) => ({
      personId,
      agentClient,
      sessionId: null,
      roomScope,
    }),
    runJobsToCompletion: () => jobs.drain(),
  };
}
