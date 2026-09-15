/**
 * The composition root for the Postgres implementation.
 *
 * Mirrors `createMemoryServices` deliberately: same shape, same defaults (`FakeLlm`,
 * `FakeNotify`), same job registrations. The reference implementation is what defines
 * correct behaviour here, so the two composition roots being readable side by side is
 * the point.
 */

import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Actor, AgentClient, PersonId, RoomId, Services } from '@photographic/core';
import { FakeLlm, FakeNotify } from '@photographic/core/testing';
import type { BlobStore, StorageLedger } from '@photographic/documents';
import { LocalBlobStore } from '@photographic/documents';
import type { Pool } from 'pg';

import { PgStorageLedger } from './services/storage-ledger.js';

/**
 * Where files land when nobody said.
 *
 * `PHOTOGRAPHIC_BLOB_ROOT` if set, otherwise a fixed path under the temp directory —
 * fixed rather than random so two processes on one machine, and a restart of the same
 * one, still find the files a previous run wrote.
 */
export function defaultBlobRoot(): string {
  return process.env.PHOTOGRAPHIC_BLOB_ROOT ?? join(tmpdir(), 'photographic-blobs');
}

import { PgAudit } from './services/audit.js';
import { PgBundle } from './services/bundle.js';
import { PgCalendar } from './services/calendar.js';
import { PgDocuments } from './services/documents.js';
import { PgEvents } from './services/events.js';
import { PgHistory } from './services/history.js';
import { PgIdentity } from './services/identity.js';
import { PgIngest } from './services/ingest.js';
import { PgInvites } from './services/invites.js';
import { PgJobs } from './services/jobs.js';
import { PgProjection } from './services/projection.js';
import { PgRetrieval } from './services/retrieval.js';
import { PgRooms } from './services/rooms.js';
import { PgSessions } from './services/sessions.js';
import { PgTrash } from './services/trash.js';
import { toVectorLiteral } from './vector.js';

export interface PostgresServicesOptions {
  pool: Pool;
  llm?: Services['llm'];
  notify?: Services['notify'];
  baseUrl?: string;
  /** Injected so a test can move time without waiting for it. Threaded into the parts
   * of the write path that compute a date in JS rather than in SQL (`now()` already
   * does the job everywhere else). */
  clock?: () => Date;

  /**
   * Where uploaded files go.
   *
   * Defaults to a temporary local directory, which is right for tests and for a laptop
   * and wrong for anything else — a process restart on a container loses the files
   * while the rows still reference them. A deployment passes `LocalBlobStore` on a
   * volume, `S3BlobStore` for R2, or Supabase Storage from `@photographic/supabase`.
   *
   * This is the seam the portability promise rests on: nothing below it names a
   * storage provider, so replacing one does not reach the memory model.
   */
  blobs?: BlobStore;

  /**
   * Per-person storage accounting. Defaults to `PgStorageLedger`, which counts against
   * `STORAGE_LIMIT_BYTES`. Injectable mainly so a test can set a small limit.
   */
  storage?: StorageLedger;
}

export interface PostgresServices {
  services: Services;
  audit: PgAudit;
  jobs: PgJobs;

  /** Convenience for building an actor once a person exists, mirroring `MemoryServices`. */
  actorFor(personId: PersonId, agentClient?: AgentClient, roomScope?: RoomId[]): Actor;

  /** Runs queued work to completion, including work that queued more work. */
  runJobsToCompletion(): Promise<number>;

