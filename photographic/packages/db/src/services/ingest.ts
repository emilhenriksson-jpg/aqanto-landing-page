/**
 * The write path, backed by Postgres. See `MemoryIngest` for the policy reasoning this
 * mirrors: three tiers of write, because "never let a model write garbage" and "let
 * every model save small facts automatically" cannot share one rule.
 */

import { randomBytes } from 'node:crypto';

import type {
  Actor,
  IngestPort,
  Item,
  ItemId,
  ItemKind,
  JobPort,
  LlmPort,
  PersonId,
  Proposal,
  ProposalId,
  ProjectionPort,
  RoomId,
  ShortId,
  WriteDecision,
} from '@photographic/core';
import { NotFoundError, NotPermittedError, ValidationError } from '@photographic/core';
import {
  dedupeHash,
  estimateTokens,
  generateShortId,
  purgeDeadline,
  requiresApproval,
} from '@photographic/core';
import type { Pool } from 'pg';

import { queryOne, queryRows, withTransaction, type Db } from '../pool.js';
import { mapItem, mapProposal, type ItemRow, type ProposalRow } from '../rows.js';
import { appendEvent } from './events.js';
import { canWrite } from './permissions.js';

export const MAX_BODY_CHARS = 2000;

const BASE_SALIENCE: Record<ItemKind, number> = {
  identity: 1,
  instruction: 0.95,
  never: 0.95,
  preference: 0.8,
  fact: 0.75,
  decision: 0.6,
  note: 0.4,
};

const IDENTITY_HINTS =
  /\b(heter|bor i|jobbar|arbetar som|gift|sambo|dotter|son|barn|född|my name is|i live in|i work)\b/i;
