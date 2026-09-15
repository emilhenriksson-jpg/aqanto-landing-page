/**
 * The write path, backed by Postgres. See `MemoryIngest` for the policy reasoning this
 * mirrors: three tiers of write, because "never let a model write garbage" and "let
 * every model save small facts automatically" cannot share one rule.
 */

import { randomBytes } from 'node:crypto';

import type {
  Actor,
  Dispute,
  IngestPort,
  Item,
  ItemId,
  ItemKind,
  JobPort,
  LlmPort,
  MemoryEvent,
  MemoryEventKind,
  MemorySource,
  PersonId,
  PlacementDecision,
  Proposal,
  ProposalId,
  ProposalIntent,
  ProjectionPort,
  Room,
  RoomId,
  RoomKind,
  Sensitivity,
  SharedWith,
  ShortId,
  UpdateDecision,
  WriteDecision,
  WriteProvenance,
} from '@photographic/core';
import { NotFoundError, NotPermittedError, ValidationError } from '@photographic/core';
import {
  ROUTING_SAMPLE_SIZE,
  canRemoveMemory,
  dedupeHash,
  deriveMotivation,
  deriveSource,
  estimateTokens,
  generateShortId,
  purgeDeadline,
  requiresApproval,
  joinReason,
  routeMemory,
} from '@photographic/core';
import type { RoutingDeps } from '@photographic/core';
import type { Pool } from 'pg';