  /** Releases the pool. Idempotent-ish: safe to call once at teardown. */
  close(): Promise<void>;
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

export async function createPostgresServices(
  options: PostgresServicesOptions,
): Promise<PostgresServices> {
  const { pool } = options;
  const clock = options.clock ?? (() => new Date());

  const llm = options.llm ?? new FakeLlm();
  const notify = options.notify ?? new FakeNotify();

  const jobs = new PgJobs(pool);
  const audit = new PgAudit(pool);

  const identity = new PgIdentity(pool);
  const projection = new PgProjection(pool, llm);
  // Ingest before rooms: leaving a room can take the author's own contributions with it,
  // and it does that through the ordinary trash rather than a second deletion path.
  const ingest = new PgIngest(pool, llm, projection, jobs, clock);
  const rooms = new PgRooms(pool, projection, ingest);
  const invites = new PgInvites(pool, notify, options.baseUrl);
  // Built before `bundle`: the session package's "recent" reads through it.
  const history = new PgHistory(pool);
  const bundle = new PgBundle(projection, rooms, history);
  const retrieval = new PgRetrieval(pool, llm);
  const blobs = options.blobs ?? new LocalBlobStore({ root: defaultBlobRoot() });
  const storage = options.storage ?? new PgStorageLedger(pool);
  const documents = new PgDocuments(pool, llm, projection, jobs, blobs, storage);
  const trash = new PgTrash(pool, ingest, projection);
  const events = new PgEvents(pool);
  const calendar = new PgCalendar(pool);
  const sessions = new PgSessions(pool);

  // Registered here rather than inside each service, exactly as `createMemoryServices`
  // does -- so there is one list of what runs in the background, and a job enqueued
  // with no handler registered is something you can notice.
  jobs.work('rebuild_projections', async (payload) => {
    const personId = payload['personId'] as PersonId | null;
    const roomId = payload['roomId'] as RoomId | undefined;
    if (roomId) {
      await projection.buildBrief(roomId);
      await projection.buildHeadline(roomId);
    }
    if (personId) await projection.buildProfile(personId);
  });

  jobs.work('summarise_document', async (payload) => {
    await documents.summarise(payload['documentId'] as never);
  });

  /**
   * The write-side half of the ranking arm in `PgRetrieval` that finds a genuine
   * paraphrase. Deferred here rather than awaited inline in `PgIngest` so a slow or
   * failing embedding call can never be the reason a memory fails to save -- see the
   * comment on `PgIngest.queueEmbedding`. Left `active` only: a memory deleted before
   * this ran has nothing worth spending an API call embedding, and `PgIngest` never
   * re-queues on restore because the embedding from before the delete is still valid.
   *
   * A thrown error here (an API outage, a missing key) propagates to `PgJobs.runOnce`,
   * which is exactly what makes this "backfillable" rather than "best-effort and
   * silently skipped": the job is retried, up to `max_attempts`, rather than the
   * memory being permanently unsearchable by meaning.
   */
  jobs.work('embed_item', async (payload) => {
    const itemId = payload['itemId'] as string | undefined;
    if (!itemId) return;

    const row = await pool.query<{ body: string; status: string }>(
      `SELECT body, status FROM app.item WHERE id = $1`,
      [itemId],
    );
    const item = row.rows[0];
    if (!item || item.status !== 'active') return;

    const [vector] = await llm.embed([item.body]);
    if (!vector) return;

    await pool.query(`UPDATE app.item SET embedding = $1::vector WHERE id = $2`, [
      toVectorLiteral(vector),
      itemId,
    ]);
  });

  /**
   * `purge_trash` and `expire_invites` used to be registered here and enqueued nowhere,
   * so neither had ever run once. Both behaviours happened anyway, by other means: trash
   * purging off a raw `setInterval` in `apps/rest/src/server.ts`, and invite expiry not
   * at all in the background (only the runtime `expiresAt` check inside `peek`/`accept`,
   * which is still there and still the actual security boundary).
   *
   * The job queue is now the one mechanism for both, not a second one beside the timer:
   * `app.job` gives it a lease that survives a restart (`FOR UPDATE SKIP LOCKED`) and a
   * durable place a failure is recorded (`last_error`, `failed_at`), which a timer has
   * neither of. Each handler requeues its own next occurrence *before* doing the work, so
   * a sweep that throws is retried and recorded (see `PgJobs.runOnce`) without ending the
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
  // dedupe key means an existing pending row (`job_dedupe_idx`) is simply pulled forward
  // to run now rather than duplicated, which costs nothing because both sweeps are
  // idempotent, and it is what makes the chain self-healing if the row was ever lost --
  // including surviving the restart that a `setInterval` cannot.
  await jobs.enqueue({ kind: 'purge_trash', dedupeKey: PURGE_TRASH_DEDUPE_KEY, runAfter: clock() });
  await jobs.enqueue({
    kind: 'expire_invites',
    dedupeKey: EXPIRE_INVITES_DEDUPE_KEY,
    runAfter: clock(),
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
    audit,
    jobs,
    actorFor: (personId, agentClient = 'api', roomScope = []) => ({
      personId,
      agentClient,
      sessionId: null,
      roomScope,
    }),
    runJobsToCompletion: () => jobs.drain(),
    close: () => pool.end(),
  };
}
