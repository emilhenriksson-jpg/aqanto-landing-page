/**
 * Permanent deletion of an account.
 *
 * Two paths, both of which Emil confirmed and both of which are offered: thirty days of
 * freeze, or immediately. They differ only in when the sweep runs — everything else,
 * including revoking every token the moment the request is made, is identical. That is
 * what makes the freeze cost nothing in privacy: during it the account is already
 * unreachable by any connected AI, and the window buys only the chance to change one's
 * mind.
 *
 * What the sweep does to shared rooms is the part worth reading carefully, because it is
 * where a promise made in the first viewport has to be kept. The invite consent says
 * *det du skriver i ett delat rum blir en del av rummet och stannar där även om du
 * senare lämnar det.* So contributions stay by default, attributed to a tombstone. A
 * deletion that stripped them would contradict a promise the product made before the
 * person wrote anything — and would silently change what the other members remember,
 * which is the thing section 1.3 of the trust spec exists to prevent.
 *
 * The honesty that buys is not free, and it is paid at deletion time: the person is told
 * plainly (`DELETION_SHARED_ROOM_NOTICE`) that their contributions stay under
 * "Borttagen användare", and offered `remove` as an active choice. The choice is
 * mandatory — `contributions` is NOT NULL with no default — so a deletion cannot be
 * recorded without it having been made.
 *
 * And it is pseudonymisation, not anonymisation. The person row survives as a tombstone
 * because `app.event.actor_person_id` and `app.room.created_by` reference it without
 * cascade and the log refuses DELETE; someone who remembers who wrote a note can still
 * re-identify it. Saying otherwise would be a promise the data model cannot keep.
 */

import {
  DELETION_FREEZE_DAYS,
  NotPermittedError,
  ValidationError,
  type Actor,
  type PersonId,
  type RoomId,
} from '@photographic/core';
import type { BlobStore } from '@photographic/documents';
import type { Pool } from 'pg';

import { execute, queryOne, queryRows, withTransaction } from '../pool.js';
import { ITEM_COLUMNS, mapItem, type ItemRow } from '../rows.js';
import { appendEvent } from './events.js';
import { softDeleteWithin } from './lifecycle.js';

export type ContributionChoice = 'keep' | 'remove';

/**
 * Shown in the other members' trash and in their room history.
 *
 * Says both halves — that an account was deleted and that removing the contributions was a
 * choice the person made — because an owner deciding whether to restore something needs to
 * know it was not an accident.
 */
export const CONTRIBUTIONS_REMOVED_REASON =
  'Kontot raderades och personen valde att ta bort sina bidrag.';

/**
 * How long one sweep's claim on a deletion stays current.
 *
 * Long enough that a slow run — hundreds of contributions, a sluggish object store — is
 * never overtaken by the next timer tick, and short enough that a machine that died
 * mid-deletion does not leave a person half-deleted until somebody investigates. It is a
 * lease rather than a lock so that recovery needs no human.
 */
export const DELETION_LEASE = '15 minutes';

export interface DeletionRequest {
  id: string;
  personId: PersonId;
  status: 'requested' | 'cancelled' | 'completed';
  immediate: boolean;
  contributions: ContributionChoice;
  requestedAt: Date;
  executeAfter: Date;
  cancelledAt: Date | null;
  completedAt: Date | null;
  removed: Record<string, unknown>;
}

interface DeletionRow {
  id: string;
  person_id: string;
  status: DeletionRequest['status'];
  immediate: boolean;
  contributions: ContributionChoice;
  requested_at: Date;
  execute_after: Date;
  cancelled_at: Date | null;
  completed_at: Date | null;
  removed: Record<string, unknown>;
  /** Which steps of the sweep have already run, and what each of them removed. */
  progress: Record<string, unknown> | null;
  claimed_at: Date | null;
}

const COLUMNS = `id, person_id, status, immediate, contributions, requested_at, execute_after,
                 cancelled_at, completed_at, removed, progress, claimed_at`;

function toRequest(row: DeletionRow): DeletionRequest {
  return {
    id: row.id,
    personId: row.person_id as PersonId,
    status: row.status,
    immediate: row.immediate,
    contributions: row.contributions,
    requestedAt: row.requested_at,
    executeAfter: row.execute_after,
    cancelledAt: row.cancelled_at,
    completedAt: row.completed_at,
    removed: row.removed ?? {},
  };
}