import { queryOne, queryRows, withTransaction, type Db } from '../pool.js';
import {
  EVENT_COLUMNS,
  ITEM_COLUMNS,
  PROPOSAL_COLUMNS,
  mapEvent,
  mapItem,
  mapProposal,
  mapRoom,
  type EventRow,
  type ItemRow,
  type ProposalRow,
  type RoomRow,
} from '../rows.js';
import { appendEvent } from './events.js';
import { canWrite, roleIn } from './permissions.js';

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
      roomId?: RoomId;
      body: string;
      kind?: ItemKind;
      sensitivity?: 'normal' | 'sensitive';
      explicit?: boolean;
    } & WriteProvenance,
  ): Promise<WriteDecision> {
    const body = input.body.trim().replace(/\s+/g, ' ');
    if (!body) throw new ValidationError('Tomt minne kan inte sparas.');
    if (body.length > MAX_BODY_CHARS) {
      throw new ValidationError('För långt för att sparas som ett minne. Ladda upp det som dokument.');
    }

    const kind = input.kind ?? classifyKind(body);

    // Nobody named a room, so Photographic decides where it belongs and records why. See
    // `MemoryIngest.remember`: the router picks a target, the gate below decides whether
    // the write lands.
    const routing = input.roomId
      ? null
      : await routeMemory(this.routingDeps(), actor, { body, kind });
    const roomId = input.roomId ?? routing!.roomId;

    if (!(await canWrite(this.pool, actor.personId, roomId))) throw new NotPermittedError();

    const sensitivity = input.sensitivity ?? 'normal';
    const room = await this.room(roomId);
    const siblings = await this.activeSiblings(roomId);

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
      roomIsShared: room.kind === 'shared',
      sensitivity,
    });

    const motivation = input.motivation ?? routing?.motivation;

    if (gate.required) {
      const proposal = await this.queueProposal(actor, {
        roomId,
        intent: 'remember',
        kind,
        body,
        reason: joinReason(routing?.uncertainty, gate.reason),
        conflictsWith: conflicting,
        ...(motivation ? { motivation } : {}),
      });
      return { outcome: 'needs_approval', proposal, ...(routing ? { routing } : {}) };
    }

    const item = await this.write(actor, {
      roomId,
      kind,
      body,
      sensitivity,
      explicit: input.explicit ?? false,
      ...(motivation ? { motivation } : {}),
      ...(input.source ? { source: input.source } : {}),
    });

    return { outcome: 'auto', item, ...(routing ? { routing } : {}) };
  }

  /**
   * What the router is allowed to consider: rooms this person may write to.
   *
   * One query rather than one per room — routing runs on every unaddressed write, and a
   * fan-out over eleven rooms on the save path is how a voice turn starts to feel slow.
   */
  private routingDeps(): RoutingDeps {
    return {
      llm: this.llm,
      candidates: async (actor) => {
        const rows = await queryRows<{
          room_id: string;
          kind: RoomKind;
          title: string;
          headline: string | null;
          member_count: string;
          sample: string[] | null;
        }>(
          this.pool,
          `SELECT r.id AS room_id, r.kind, r.title,
                  -- Owner's own description first, then the summarised brief. Both are
                  -- nullif-ed, so an empty one falls through instead of winning.
                  coalesce(nullif(r.description, ''), nullif(b.rendered, ''), '') AS headline,
                  (SELECT count(*) FROM app.membership m
                    WHERE m.room_id = r.id AND m.left_at IS NULL) AS member_count,
                  (SELECT array_agg(i.body ORDER BY i.created_at DESC)
                     FROM (
                       SELECT body, created_at FROM app.item
                       WHERE room_id = r.id AND status = 'active'
                       ORDER BY created_at DESC
                       LIMIT $2
                     ) i) AS sample
           FROM app.accessible_room_ids($1) a
           JOIN app.room r ON r.id = a.room_id
           LEFT JOIN app.brief b ON b.room_id = r.id
           WHERE a.role IN ('owner', 'editor')`,
          [actor.personId, ROUTING_SAMPLE_SIZE],
        );

        return rows.map((row) => ({
          roomId: row.room_id as RoomId,
          kind: row.kind,
          title: row.title,
          headline: row.headline ?? '',
          memberCount: Number(row.member_count),
          sample: row.sample ?? [],
        }));
      },
    };
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

    return this.queueProposal(actor, {
      roomId: input.roomId,
      intent: 'remember',
      kind,
      body,
      reason: input.reason ?? (input.source ? `importerat från ${input.source}` : 'importerat minne'),
      conflictsWith: conflicting,
      ...(input.source ? { importedFrom: input.source } : {}),
    });
  }

  /** Edits a memory, through the same gate as every other write. See `MemoryIngest`. */
  async update(
    actor: Actor,
    shortId: ShortId,
    roomId: RoomId,
    body: string,
    provenance: WriteProvenance = {},
  ): Promise<UpdateDecision> {
    if (!(await canWrite(this.pool, actor.personId, roomId))) throw new NotPermittedError();

    const item = await this.findByShortId(roomId, shortId);
    if (!item || item.status === 'deleted') throw new NotFoundError('Minnet finns inte.');

    const next = body.trim().replace(/\s+/g, ' ');
    if (!next) throw new ValidationError('Tomt minne kan inte sparas.');

    const room = await this.room(item.roomId);
    const gate = requiresApproval({
      kind: item.kind,
      body: next,
      contradicts: false,
      explicit: true,
      roomIsShared: room.kind === 'shared',
      sensitivity: item.sensitivity,
    });

    if (gate.required) {
      return {
        outcome: 'needs_approval',
        proposal: await this.queueProposal(actor, {
          roomId: item.roomId,
          intent: 'update',
          kind: item.kind,
          body: next,
          reason: gate.reason,
          conflictsWith: null,
          sourceItemId: item.id,
          ...(provenance.motivation ? { motivation: provenance.motivation } : {}),
        }),
      };
    }

    return { outcome: 'updated', item: await this.applyUpdate(actor, item, next, provenance) };
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
    await this.assertMayRemove(actor, item);

    return this.softDelete(actor, item, reason);
  }

  /** Moves a memory to the trash. Shared by `forget` and by "ta bort mina bidrag". */
  async softDelete(
    actor: Actor,
    item: Item,
    reason?: string,
  ): Promise<{ item: Item; undoToken: string }> {
    const now = this.clock();
    const undoToken = randomBytes(16).toString('base64url');
    const purgeAfter = purgeDeadline(now);
    const room = await this.room(item.roomId);

    await this.pool.query(
      `UPDATE app.item
       SET status = 'deleted', deleted_at = $1, deleted_by = $2, deleted_by_client = $3,
           purge_after = $4, delete_reason = $5, undo_token = $6
       WHERE id = $7`,
      [now, actor.personId, actor.agentClient, purgeAfter, reason?.trim() || null, undoToken, item.id],
    );

    await appendEvent(this.pool, {
      roomId: item.roomId,
      eventType: 'item.deleted',
      payload: { item_id: item.id, short_id: item.shortId, body: item.body },
      actorPersonId: actor.personId,
      agentClient: actor.agentClient,
      clientId: actor.clientId ?? null,
      sessionRef: actor.sessionId,
      explicit: true,
      motivation:
        reason?.trim() ||
        deriveMotivation({ kind: 'deleted', roomTitle: room.title, roomKind: room.kind }),
    });

    await this.markStale(item.roomId, actor);

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

  /** See `MemoryIngest.share`: copies rather than relocates, and never automatic. */
  async share(
    actor: Actor,
    input: {
      shortId: ShortId;
      fromRoomId?: RoomId;
      toRoomId: RoomId;
      confirmed?: boolean;
    } & WriteProvenance,
  ): Promise<PlacementDecision> {
    const { item, target } = await this.resolvePlacement(actor, input);

    if (!input.confirmed) {
      return {
        outcome: 'needs_approval',
        proposal: await this.queueProposal(actor, {
          roomId: target.id,
          intent: 'share',
          kind: item.kind,
          body: item.body,
          reason: `delning till ${target.title} måste bekräftas av dig`,
          conflictsWith: null,
          sourceItemId: item.id,
          ...(input.motivation ? { motivation: input.motivation } : {}),
        }),
      };
    }

    return this.placeShare(actor, item, target, input.motivation);
  }

  async move(
    actor: Actor,
    input: {
      shortId: ShortId;
      fromRoomId?: RoomId;
      toRoomId: RoomId;
      confirmed?: boolean;
    } & WriteProvenance,
  ): Promise<PlacementDecision> {
    const { item, target } = await this.resolvePlacement(actor, input);
    const origin = await this.room(item.roomId);

    if (origin.id === target.id) {
      throw new ValidationError(`${item.shortId} ligger redan i ${target.title}.`);
    }

    if (target.kind === 'shared' && !input.confirmed) {
      return {
        outcome: 'needs_approval',
        proposal: await this.queueProposal(actor, {
          roomId: target.id,
          intent: 'share',
          kind: item.kind,
          body: item.body,
          reason: `flytt till det delade rummet ${target.title} måste bekräftas av dig`,
          conflictsWith: null,
          sourceItemId: item.id,
          ...(input.motivation ? { motivation: input.motivation } : {}),
        }),
      };
    }

    const motivation =
      input.motivation ??
      deriveMotivation({
        kind: 'moved',
        roomTitle: target.title,
        roomKind: target.kind,
        fromRoomTitle: origin.title,
      });

    const event = await withTransaction(this.pool, async (tx) => {
      // `placement_explicit` moves with the row, because the trigger fires on a room
      // change too: a memory cannot be walked into a shared room the way it could not be
      // written into one.
      await tx.query(
        `UPDATE app.item SET room_id = $1, placement_explicit = true WHERE id = $2`,
        [target.id, item.id],
      );

      return appendEvent(tx, {
        roomId: target.id,
        eventType: 'item.moved',
        payload: { item_id: item.id, short_id: item.shortId, kind: item.kind, body: item.body },
        actorPersonId: actor.personId,
        agentClient: actor.agentClient,
        clientId: actor.clientId ?? null,
        sessionRef: actor.sessionId,
        fromRoomId: origin.id,
        toRoomId: target.id,
        explicit: true,
        motivation,
        source: this.sourceFor(actor),
      });
    });

    await this.markStale(origin.id, actor);
    await this.markStale(target.id, actor);
    return { outcome: 'placed', item: { ...item, roomId: target.id }, event };
  }

  async listProposals(actor: Actor): Promise<Proposal[]> {
    const rows = await queryRows<ProposalRow>(
      this.pool,
      `SELECT ${PROPOSAL_COLUMNS}
       FROM app.proposal WHERE person_id = $1 AND status = 'pending' ORDER BY created_at ASC`,
      [actor.personId],
    );
    return rows.map(mapProposal);
  }

  async resolveProposal(actor: Actor, id: ProposalId, accept: boolean): Promise<Item | null> {
    const row = await queryOne<ProposalRow>(
      this.pool,
      `SELECT ${PROPOSAL_COLUMNS} FROM app.proposal WHERE id = $1`,
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
        clientId: actor.clientId ?? null,
      });
      return null;
    }

    await this.pool.query(
      `UPDATE app.proposal SET status = 'accepted', resolved_at = now() WHERE id = $1`,
      [id],
    );

    const resulting = await this.applyProposal(actor, proposal);

    await this.pool.query(`UPDATE app.proposal SET resulting_item = $1 WHERE id = $2`, [
      resulting.id,
      id,
    ]);

    await appendEvent(this.pool, {
      roomId: proposal.roomId,
      eventType: 'proposal.accepted',
      payload: { proposal_id: proposal.id, item_id: resulting.id, body: resulting.body },
      actorPersonId: actor.personId,
      agentClient: actor.agentClient,
      clientId: actor.clientId ?? null,
      approvedBy: actor.personId,
      explicit: true,
    });

    return resulting;
  }

  async listDisputes(actor: Actor): Promise<Dispute[]> {
    const rows = await queryRows<{
      room_id: string;
      room_title: string;
      a_short: string;
      a_id: string;
      a_body: string;
      a_author: string;
      a_author_name: string | null;
      a_created: Date;
      b_short: string;
      b_id: string;
      b_body: string;
      b_author: string;
      b_author_name: string | null;
      b_created: Date;
    }>(
      this.pool,
      // One row per pair rather than per statement: `a.id < b.id` is what stops a
      // symmetric link from producing the same disagreement twice.
      `SELECT a.room_id, r.title AS room_title,
              a.short_id AS a_short, a.id AS a_id, a.body AS a_body,
              a.author_person_id AS a_author, pa.display_name AS a_author_name, a.created_at AS a_created,
              b.short_id AS b_short, b.id AS b_id, b.body AS b_body,
              b.author_person_id AS b_author, pb.display_name AS b_author_name, b.created_at AS b_created
       FROM app.item a
       JOIN app.item b ON b.id = ANY (a.disputed_by) AND a.id < b.id
       JOIN app.room r ON r.id = a.room_id
       LEFT JOIN app.person pa ON pa.id = a.author_person_id
       LEFT JOIN app.person pb ON pb.id = b.author_person_id
       WHERE a.room_id = ANY (SELECT room_id FROM app.accessible_room_ids($1))
       ORDER BY greatest(a.created_at, b.created_at) DESC`,
      [actor.personId],
    );

    return rows.map((row) => {
      const sides = [
        {
          shortId: row.a_short as ShortId,
          itemId: row.a_id as ItemId,
          body: row.a_body,
          authorPersonId: row.a_author as PersonId,
          authorName: row.a_author_name,
          writtenAt: row.a_created,
        },
        {
          shortId: row.b_short as ShortId,
          itemId: row.b_id as ItemId,
          body: row.b_body,
          authorPersonId: row.b_author as PersonId,
          authorName: row.b_author_name,
          writtenAt: row.b_created,
        },
      ].sort((x, y) => x.writtenAt.getTime() - y.writtenAt.getTime());

      return {
        roomId: row.room_id as RoomId,
        roomTitle: row.room_title,
        sides,
        raisedAt: sides[1]!.writtenAt,
        reason: 'Två medlemmar har skrivit uppgifter som inte kan stämma samtidigt.',
      };
    });
  }

  /** See `MemoryIngest.resolveDispute`: a human decides, and only ever a human. */
  async resolveDispute(
    actor: Actor,
    input: { winnerShortId: ShortId; loserShortId: ShortId; roomId?: RoomId; resolution?: string },
  ): Promise<Item> {
    const scope = input.roomId ? [input.roomId] : undefined;
    const winner = await this.findInScope(actor, input.winnerShortId, scope);
    const loser = await this.findInScope(actor, input.loserShortId, scope);
    if (!winner || !loser) throw new NotFoundError('Minnet finns inte.');
    if (winner.roomId !== loser.roomId) throw new ValidationError('Uppgifterna ligger inte i samma rum.');
    if (!loser.disputedBy.includes(winner.id)) {
      throw new ValidationError('De här två uppgifterna är inte omtvistade.');
    }

    const role = await roleIn(this.pool, actor.personId, loser.roomId);
    if (role !== 'owner' && loser.authorPersonId !== actor.personId) {
      throw new NotPermittedError(
        'Bara den som skrev uppgiften eller rummets ägare kan avgöra en tvist.',
      );
    }

    const resolution = input.resolution ?? 'avgjord av en människa';

    await withTransaction(this.pool, async (tx) => {
      await this.unlinkDispute(tx, winner.id, loser.id);
      await this.supersede(tx, actor, { loser, winner, resolution });

      await appendEvent(tx, {
        roomId: loser.roomId,
        eventType: 'item.dispute_resolved',
        payload: {
          item_id: loser.id,
          short_id: loser.shortId,
          disputed_by: winner.id,
          winner_item_id: winner.id,
          resolution,
        },
        actorPersonId: actor.personId,
        agentClient: actor.agentClient,
        clientId: actor.clientId ?? null,
        sessionRef: actor.sessionId,
        explicit: true,
        motivation: `${winner.shortId} gäller; ${loser.shortId} ersattes.`,
      });
    });

    await this.markStale(loser.roomId, actor);
    return winner;
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

    const room = await this.room(item.roomId);
    await appendEvent(this.pool, {
      roomId: item.roomId,
      eventType: 'item.restored',
      payload: { item_id: item.id, short_id: item.shortId, body: item.body },
      actorPersonId: actor.personId,
      agentClient: actor.agentClient,
      clientId: actor.clientId ?? null,
      sessionRef: actor.sessionId,
      explicit: true,
      motivation: deriveMotivation({
        kind: 'restored',
        roomTitle: room.title,
        roomKind: room.kind,
      }),
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

  /** See `MemoryIngest.applyProposal`: three intents, and a contradiction is the one that matters. */
  private async applyProposal(actor: Actor, proposal: Proposal): Promise<Item> {
    if (proposal.intent === 'share') {
      const source = proposal.sourceItemId ? await this.findById(proposal.sourceItemId) : null;
      if (!source) throw new NotFoundError('Minnet som skulle delas finns inte längre.');
      const target = await this.room(proposal.roomId);

      const placed = await this.placeShare(actor, source, target, undefined, actor.personId);
      return placed.item;
    }

    if (proposal.intent === 'update') {
      const target = proposal.sourceItemId ? await this.findById(proposal.sourceItemId) : null;
      if (!target) throw new NotFoundError('Minnet som skulle ändras finns inte längre.');
      return this.applyUpdate(actor, target, proposal.body, {}, actor.personId);
    }

    const conflicting = proposal.conflictsWith ? await this.findById(proposal.conflictsWith) : null;
    const room = await this.room(proposal.roomId);
    const acrossAuthors =
      conflicting !== null &&
      room.kind === 'shared' &&
      conflicting.authorPersonId !== actor.personId;

    return withTransaction(this.pool, async (tx) => {
      const item = await this.write(
        actor,
        {
          roomId: proposal.roomId,
          kind: proposal.kind,
          body: proposal.body,
          sensitivity: 'normal',
          approvedBy: actor.personId,
          explicit: true,
          // The sentence the router wrote when it chose this room, not a fresh one.
          ...(proposal.motivation ? { motivation: proposal.motivation } : {}),
          supersedes: acrossAuthors ? null : conflicting?.id ?? null,
          previousBody: acrossAuthors ? null : conflicting?.body ?? null,
        },
        tx,
      );

      if (conflicting && conflicting.status === 'active') {
        if (acrossAuthors) {
          await this.raiseDispute(tx, actor, conflicting, item, room);
        } else {
          await this.supersede(tx, actor, { loser: conflicting, winner: item });
        }
      }

      return item;
    });
  }

  private async write(
    actor: Actor,
    input: {
      roomId: RoomId;
      kind: ItemKind;
      body: string;
      sensitivity: Sensitivity;
      approvedBy?: PersonId;
      supersedes?: ItemId | null;
      previousBody?: string | null;
      explicit?: boolean;
      motivation?: string;
      source?: MemorySource;
      sharedFrom?: { itemId: ItemId; shortId: ShortId; roomId: RoomId } | null;
      sharedWith?: SharedWith[] | null;
      eventType?: 'item.created' | 'item.shared';
    },
    db: Db = this.pool,
  ): Promise<Item> {
    const shortId = generateShortId() as ShortId;
    const tokenEstimate = estimateTokens(input.body);
    const salience = BASE_SALIENCE[input.kind];
    const hash = dedupeHash(input.body);
    const room = await this.room(input.roomId, db);
    const explicit = input.explicit ?? input.approvedBy !== undefined;

    // `placement_explicit` is what the shared-room trigger checks. An insert without it
    // into a room other people read is refused by the database, which is the point: the
    // policy gate above can be bypassed by a new code path, and this cannot.
    const row = await this.translatingPlacementRefusal(() =>
      queryOne<ItemRow>(
        db,
        `INSERT INTO app.item (short_id, room_id, kind, body, sensitivity, salience, token_estimate,
                               dedupe_hash, author_person_id, author_client_id, placement_explicit)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
         RETURNING ${ITEM_COLUMNS}`,
        [
          shortId,
          input.roomId,
          input.kind,
          input.body,
          input.sensitivity,
          salience,
          tokenEstimate,
          hash,
          actor.personId,
          actor.clientId ?? null,
          explicit,
        ],
      ),
    );
    const item = mapItem(row!);

    if (input.supersedes) {
      await db.query(`UPDATE app.item SET superseded_by = $1 WHERE id = $2`, [item.id, input.supersedes]);
    }

    const kind: MemoryEventKind = input.sharedFrom
      ? 'shared'
      : input.supersedes
        ? 'updated'
        : room.kind === 'personal'
          ? 'saved_private'
          : 'saved_to_room';

    await appendEvent(db, {
      roomId: input.roomId,
      eventType: input.eventType ?? 'item.created',
      payload: {
        item_id: item.id,
        short_id: item.shortId,
        kind: item.kind,
        body: item.body,
        ...(input.supersedes ? { supersedes: input.supersedes } : {}),
        ...(input.previousBody ? { previous: input.previousBody } : {}),
        ...(input.sharedFrom
          ? { origin_item: input.sharedFrom.itemId, origin_short_id: input.sharedFrom.shortId }
          : {}),
        ...(input.sharedWith ? { shared_with: input.sharedWith } : {}),
      },
      actorPersonId: actor.personId,
      agentClient: actor.agentClient,
      clientId: actor.clientId ?? null,
      // The thread from a memory back to the conversation it came out of. The column has
      // existed since 0001 and nothing filled it, so the chain broke at the first link.
      sessionRef: actor.sessionId,
      approvedBy: input.approvedBy ?? null,
      explicit,
      motivation:
        input.motivation ??
        deriveMotivation({
          kind,
          itemKind: input.kind,
          roomTitle: room.title,
          roomKind: room.kind,
          ...(input.sharedFrom
            ? { fromRoomTitle: (await this.room(input.sharedFrom.roomId, db)).title }
            : {}),
          explicit,
        }),
      source: input.source ?? this.sourceFor(actor),
      ...(input.sharedFrom ? { fromRoomId: input.sharedFrom.roomId, toRoomId: input.roomId } : {}),
    });

    await this.markStale(input.roomId, actor);
    await this.queueEmbedding(item.id);
    return item;
  }

  private async applyUpdate(
    actor: Actor,
    item: Item,
    next: string,
    provenance: WriteProvenance,
    approvedBy?: PersonId,
  ): Promise<Item> {
    const room = await this.room(item.roomId);

    await withTransaction(this.pool, async (tx) => {
      await tx.query(`UPDATE app.item SET body = $1, token_estimate = $2 WHERE id = $3`, [
        next,
        estimateTokens(next),
        item.id,
      ]);

      await appendEvent(tx, {
        roomId: item.roomId,
        eventType: 'item.updated',
        payload: { item_id: item.id, short_id: item.shortId, body: next, previous: item.body },
        actorPersonId: actor.personId,
        agentClient: actor.agentClient,
        clientId: actor.clientId ?? null,
        sessionRef: actor.sessionId,
        approvedBy: approvedBy ?? null,
        explicit: true,
        motivation:
          provenance.motivation ??
          deriveMotivation({ kind: 'updated', roomTitle: room.title, roomKind: room.kind }),
        source: provenance.source ?? this.sourceFor(actor),
      });
    });

    await this.markStale(item.roomId, actor);
    // The body changed, so the stored embedding now describes text that is gone. Queued
    // here rather than in `update`, because this is the method the body actually changes
    // in — an edit that went to the approval queue instead has nothing to re-embed yet.
    await this.queueEmbedding(item.id);
    return { ...item, body: next, tokenEstimate: estimateTokens(next) };
  }

  /**
   * Replacement, as an event rather than a side effect.
   *
   * The one operation that removes information from the current state used to be the one
   * operation the log did not record: a bare `UPDATE ... SET status = 'superseded'`.
   * `item.superseded` was in the view, the status enum and the history mapping, and was
   * never written. It is written here in the same transaction as the status change, with
   * both ids and the old text, which is what makes "historiken visar både den
   * ursprungliga uppgiften och korrigeringen" true rather than aspirational.
   */
  private async supersede(
    db: Db,
    actor: Actor,
    input: { loser: Item; winner: Item; resolution?: string },
  ): Promise<void> {
    const { loser, winner } = input;

    await db.query(
      `UPDATE app.item SET status = 'superseded', valid_to = now(), superseded_by = $1
       WHERE id = $2 AND status = 'active'`,
      [winner.id, loser.id],
    );

    await appendEvent(db, {
      roomId: loser.roomId,
      eventType: 'item.superseded',
      payload: {
        item_id: loser.id,
        short_id: loser.shortId,
        superseded_by: winner.id,
        supersedes: loser.id,
        previous: loser.body,
        body: winner.body,
        ...(input.resolution ? { resolution: input.resolution } : {}),
      },
      actorPersonId: actor.personId,
      agentClient: actor.agentClient,
      clientId: actor.clientId ?? null,
      sessionRef: actor.sessionId,
      approvedBy: actor.personId,
      explicit: true,
      motivation: input.resolution
        ? `Avgjort: ${winner.shortId} gäller.`
        : `Ersattes av ${winner.shortId} efter ditt godkännande.`,
    });
  }

  /** Links two statements as incompatible. Neither wins and neither is hidden. */
  private async raiseDispute(
    db: Db,
    actor: Actor,
    existing: Item,
    incoming: Item,
    room: Room,
  ): Promise<void> {
    await db.query(
      `UPDATE app.item
       SET disputed_by = (
         SELECT array_agg(DISTINCT x) FROM unnest(disputed_by || $2::uuid[]) AS x
       )
       WHERE id = $1`,
      [existing.id, [incoming.id]],
    );
    await db.query(
      `UPDATE app.item
       SET disputed_by = (
         SELECT array_agg(DISTINCT x) FROM unnest(disputed_by || $2::uuid[]) AS x
       )
       WHERE id = $1`,
      [incoming.id, [existing.id]],
    );

    const names = await queryRows<{ id: string; display_name: string | null }>(
      db,
      `SELECT id, display_name FROM app.person WHERE id = ANY($1::uuid[])`,
      [[existing.authorPersonId, incoming.authorPersonId]],
    );
    const nameOf = (personId: PersonId): string | null =>
      names.find((n) => n.id === personId)?.display_name ?? null;

    await appendEvent(db, {
      roomId: incoming.roomId,
      eventType: 'item.disputed',
      payload: {
        item_id: incoming.id,
        short_id: incoming.shortId,
        disputed_by: existing.id,
        body: incoming.body,
        reason: 'två medlemmar har skrivit uppgifter som inte kan stämma samtidigt',
        disputes: [
          {
            short_id: existing.shortId,
            body: existing.body,
            author_name: nameOf(existing.authorPersonId),
          },
          {
            short_id: incoming.shortId,
            body: incoming.body,
            author_name: nameOf(incoming.authorPersonId),
          },
        ],
      },
      actorPersonId: actor.personId,
      agentClient: actor.agentClient,
      clientId: actor.clientId ?? null,
      sessionRef: actor.sessionId,
      explicit: true,
      motivation: deriveMotivation({
        kind: 'disputed',
        roomTitle: room.title,
        roomKind: room.kind,
      }),
    });
  }

  private async unlinkDispute(db: Db, a: ItemId, b: ItemId): Promise<void> {
    await db.query(
      `UPDATE app.item SET disputed_by = array_remove(disputed_by, $2::uuid) WHERE id = $1`,
      [a, b],
    );
    await db.query(
      `UPDATE app.item SET disputed_by = array_remove(disputed_by, $2::uuid) WHERE id = $1`,
      [b, a],
    );
  }

  /** The share itself, once confirmed or approved. */
  private async placeShare(
    actor: Actor,
    source: Item,
    target: Room,
    motivation?: string,
    approvedBy?: PersonId,
  ): Promise<{ outcome: 'placed'; item: Item; event: MemoryEvent }> {
    // Recorded, never recomputed: who could read it at the moment it was shared is a
    // fact about that moment, and membership changes afterwards.
    const members = await queryRows<{ person_id: string; display_name: string | null; role: SharedWith['role'] }>(
      this.pool,
      `SELECT m.person_id, p.display_name, m.role
       FROM app.membership m
       LEFT JOIN app.person p ON p.id = m.person_id
       WHERE m.room_id = $1 AND m.left_at IS NULL`,
      [target.id],
    );

    const sharedWith: SharedWith[] = members.map((m) => ({
      personId: m.person_id as PersonId,
      name: m.display_name,
      role: m.role,
    }));

    const item = await this.write(actor, {
      roomId: target.id,
      kind: source.kind,
      body: source.body,
      sensitivity: source.sensitivity,
      explicit: true,
      eventType: 'item.shared',
      sharedFrom: { itemId: source.id, shortId: source.shortId, roomId: source.roomId },
      sharedWith,
      ...(approvedBy ? { approvedBy } : {}),
      ...(motivation ? { motivation } : {}),
    });

    const event = await queryOne<EventRow>(
      this.pool,
      `SELECT ${EVENT_COLUMNS} FROM app.event
       WHERE event_type = 'item.shared' AND (payload ->> 'item_id') = $1
       ORDER BY seq DESC LIMIT 1`,
      [item.id],
    );

    return { outcome: 'placed', item, event: mapEvent(event!) };
  }

  private async resolvePlacement(
    actor: Actor,
    input: { shortId: ShortId; fromRoomId?: RoomId; toRoomId: RoomId },
  ): Promise<{ item: Item; target: Room }> {
    const item = await this.findInScope(
      actor,
      input.shortId,
      input.fromRoomId ? [input.fromRoomId] : undefined,
    );
    if (!item || item.status === 'deleted') throw new NotFoundError('Minnet finns inte.');

    if (!(await canWrite(this.pool, actor.personId, input.toRoomId))) {
      throw new NotFoundError('Rummet finns inte.');
    }
    const target = await this.room(input.toRoomId);

    await this.assertMayRemove(
      actor,
      item,
      'Bara den som skrev uppgiften kan flytta eller dela den.',
    );
    return { item, target };
  }

  /** The author owns their contribution; the owner tidies the room. See `canRemoveMemory`. */
  private async assertMayRemove(actor: Actor, item: Item, message?: string): Promise<void> {
    const role = await roleIn(this.pool, actor.personId, item.roomId);
    if (!role) throw new NotPermittedError();

    if (!canRemoveMemory({ role, isAuthor: item.authorPersonId === actor.personId })) {
      throw new NotPermittedError(
        message ??
          'Bara den som skrev uppgiften, eller rummets ägare, kan ta bort den. Du kan bestrida den i stället.',
      );
    }
  }

  private sourceFor(
    actor: Actor,
    extra: { documentId?: string | null; documentName?: string | null; importedFrom?: string | null } = {},
  ): MemorySource {
    return deriveSource({
      agentClient: actor.agentClient,
      sessionRef: actor.sessionId,
      ...extra,
    });
  }

  /**
   * Turns the placement trigger's refusal into the domain error the API layer expects.
   *
   * The trigger raises `insufficient_privilege` because the write is not permitted, which
   * is exactly what a 403 is. Letting the raw driver error through would surface the
   * guarantee as a 500 and read like a bug rather than the rule working.
   */
  private async translatingPlacementRefusal<T>(run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (error) {
      if ((error as { code?: string }).code === '42501') {
        throw new NotPermittedError(
          'Automatik får inte lägga minnen i ett delat rum. Delning är alltid en uttrycklig handling.',
        );
      }
      throw error;
    }
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
    input: {
      roomId: RoomId;
      intent: ProposalIntent;
      kind: ItemKind;
      body: string;
      reason: string;
      conflictsWith: ItemId | null;
      sourceItemId?: ItemId;
      motivation?: string;
      importedFrom?: string;
    },
  ): Promise<Proposal> {
    const row = await queryOne<ProposalRow>(
      this.pool,
      `INSERT INTO app.proposal (room_id, person_id, intent, kind, body, reason, motivation,
                                 conflicts_with, source_item, proposed_by_client)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING ${PROPOSAL_COLUMNS}`,
      [
        input.roomId,
        actor.personId,
        input.intent,
        input.kind,
        input.body,
        input.reason,
        input.motivation ?? null,
        input.conflictsWith,
        input.sourceItemId ?? null,
        actor.agentClient,
      ],
    );
    const proposal = mapProposal(row!);

    await appendEvent(this.pool, {
      roomId: input.roomId,
      eventType: 'proposal.created',
      payload: {
        proposal_id: proposal.id,
        body: input.body,
        kind: input.kind,
        reason: input.reason,
        intent: input.intent,
      },
      actorPersonId: actor.personId,
      agentClient: actor.agentClient,
      clientId: actor.clientId ?? null,
      sessionRef: actor.sessionId,
      motivation: input.motivation ?? null,
      source: this.sourceFor(actor, {
        ...(input.importedFrom ? { importedFrom: input.importedFrom } : {}),
      }),
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

  private async findById(id: ItemId): Promise<Item | null> {
    const row = await queryOne<ItemRow>(
      this.pool,
      `SELECT ${ITEM_COLUMNS} FROM app.item WHERE id = $1`,
      [id],
    );
    return row ? mapItem(row) : null;
  }

  /**
   * Resolves a short id inside the rooms the actor can reach.
   *
   * Scoped rather than global, because a short id is four characters: unique enough to
   * name one of a person's own memories and nowhere near unique enough to be safe as a
   * global handle.
   */
  private async findInScope(
    actor: Actor,
    shortId: ShortId,
    rooms?: RoomId[],
  ): Promise<Item | null> {
    const row = await queryOne<ItemRow>(
      this.pool,
      `SELECT ${ITEM_COLUMNS} FROM app.item
       WHERE short_id = $1
         AND room_id = ANY (COALESCE($3::uuid[], (SELECT array_agg(room_id) FROM app.accessible_room_ids($2))))`,
      [shortId, actor.personId, rooms ?? null],
    );
    return row ? mapItem(row) : null;
  }

  private async room(roomId: RoomId, db: Db = this.pool): Promise<Room> {
    const row = await queryOne<RoomRow>(
      db,
      `SELECT id, kind, slug, title, description, sensitivity, created_by, created_at, archived_at
       FROM app.room WHERE id = $1`,
      [roomId],
    );
    if (!row) throw new NotFoundError('Rummet finns inte.');
    return mapRoom(row);
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