const PREFERENCE_HINTS = /\b(gillar|ogillar|föredrar|hellre|helst|prefer|prefers|likes|dislikes)\b/i;
const INSTRUCTION_HINTS =
  /\b(alltid|aldrig|ska du|du ska|svara|utmana|använd inte|always|never|don't|do not)\b/i;
const DECISION_HINTS = /\b(beslutade|bestämde|vi kör|vi skjuter|decided|agreed)\b/i;

export function classifyKind(body: string): ItemKind {
  if (INSTRUCTION_HINTS.test(body) && /\b(du|you|svara|answer|utmana|challenge)\b/i.test(body)) {
    return 'instruction';
  }
  if (DECISION_HINTS.test(body)) return 'decision';
  if (IDENTITY_HINTS.test(body)) return 'identity';
  if (PREFERENCE_HINTS.test(body)) return 'preference';
  return 'fact';
}

const ITEM_COLUMNS = `id, short_id, room_id, kind, body, structured, sensitivity, status,
  valid_from, valid_to, superseded_by, salience, token_estimate, last_used_at, use_count,
  created_at, deleted_at, deleted_by, deleted_by_client, purge_after, delete_reason`;

export class PgIngest implements IngestPort {
  constructor(
    private readonly pool: Pool,
    private readonly llm: LlmPort,
    private readonly projection: ProjectionPort,
    private readonly jobs: JobPort,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async remember(
    actor: Actor,
    input: {
      roomId: RoomId;
      body: string;
      kind?: ItemKind;
      sensitivity?: 'normal' | 'sensitive';
      explicit?: boolean;
    },
  ): Promise<WriteDecision> {
    if (!(await canWrite(this.pool, actor.personId, input.roomId))) throw new NotPermittedError();

    const body = input.body.trim().replace(/\s+/g, ' ');
    if (!body) throw new ValidationError('Tomt minne kan inte sparas.');
    if (body.length > MAX_BODY_CHARS) {
      throw new ValidationError('För långt för att sparas som ett minne. Ladda upp det som dokument.');
    }

    const kind = input.kind ?? classifyKind(body);
    const room = await queryOne<{ kind: string }>(this.pool, `SELECT kind FROM app.room WHERE id = $1`, [
      input.roomId,
    ]);
    const siblings = await this.activeSiblings(input.roomId);

    const hash = dedupeHash(body);
    const identical = siblings.find((i) => dedupeHash(i.body) === hash);
    if (identical) return { outcome: 'duplicate', existing: await this.bumpSalience(identical) };

    let contradicts = false;
    let conflicting: ItemId | null = null;
    for (const sibling of this.neighbours(body, siblings)) {
      const verdict = await this.llm.compare(body, sibling.body);
      if (verdict === 'same') {
        return { outcome: 'duplicate', existing: await this.bumpSalience(sibling) };
      }
      if (verdict === 'contradicts') {
        contradicts = true;
        conflicting = sibling.id;
        break;
      }
    }

    const gate = requiresApproval({
      kind,
      body,
      contradicts,
      explicit: input.explicit ?? false,
      roomIsShared: room?.kind === 'shared',
    });

    if (gate.required) {
      const proposal = await this.queueProposal(
        actor,
        input.roomId,
        kind,
        body,
        gate.reason,
        contradicts ? conflicting : null,
      );
      return { outcome: 'needs_approval', proposal };
    }

    const item = await this.write(actor, {
      roomId: input.roomId,
      kind,
      body,
      sensitivity: input.sensitivity ?? 'normal',
    });

    return { outcome: 'auto', item };
  }

  async propose(
    actor: Actor,
    input: { roomId: RoomId; body: string; kind?: ItemKind; reason?: string; source?: string },
  ): Promise<Proposal> {
    if (!(await canWrite(this.pool, actor.personId, input.roomId))) throw new NotPermittedError();

    const body = input.body.trim().replace(/\s+/g, ' ');
    if (!body) throw new ValidationError('Tomt förslag kan inte sparas.');

    const kind = input.kind ?? classifyKind(body);
    const siblings = await this.activeSiblings(input.roomId);
    const conflicting = this.neighbours(body, siblings)[0]?.id ?? null;

    return this.queueProposal(
      actor,
      input.roomId,
      kind,
      body,
      input.reason ?? (input.source ? `importerat från ${input.source}` : 'importerat minne'),
      conflicting,
    );
  }

  async update(actor: Actor, shortId: ShortId, roomId: RoomId, body: string): Promise<Item> {
    if (!(await canWrite(this.pool, actor.personId, roomId))) throw new NotPermittedError();

    const item = await this.findByShortId(roomId, shortId);
    if (!item || item.status === 'deleted') throw new NotFoundError('Minnet finns inte.');

    const next = body.trim().replace(/\s+/g, ' ');
    if (!next) throw new ValidationError('Tomt minne kan inte sparas.');

    await this.pool.query(
      `UPDATE app.item SET body = $1, token_estimate = $2 WHERE id = $3`,
      [next, estimateTokens(next), item.id],
    );

    await appendEvent(this.pool, {
      roomId,
      eventType: 'item.updated',
      payload: { item_id: item.id, short_id: item.shortId, body: next, previous: item.body },
      actorPersonId: actor.personId,
      agentClient: actor.agentClient,
    });

    await this.markStale(item.roomId, actor);
    await this.queueEmbedding(item.id);
    return { ...item, body: next, tokenEstimate: estimateTokens(next) };
  }

  async forget(
    actor: Actor,
    shortId: ShortId,
    roomId: RoomId,
    reason?: string,
  ): Promise<{ item: Item; undoToken: string }> {
    if (!(await canWrite(this.pool, actor.personId, roomId))) throw new NotPermittedError();

    const item = await this.findByShortId(roomId, shortId);
    if (!item) throw new NotFoundError('Minnet finns inte.');
    if (item.status === 'deleted') {
      throw new ValidationError('Minnet ligger redan i papperskorgen.');
    }

    const now = this.clock();
    const undoToken = randomBytes(16).toString('base64url');
    const purgeAfter = purgeDeadline(now);

    await this.pool.query(
      `UPDATE app.item
       SET status = 'deleted', deleted_at = $1, deleted_by = $2, deleted_by_client = $3,
           purge_after = $4, delete_reason = $5, undo_token = $6
       WHERE id = $7`,
      [now, actor.personId, actor.agentClient, purgeAfter, reason?.trim() || null, undoToken, item.id],
    );

    await appendEvent(this.pool, {
      roomId,
      eventType: 'item.deleted',
      payload: { item_id: item.id, short_id: item.shortId, body: item.body },
      actorPersonId: actor.personId,
      agentClient: actor.agentClient,
    });

    await this.markStale(roomId, actor);

    return {
      item: {
        ...item,
        status: 'deleted',
        deletedAt: now,
        deletedBy: actor.personId,
        deletedByClient: actor.agentClient,
        purgeAfter,
        deleteReason: reason?.trim() || null,
      },
      undoToken,
    };
  }

  async undo(actor: Actor, undoToken: string): Promise<Item> {
    const row = await queryOne<ItemRow>(
      this.pool,
      `SELECT ${ITEM_COLUMNS} FROM app.item WHERE undo_token = $1`,
      [undoToken],
    );
    if (!row) throw new NotFoundError('Det finns inget att ta tillbaka.');
    const item = mapItem(row);
    if (!(await canWrite(this.pool, actor.personId, item.roomId))) throw new NotPermittedError();

    await this.pool.query(`UPDATE app.item SET undo_token = NULL WHERE id = $1`, [item.id]);
    return this.restore(actor, item);
  }

  async listProposals(actor: Actor): Promise<Proposal[]> {
    const rows = await queryRows<ProposalRow>(
      this.pool,
      `SELECT id, room_id, person_id, kind, body, reason, conflicts_with, proposed_by_client, status, created_at
       FROM app.proposal WHERE person_id = $1 AND status = 'pending' ORDER BY created_at ASC`,
      [actor.personId],
    );
    return rows.map(mapProposal);
  }

  async resolveProposal(actor: Actor, id: ProposalId, accept: boolean): Promise<Item | null> {
    const row = await queryOne<ProposalRow>(
      this.pool,
      `SELECT id, room_id, person_id, kind, body, reason, conflicts_with, proposed_by_client, status, created_at
       FROM app.proposal WHERE id = $1`,
      [id],
    );
    if (!row || row.person_id !== actor.personId) throw new NotFoundError('Förslaget finns inte.');
    const proposal = mapProposal(row);
    if (proposal.status !== 'pending') throw new ValidationError('Förslaget är redan hanterat.');

    if (!accept) {
      await this.pool.query(`UPDATE app.proposal SET status = 'rejected', resolved_at = now() WHERE id = $1`, [
        id,
      ]);
      await appendEvent(this.pool, {
        roomId: proposal.roomId,
        eventType: 'proposal.rejected',
        payload: { proposal_id: proposal.id, body: proposal.body },
        actorPersonId: actor.personId,
        agentClient: actor.agentClient,
      });
      return null;
    }

    return withTransaction(this.pool, async (tx) => {
      await tx.query(`UPDATE app.proposal SET status = 'accepted', resolved_at = now() WHERE id = $1`, [id]);

      if (proposal.conflictsWith) {
        await tx.query(
          `UPDATE app.item SET status = 'superseded', valid_to = now() WHERE id = $1 AND status = 'active'`,
          [proposal.conflictsWith],
        );
      }

      const item = await this.write(
        actor,
        {
          roomId: proposal.roomId,
          kind: proposal.kind,
          body: proposal.body,
          sensitivity: 'normal',
          approvedBy: actor.personId,
          supersedes: proposal.conflictsWith,
        },
        tx,
      );

      await tx.query(`UPDATE app.proposal SET resulting_item = $1 WHERE id = $2`, [item.id, id]);

      await appendEvent(tx, {
        roomId: proposal.roomId,
        eventType: 'proposal.accepted',
        payload: { proposal_id: proposal.id, item_id: item.id, body: item.body },
        actorPersonId: actor.personId,
        agentClient: actor.agentClient,
        approvedBy: actor.personId,
      });

      return item;
    });
  }

  /** Shared with `PgTrash`, so restore-via-undo and restore-from-trash cannot drift apart. */
  async restore(actor: Actor, item: Item): Promise<Item> {
    if (item.status !== 'deleted') return item;

    await this.pool.query(
      `UPDATE app.item
       SET status = 'active', deleted_at = NULL, deleted_by = NULL, deleted_by_client = NULL,
           purge_after = NULL, delete_reason = NULL
       WHERE id = $1`,
      [item.id],
    );

    await appendEvent(this.pool, {
      roomId: item.roomId,
      eventType: 'item.restored',
      payload: { item_id: item.id, short_id: item.shortId, body: item.body },
      actorPersonId: actor.personId,
      agentClient: actor.agentClient,
    });

    await this.markStale(item.roomId, actor);

    return {
      ...item,
      status: 'active',
      deletedAt: null,
      deletedBy: null,
      deletedByClient: null,
      purgeAfter: null,
      deleteReason: null,
    };
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  private async write(
    actor: Actor,
    input: {
      roomId: RoomId;
      kind: ItemKind;
      body: string;
      sensitivity: 'normal' | 'sensitive';
      approvedBy?: PersonId;
      supersedes?: ItemId | null;
    },
    db: Db = this.pool,
  ): Promise<Item> {
    const shortId = generateShortId() as ShortId;
    const tokenEstimate = estimateTokens(input.body);
    const salience = BASE_SALIENCE[input.kind];
    const hash = dedupeHash(input.body);

    const row = await queryOne<ItemRow>(
      db,
      `INSERT INTO app.item (short_id, room_id, kind, body, sensitivity, salience, token_estimate, dedupe_hash)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING ${ITEM_COLUMNS}`,
      [shortId, input.roomId, input.kind, input.body, input.sensitivity, salience, tokenEstimate, hash],
    );
    const item = mapItem(row!);

    if (input.supersedes) {
      await db.query(`UPDATE app.item SET superseded_by = $1 WHERE id = $2`, [item.id, input.supersedes]);
    }

    await appendEvent(db, {
      roomId: input.roomId,
      eventType: 'item.created',
      payload: { item_id: item.id, short_id: item.shortId, kind: item.kind, body: item.body },
      actorPersonId: actor.personId,
      agentClient: actor.agentClient,
      approvedBy: input.approvedBy ?? null,
    });

    await this.markStale(input.roomId, actor);
    await this.queueEmbedding(item.id);
    return item;
  }

  /**
   * Embedding happens after the row is committed, never inline with the write, and
   * only as a job -- not an inline `await this.llm.embed(...)` the way the in-memory
   * reference implementation does it. Two things are true of this path that are not
   * true of the reference one: embedding a real memory is a network call with
   * `OpenAiLlm`, and this write has to stay fast and succeed regardless of whether
   * that call is slow or down. A memory the model just saved must exist the instant
   * this method returns; ranking a little better once the embedding lands a second
   * later is a fine trade, losing the memory because an API call was slow is not.
   *
   * `PgJobs` already retries a failing job up to `max_attempts` before giving up, so a
   * transient outage backfills itself without anything here needing to know that
   * happened.
   */
  private async queueEmbedding(itemId: ItemId): Promise<void> {
    await this.jobs.enqueue({
      kind: 'embed_item',
      payload: { itemId },
      dedupeKey: `embed:${itemId}`,
    });
  }

  private async queueProposal(
    actor: Actor,
    roomId: RoomId,
    kind: ItemKind,
    body: string,
    reason: string,
    conflictsWith: ItemId | null,
  ): Promise<Proposal> {
    const row = await queryOne<ProposalRow>(
      this.pool,
      `INSERT INTO app.proposal (room_id, person_id, kind, body, reason, conflicts_with, proposed_by_client)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id, room_id, person_id, kind, body, reason, conflicts_with, proposed_by_client, status, created_at`,
      [roomId, actor.personId, kind, body, reason, conflictsWith, actor.agentClient],
    );
    const proposal = mapProposal(row!);

    await appendEvent(this.pool, {
      roomId,
      eventType: 'proposal.created',
      payload: { proposal_id: proposal.id, body, kind, reason },
      actorPersonId: actor.personId,
      agentClient: actor.agentClient,
    });

    return proposal;
  }

  private async bumpSalience(item: Item): Promise<Item> {
    const salience = Math.min(1, item.salience + 0.05);
    await this.pool.query(
      `UPDATE app.item SET salience = $1, use_count = use_count + 1, last_used_at = now() WHERE id = $2`,
      [salience, item.id],
    );
    return { ...item, salience, useCount: item.useCount + 1, lastUsedAt: new Date() };
  }

  private async activeSiblings(roomId: RoomId): Promise<Item[]> {
    const rows = await queryRows<ItemRow>(
      this.pool,
      `SELECT ${ITEM_COLUMNS} FROM app.item WHERE room_id = $1 AND status = 'active'`,
      [roomId],
    );
    return rows.map(mapItem);
  }

  private async findByShortId(roomId: RoomId, shortId: ShortId): Promise<Item | null> {
    const row = await queryOne<ItemRow>(
      this.pool,
      `SELECT ${ITEM_COLUMNS} FROM app.item WHERE room_id = $1 AND short_id = $2`,
      [roomId, shortId],
    );
    return row ? mapItem(row) : null;
  }

  /** Cheap word-overlap shortlist, standing in for the vector neighbourhood query. */
  private neighbours(body: string, siblings: Item[]): Item[] {
    const words = new Set(dedupeHash(body).split(' ').filter((w) => w.length > 2));
    if (words.size === 0) return [];

    return siblings
      .map((item) => {
        const other = new Set(dedupeHash(item.body).split(' ').filter((w) => w.length > 2));
        let shared = 0;
        for (const w of words) if (other.has(w)) shared += 1;
        return { item, score: shared / Math.min(words.size, other.size || 1) };
      })
      .filter((x) => x.score >= 0.5)
      .sort((a, b) => b.score - a.score)
      .slice(0, 5)
      .map((x) => x.item);
  }

  private async markStale(roomId: RoomId, actor: Actor): Promise<void> {
    const room = await queryOne<{ kind: string; created_by: string }>(
      this.pool,
      `SELECT kind, created_by FROM app.room WHERE id = $1`,
      [roomId],
    );
    const personId = room?.kind === 'personal' ? (room.created_by as PersonId) : undefined;

    await this.projection.invalidate({ roomId, ...(personId ? { personId } : {}) });
    await this.jobs.enqueue({
      kind: 'rebuild_projections',
      payload: { roomId, personId: personId ?? null },
      dedupeKey: `rebuild:${roomId}`,
    });
  }
}