export class PgAccounts {
  constructor(
    private readonly pool: Pool,
    private readonly blobs: BlobStore,
  ) {}

  /**
   * Records a deletion request and cuts off access in the same transaction.
   *
   * Token revocation is not deferred to the sweep. "Kontot slutar vara nåbart direkt"
   * is what the copy promises, and it is what makes both paths defensible: on the
   * immediate path there is no window at all, and on the frozen path the window is
   * thirty days during which the data is already unreachable.
   */
  async requestDeletion(
    actor: Actor,
    input: { immediate: boolean; contributions: ContributionChoice },
  ): Promise<{ request: DeletionRequest; tokensRevoked: number }> {
    // Not a default. The consent text says this choice is never preselected, and a
    // caller that omitted it would be choosing on the person's behalf about other
    // people's memory.
    if (input.contributions !== 'keep' && input.contributions !== 'remove') {
      throw new ValidationError(
        'Välj vad som ska hända med dina bidrag i delade rum: "keep" eller "remove".',
      );
    }

    return withTransaction(this.pool, async (tx) => {
      const existing = await queryOne<DeletionRow>(
        tx,
        `SELECT ${COLUMNS} FROM app.account_deletion
         WHERE person_id = $1 AND status = 'requested'`,
        [actor.personId],
      );

      // A second "delete my account" while one is pending is the same request, not a
      // new one. Two rows would mean two sweeps.
      if (existing) {
        return { request: toRequest(existing), tokensRevoked: 0 };
      }

      const row = await queryOne<DeletionRow>(
        tx,
        `INSERT INTO app.account_deletion (person_id, immediate, contributions, execute_after)
         VALUES ($1, $2, $3, CASE WHEN $2 THEN now() ELSE now() + ($4 || ' days')::interval END)
         RETURNING ${COLUMNS}`,
        [actor.personId, input.immediate, input.contributions, DELETION_FREEZE_DAYS],
      );

      const revoked = await queryOne<{ revoke_all_tokens: number }>(
        tx,
        `SELECT app.revoke_all_tokens($1)`,
        [actor.personId],
      );

      // Written to the personal room: it is a fact about this account, and the personal
      // room is where this person's own history lives.
      const personal = await queryOne<{ id: string }>(
        tx,
        `SELECT id FROM app.room WHERE created_by = $1 AND kind = 'personal'`,
        [actor.personId],
      );
      if (personal) {
        await appendEvent(tx, {
          roomId: personal.id as RoomId,
          eventType: 'account.deletion_requested',
          payload: {
            immediate: input.immediate,
            contributions: input.contributions,
            execute_after: row!.execute_after.toISOString(),
          },
          actorPersonId: actor.personId,
          agentClient: actor.agentClient,
        });
      }

      return {
        request: toRequest(row!),
        tokensRevoked: Number(revoked?.revoke_all_tokens ?? 0),
      };
    });
  }

  /** The open request, if any. What the freeze banner reads. */
  async pendingDeletion(personId: PersonId): Promise<DeletionRequest | null> {
    const row = await queryOne<DeletionRow>(
      this.pool,
      `SELECT ${COLUMNS} FROM app.account_deletion
       WHERE person_id = $1 AND status = 'requested'`,
      [personId],
    );
    return row ? toRequest(row) : null;
  }

  /**
   * Changes one's mind, which is the only thing the freeze is for.
   *
   * Tokens are not un-revoked: the connected AIs have to be reconnected deliberately.
   * A client silently regaining access to a memory the person had decided to delete is
   * the wrong default even when they changed their mind.
   */
  async cancelDeletion(actor: Actor): Promise<DeletionRequest | null> {
    const row = await queryOne<DeletionRow>(
      this.pool,
      `UPDATE app.account_deletion
       SET status = 'cancelled', cancelled_at = now()
       WHERE person_id = $1 AND status = 'requested'
       RETURNING ${COLUMNS}`,
      [actor.personId],
    );
    if (!row) return null;

    const personal = await queryOne<{ id: string }>(
      this.pool,
      `SELECT id FROM app.room WHERE created_by = $1 AND kind = 'personal'`,
      [actor.personId],
    );
    if (personal) {
      await appendEvent(this.pool, {
        roomId: personal.id as RoomId,
        eventType: 'account.deletion_cancelled',
        payload: {},
        actorPersonId: actor.personId,
        agentClient: actor.agentClient,
      });
    }

    return toRequest(row);
  }

