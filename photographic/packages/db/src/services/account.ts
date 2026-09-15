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
import { appendEvent } from './events.js';

export type ContributionChoice = 'keep' | 'remove';

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
}

const COLUMNS = `id, person_id, status, immediate, contributions, requested_at, execute_after,
                 cancelled_at, completed_at, removed`;

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
   * Carries out a deletion.
   *
   * Order is load-bearing. Files go before the rows that name them, because a row
   * deleted first is a blob nobody can find again — the storage is content-addressed,
   * so the only index into it is the `storage_key` about to be dropped. Shared-room
   * contributions are handled before the tombstone, because removing them needs the
   * person to still be attributable.
   */
  async executeDeletion(deletionId: string): Promise<DeletionRequest | null> {
    const request = await queryOne<DeletionRow>(
      this.pool,
      `SELECT ${COLUMNS} FROM app.account_deletion WHERE id = $1 AND status = 'requested'`,
      [deletionId],
    );
    if (!request) return null;

    const personId = request.person_id as PersonId;
    const removed: Record<string, unknown> = {};

    // ---------------------------------------------------------------
    // 1. Shared rooms, according to the person's choice
    // ---------------------------------------------------------------

    if (request.contributions === 'remove') {
      removed['shared_items_trashed'] = await this.removeContributions(personId);
    } else {
      removed['shared_items_kept'] = await this.countContributions(personId);
    }

    // ---------------------------------------------------------------
    // 2. The personal room: files first, then rows
    // ---------------------------------------------------------------

    const personal = await queryOne<{ id: string }>(
      this.pool,
      `SELECT id FROM app.room WHERE created_by = $1 AND kind = 'personal'`,
      [personId],
    );

    if (personal) {
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
      removed['files_deleted'] = filesDeleted;

      // The room, and everything that cascades from it: items, documents, chunks,
      // briefs, events. The thirty-day trash does not apply here — the freeze already
      // was the window, and a deletion that left a trash behind would not be one.
      //
      // Through `app.erase_personal_room` rather than a plain DELETE, because the
      // cascade reaches `app.event` and the append-only trigger refuses it. That
      // function is the only code permitted to delete from the log, it refuses any room
      // that is not this person's own personal room, and it clears its own flag. See
      // migration 0014.
      const erased = await queryOne<{ erase_personal_room: number }>(
        this.pool,
        `SELECT app.erase_personal_room($1)`,
        [personId],
      );
      removed['personal_events_erased'] = Number(erased?.erase_personal_room ?? 0);
      removed['personal_room_deleted'] = 1;
    }

    removed['storage_released'] = await execute(
      this.pool,
      `DELETE FROM app.storage_object WHERE person_id = $1`,
      [personId],
    );
    await execute(this.pool, `DELETE FROM app.storage_usage WHERE person_id = $1`, [personId]);

    // Exports are archives of the memory being deleted; leaving one downloadable would
    // make the deletion cosmetic.
    const exports = await queryRows<{ storage_key: string | null }>(
      this.pool,
      `SELECT storage_key FROM app.export_job WHERE person_id = $1 AND storage_key IS NOT NULL`,
      [personId],
    );
    for (const archive of exports) {
      if (archive.storage_key) await this.blobs.delete(archive.storage_key);
    }
    removed['exports_deleted'] = await execute(
      this.pool,
      `DELETE FROM app.export_job WHERE person_id = $1`,
      [personId],
    );

    // ---------------------------------------------------------------
    // 3. The tombstone
    // ---------------------------------------------------------------

    const tombstone = await queryOne<{ tombstone_person: Record<string, unknown> }>(
      this.pool,
      `SELECT app.tombstone_person($1)`,
      [personId],
    );
    Object.assign(removed, tombstone?.tombstone_person ?? {});

    const finished = await queryOne<DeletionRow>(
      this.pool,
      `UPDATE app.account_deletion
       SET status = 'completed', completed_at = now(), removed = $2::jsonb
       WHERE id = $1
       RETURNING ${COLUMNS}`,
      [deletionId, JSON.stringify(removed)],
    );

    return finished ? toRequest(finished) : null;
  }

  /**
   * Moves the person's own memories in shared rooms to the trash.
   *
   * Through the ordinary trash rather than a silent purge, so the other members see
   * `item.deleted` with a reason and a room owner can restore within thirty days. "Ingen
   * tyst massradering" is the rule; a deletion that emptied a shared room without anyone
   * seeing it would change what the others remember behind their backs.
   *
   * Authorship comes from the log, because `app.item` has no author column yet.
   */
  private async removeContributions(personId: PersonId): Promise<number> {
    const rows = await queryRows<{ item_id: string }>(
      this.pool,
      `SELECT DISTINCT (e.payload ->> 'item_id') AS item_id
       FROM app.event e
       JOIN app.room r ON r.id = e.room_id
       WHERE e.actor_person_id = $1
         AND r.kind = 'shared'
         AND e.event_type = 'item.created'
         AND e.payload ? 'item_id'`,
      [personId],
    );

    const ids = rows.map((row) => row.item_id).filter(Boolean);
    if (ids.length === 0) return 0;

    return execute(
      this.pool,
      `UPDATE app.item
       SET status = 'deleted',
           deleted_at = now(),
           deleted_by = $1,
           delete_reason = 'Kontot raderades och personen valde att ta bort sina bidrag.',
           purge_after = now() + interval '30 days'
       WHERE id = ANY($2::uuid[]) AND status <> 'deleted'`,
      [personId, ids],
    );
  }

  private async countContributions(personId: PersonId): Promise<number> {
    const row = await queryOne<{ count: string }>(
      this.pool,
      `SELECT count(DISTINCT e.payload ->> 'item_id') AS count
       FROM app.event e
       JOIN app.room r ON r.id = e.room_id
       WHERE e.actor_person_id = $1 AND r.kind = 'shared' AND e.payload ? 'item_id'`,
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
