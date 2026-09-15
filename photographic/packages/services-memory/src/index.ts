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

  jobs.work('purge_trash', async () => {
    await trash.purgeExpired();
  });

  // `expired` was in the enum from the start and nothing ever wrote it, so expiry was a
  // runtime comparison and `status` did not describe reality.
  jobs.work('expire_invites', async () => {
    await invites.expireOverdue();
  });

  jobs.work('purge_documents', async () => {
    await documents.purgeExpired();
  });

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