  /** Requests whose freeze has run out. Called by the sweep, never from a request. */
  async dueDeletions(limit = 20): Promise<DeletionRequest[]> {
    const rows = await queryRows<DeletionRow>(
      this.pool,
      `SELECT ${COLUMNS} FROM app.account_deletion
       WHERE status = 'requested' AND execute_after <= now()
       ORDER BY execute_after
       LIMIT $1`,
      [limit],
    );
    return rows.map(toRequest);
  }

  /**
   * Carries out a deletion, as resumable steps rather than one long hopeful sequence.
   *
   * Order is load-bearing. Files go before the rows that name them, because a row
   * deleted first is a blob nobody can find again — the storage is content-addressed,
   * so the only index into it is the `storage_key` about to be dropped. Shared-room
   * contributions are handled before the tombstone, because removing them needs the
   * person to still be attributable.
   *
   * What is new is that the order is *recoverable*. This used to be a dozen statements and
   * two sets of blob deletions in a row with no record of how far it had got, so a crash in
   * the middle left a half-deleted person and nothing able to work out what had already
   * happened — the next timer run would redo the blobs, redo the counts, and could not tell
   * whether the personal room had been erased. Now:
   *
   * - **A lease, not a flag.** `claimed_at` is taken conditionally in SQL, so two sweeps
   *   cannot run one deletion, and a sweep that died releases it by the lease expiring
   *   rather than by anyone noticing.
   * - **A step is named and recorded.** Each step checks `progress` and skips itself if it
   *   already ran. The SQL steps record their own completion in the same transaction as
   *   their work, so a step is either done and marked or neither.
   * - **Blob steps are at-least-once, deliberately.** `BlobStore.delete` is idempotent in
   *   every implementation, so re-running one is a no-op; making it exactly-once would need
   *   a two-phase commit against object storage to buy nothing.
   *
   * `progress` accumulates the counts as it goes and becomes `removed` at the end, so a
   * deletion that took three attempts still reports one honest account of what it removed.
   */
  async executeDeletion(deletionId: string): Promise<DeletionRequest | null> {
    const request = await this.claim(deletionId);
    if (!request) return null;

    const personId = request.person_id as PersonId;
    const progress: Record<string, unknown> = { ...(request.progress ?? {}) };
    const done = (step: string): boolean => progress[`step:${step}`] === true;

    /** Records a step's outcome and its completion together. */
    const complete = async (step: string, counts: Record<string, unknown> = {}): Promise<void> => {
      Object.assign(progress, counts, { [`step:${step}`]: true });
      await execute(
        this.pool,
        `UPDATE app.account_deletion SET progress = $2::jsonb WHERE id = $1`,
        [deletionId, JSON.stringify(progress)],
      );
    };

    // ---------------------------------------------------------------
    // 1. Shared rooms, according to the person's choice
    // ---------------------------------------------------------------

    if (!done('contributions')) {
      if (request.contributions === 'remove') {
        // Itself resumable: it only selects what is not already in the trash, so an
        // interrupted run continues rather than restarting.
        await complete('contributions', {
          shared_items_trashed: await this.removeContributions(personId),
        });
      } else {
        await complete('contributions', {
          shared_items_kept: await this.countContributions(personId),
        });
      }
    }

    // ---------------------------------------------------------------
    // 2. The personal room: files first, then rows
    // ---------------------------------------------------------------

    const personal = await queryOne<{ id: string }>(
      this.pool,
      `SELECT id FROM app.room WHERE created_by = $1 AND kind = 'personal'`,
      [personId],
    );

    if (personal && !done('personal_files')) {
      const blobs = await queryRows<{ storage_key: string; checksum: string }>(
        this.pool,
        `SELECT DISTINCT storage_key, checksum FROM app.document WHERE room_id = $1`,
        [personal.id],
      );

      let filesDeleted = 0;
      for (const blob of blobs) {
        // Only when no document outside this room still points at the same bytes.
        // Content-addressing means a file uploaded to both a personal and a shared room
        // is one object, and deleting it would break the shared room's copy.
        const stillReferenced = await queryOne<{ count: string }>(
          this.pool,
          `SELECT count(*) FROM app.document WHERE checksum = $1 AND room_id <> $2`,
          [blob.checksum, personal.id],
        );
        if (Number(stillReferenced?.count ?? 0) > 0) continue;

        // Idempotent in every implementation, so a blob already gone is the desired
        // state rather than a failure that stalls the sweep.
        await this.blobs.delete(blob.storage_key);
        filesDeleted += 1;
      }
      await complete('personal_files', { files_deleted: filesDeleted });
    }

    if (personal && !done('personal_room')) {
      // The room, and everything that cascades from it: items, documents, chunks,
      // briefs, events. The thirty-day trash does not apply here — the freeze already
      // was the window, and a deletion that left a trash behind would not be one.
      //
      // Through `app.erase_personal_room` rather than a plain DELETE, because the
      // cascade reaches `app.event` and the append-only trigger refuses it. That
      // function is the only code permitted to delete from the log, it refuses any room
      // that is not this person's own personal room, and it clears its own flag. See
      // migration 0014.
      const erased = await withTransaction(this.pool, async (tx) => {
        const row = await queryOne<{ erase_personal_room: number }>(
          tx,
          `SELECT app.erase_personal_room($1)`,
          [personId],
        );
        return Number(row?.erase_personal_room ?? 0);
      });
      await complete('personal_room', {
        personal_events_erased: erased,
        personal_room_deleted: 1,
      });
    }

    if (!done('storage')) {
      const released = await withTransaction(this.pool, async (tx) => {
        const count = await execute(tx, `DELETE FROM app.storage_object WHERE person_id = $1`, [
          personId,
        ]);
        await execute(tx, `DELETE FROM app.storage_usage WHERE person_id = $1`, [personId]);
        return count;
      });
      await complete('storage', { storage_released: released });
    }

    // Exports are archives of the memory being deleted; leaving one downloadable would
    // make the deletion cosmetic.
    if (!done('exports')) {
      const exports = await queryRows<{ storage_key: string | null }>(
        this.pool,
        `SELECT storage_key FROM app.export_job WHERE person_id = $1 AND storage_key IS NOT NULL`,
        [personId],
      );
      for (const archive of exports) {
        if (archive.storage_key) await this.blobs.delete(archive.storage_key);
      }
      await complete('exports', {
        exports_deleted: await execute(
          this.pool,
          `DELETE FROM app.export_job WHERE person_id = $1`,
          [personId],
        ),
      });
    }

    // ---------------------------------------------------------------
    // 3. The tombstone
    // ---------------------------------------------------------------

    if (!done('tombstone')) {
      const tombstone = await queryOne<{ tombstone_person: Record<string, unknown> }>(
        this.pool,
        `SELECT app.tombstone_person($1)`,
        [personId],
      );
      await complete('tombstone', tombstone?.tombstone_person ?? {});
    }

    const removed = Object.fromEntries(
      Object.entries(progress).filter(([key]) => !key.startsWith('step:')),
    );

    const finished = await queryOne<DeletionRow>(
      this.pool,
      `UPDATE app.account_deletion
       SET status = 'completed', completed_at = now(), removed = $2::jsonb, claimed_at = NULL
       WHERE id = $1 AND status = 'requested'
       RETURNING ${COLUMNS}`,
      [deletionId, JSON.stringify(removed)],
    );

    return finished ? toRequest(finished) : null;
  }

  /**
   * Takes the lease on one deletion, or declines to run it.
   *
   * Conditional in SQL so that two sweeps overlapping — a timer and a hand-run script, or
   * two machines — cannot both start on one person. `DELETION_LEASE` is what makes a sweep
   * that died recoverable: nobody has to notice and clear a stuck flag, the lease simply
   * stops being current and the next run picks the deletion up where `progress` says it
   * stopped.
   */
  private async claim(deletionId: string): Promise<DeletionRow | null> {
    return queryOne<DeletionRow>(
      this.pool,
      `UPDATE app.account_deletion
       SET claimed_at = now()
       WHERE id = $1
         AND status = 'requested'
         AND execute_after <= now()
         AND (claimed_at IS NULL OR claimed_at < now() - $2::interval)
       RETURNING ${COLUMNS}`,
      [deletionId, DELETION_LEASE],
    );
  }

  /**
   * Moves the person's own memories in shared rooms to the trash.
   *
   * Through the ordinary trash, which this used to only claim. It was a bulk
   * `UPDATE app.item SET status = 'deleted'` with `purge_after` set and **no
   * `item.deleted` event**, under a comment quoting "ingen tyst massradering". Since
   * `app.trash` derives membership from the last lifecycle event, no event meant no row in
   * anybody's trash — while `purge_after` still counted down, so `app.purge_expired_items`
   * hard-deleted the lot thirty days later. The other members of a shared room lost
   * material with nothing in their history saying so and no owner able to restore what
   * they never saw leave. That was not a race; it was what the path did every time it ran.
   *
   * Now one `softDeleteWithin` per contribution, each in its own transaction, so every
   * removal appends its `item.deleted`, appears in the trash, keeps an undo token, and is
   * restorable by a room owner for the ordinary thirty days.
   *
   * **The identity on the event is the departing person's**, not a system actor. The other
   * members are entitled to see whose contributions left and why, and this runs before the
   * tombstone in `executeDeletion`, so the attribution is still there to record. It is also
   * why the sweep's order is load-bearing.
   *
   * A transaction per item rather than one around all of them: the loop is resumable. The
   * query only selects what is not already deleted, and `softDeleteWithin` is conditional
   * on the same thing, so a sweep interrupted halfway resumes exactly where it stopped
   * rather than starting over or double-counting.
   */
  private async removeContributions(personId: PersonId): Promise<number> {
    // The person as the actor of their own choice. `web` because this is a button in the
    // deletion flow; no session, because the sweep may run thirty days after the request.
    const actor: Actor = {
      personId,
      agentClient: 'web',
      sessionId: null,
      roomScope: [],
    };

    // `author_person_id` rather than the `item.created` actor the old query joined against:
    // it is the projection of exactly that, added in migration 0003, and it also covers a
    // memory the person shared into the room rather than typed there.
    const rows = await queryRows<ItemRow>(
      this.pool,
      `SELECT ${ITEM_COLUMNS} FROM app.item i
       JOIN app.room r ON r.id = i.room_id
       WHERE i.author_person_id = $1 AND r.kind = 'shared' AND i.status <> 'deleted'
       ORDER BY i.created_at`,
      [personId],
    );

    let removed = 0;
    for (const row of rows) {
      const result = await withTransaction(this.pool, (tx) =>
        softDeleteWithin(tx, {
          actor,
          item: mapItem(row),
          reason: CONTRIBUTIONS_REMOVED_REASON,
          now: new Date(),
        }),
      );
      if (result.applied) removed += 1;
    }

    return removed;
  }

  /**
   * How many contributions stay, for the record of what the deletion did.
   *
   * Counted the same way `removeContributions` selects, so "kept" and "removed" are two
   * answers to one question. It used to count every item the person had touched *any* event
   * about — including memories they had only edited or deleted, and other people's — so the
   * two numbers described different sets.
   */
  private async countContributions(personId: PersonId): Promise<number> {
    const row = await queryOne<{ count: string }>(
      this.pool,
      `SELECT count(*) AS count
       FROM app.item i
       JOIN app.room r ON r.id = i.room_id
       WHERE i.author_person_id = $1 AND r.kind = 'shared' AND i.status <> 'deleted'`,
      [personId],
    );
    return Number(row?.count ?? 0);
  }

  /**
   * Whether this person may still act. Checked by the API on every request.
   *
   * A frozen account can log in — that is the whole point, so the person can cancel or
   * export — but must not be able to write. Writing into a memory scheduled for deletion
   * is either a mistake or someone who does not know the account is going.
   */
  async isFrozen(personId: PersonId): Promise<boolean> {
    return (await this.pendingDeletion(personId)) !== null;
  }
}

/** Refused for a frozen account. Not an error the person caused; a state they chose. */
export class AccountFrozenError extends NotPermittedError {
  constructor() {
    super(
      'Kontot är på väg att raderas och går inte att skriva till. Avbryt raderingen först.',
    );
  }
}
