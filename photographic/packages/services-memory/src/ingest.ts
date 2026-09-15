/**
 * The write path.
 *
 * Two requirements pull in opposite directions here. Saving has to be silent, or the
 * product is a nagging form and nobody uses it. And the personal profile has to stay
 * trustworthy, or every connected model inherits the same wrong belief and the person
 * cannot work out why. The three tiers in `WriteDecision` are how both hold at once:
 * small concrete facts land immediately, anything that changes behaviour or contradicts
 * what is already known waits for a yes, and restatements cost nothing.
 *
 * The asymmetry that justifies leaning towards `auto` is that deletion is cheap and
 * reversible for thirty days. Removing the trash would mean revisiting this policy.
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
  Sensitivity,
  SharedWith,
  ShortId,
  UpdateDecision,
  WriteDecision,
  WriteProvenance,
} from '@photographic/core';
import { NotFoundError, NotPermittedError, ValidationError } from '@photographic/core';
import {
  canRemoveMemory,
  dedupeHash,
  deriveMotivation,
  deriveSource,
  estimateTokens,
  generateShortId,
  purgeDeadline,
  requiresApproval,
} from '@photographic/core';

import { MemoryStore, newId } from './store.js';

/** Ceiling on a single memory. Longer than this is a document, not a fact. */
export const MAX_BODY_CHARS = 2000;

/**
 * Starting salience by kind.
 *
 * This is the order things are dropped in when the profile hits its ceiling, so it is a
 * statement about what matters: who someone is and how they want to be treated outlive
 * a decision taken in a meeting last month.
 */
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

/**
 * Guesses what a sentence is when the caller did not say.
 *
 * Deliberately conservative about `instruction`: that kind forces an approval step, so
 * over-guessing it makes the product feel like it asks about everything, while
 * under-guessing it lets behaviour change land silently. Instruction wins only on a
 * clear imperative, and the model is told in the tool description to pass `kind`
 * explicitly when it knows.
 */
export function classifyKind(body: string): ItemKind {
  if (INSTRUCTION_HINTS.test(body) && /\b(du|you|svara|answer|utmana|challenge)\b/i.test(body)) {
    return 'instruction';
  }
  if (DECISION_HINTS.test(body)) return 'decision';
  if (IDENTITY_HINTS.test(body)) return 'identity';
  if (PREFERENCE_HINTS.test(body)) return 'preference';
  return 'fact';
}

export class MemoryIngest implements IngestPort {
  constructor(
    private readonly store: MemoryStore,
    private readonly llm: LlmPort,
    private readonly projection: ProjectionPort,
    private readonly jobs: JobPort,
  ) {}

  async remember(
    actor: Actor,
    input: {
      roomId: RoomId;
      body: string;
      kind?: ItemKind;
      sensitivity?: 'normal' | 'sensitive';
      explicit?: boolean;
    } & WriteProvenance,
  ): Promise<WriteDecision> {
    if (!this.store.canWrite(actor.personId, input.roomId)) throw new NotPermittedError();

    const body = input.body.trim().replace(/\s+/g, ' ');
    if (!body) throw new ValidationError('Tomt minne kan inte sparas.');
    if (body.length > MAX_BODY_CHARS) {
      throw new ValidationError('För långt för att sparas som ett minne. Ladda upp det som dokument.');
    }

    const kind = input.kind ?? classifyKind(body);
    const sensitivity = input.sensitivity ?? 'normal';
    const room = this.store.rooms.get(input.roomId)!;
    const siblings = this.store
      .itemsInRoom(input.roomId)
      .filter((i) => i.status === 'active');

    // Exact restatement first, because it is the common case and needs no model call:
    // two AIs independently saving the same allergy must not consume two profile slots.
    const hash = dedupeHash(body);
    const identical = siblings.find((i) => dedupeHash(i.body) === hash);
    if (identical) return { outcome: 'duplicate', existing: this.bumpSalience(identical) };

    // Only compare against plausible neighbours. Comparing against everything is what
    // makes this path cost a model call per existing memory as a profile grows.
    let contradicts = false;
    let conflicting: ItemId | null = null;
    for (const sibling of this.neighbours(body, siblings)) {
      const verdict = await this.llm.compare(body, sibling.body);
      if (verdict === 'same') {
        return { outcome: 'duplicate', existing: this.bumpSalience(sibling) };
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

    if (gate.required) {
      return {
        outcome: 'needs_approval',
        proposal: this.queueProposal(actor, {
          roomId: input.roomId,
          intent: 'remember',
          kind,
          body,
          reason: gate.reason,
          conflictsWith: conflicting,
          ...(input.motivation ? { motivation: input.motivation } : {}),
        }),
      };
    }

    const item = await this.write(actor, {
      roomId: input.roomId,
      kind,
      body,
      sensitivity,
      explicit: input.explicit ?? false,
      ...(input.motivation ? { motivation: input.motivation } : {}),
      ...(input.source ? { source: input.source } : {}),
    });

    return { outcome: 'auto', item };
  }

  /**
   * The import path: always a proposal, never a write.
   *
   * Deliberately skips the tiering in `remember`. A fact that would have been saved
   * silently mid-conversation had a person in the loop saying it out loud; the same
   * sentence arriving in a paste of someone's ChatGPT memory list has no such evidence
   * behind it, and bulk-importing another system's guesses as established fact is how
   * the profile stops being trustworthy on day one.
   */
  async propose(
    actor: Actor,
    input: { roomId: RoomId; body: string; kind?: ItemKind; reason?: string; source?: string },
  ): Promise<Proposal> {
    if (!this.store.canWrite(actor.personId, input.roomId)) throw new NotPermittedError();

    const body = input.body.trim().replace(/\s+/g, ' ');
    if (!body) throw new ValidationError('Tomt förslag kan inte sparas.');

    const kind = input.kind ?? classifyKind(body);
    const siblings = this.store.itemsInRoom(input.roomId).filter((i) => i.status === 'active');
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

  /**
   * Edits a memory, through the same gate as every other write.
   *
   * This used to be the one write that skipped `requiresApproval` completely, which made
   * it the cheapest way to change what a shared room says: do not save anything, rewrite
   * something already there. Same gate now, so in a shared room an edit queues.
   */
  async update(
    actor: Actor,
    shortId: ShortId,
    roomId: RoomId,
    body: string,
    provenance: WriteProvenance = {},
  ): Promise<UpdateDecision> {
    if (!this.store.canWrite(actor.personId, roomId)) throw new NotPermittedError();

    const item = this.store.findByShortId(actor.personId, shortId, roomId);
    if (!item || item.status === 'deleted') throw new NotFoundError('Minnet finns inte.');

    const next = body.trim().replace(/\s+/g, ' ');
    if (!next) throw new ValidationError('Tomt minne kan inte sparas.');

    const room = this.store.rooms.get(item.roomId)!;
    const gate = requiresApproval({
      kind: item.kind,
      body: next,
      // An edit names one memory by id, so there is nothing ambiguous about what it
      // replaces. The contradiction gate is about a *new* claim landing beside an old one.
      contradicts: false,
      explicit: true,
      roomIsShared: room.kind === 'shared',
      sensitivity: item.sensitivity,
    });

    if (gate.required) {
      return {
        outcome: 'needs_approval',
        proposal: this.queueProposal(actor, {
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

  /**
   * Soft delete, always.
   *
   * This is the single most dangerous thing a model can do on someone's behalf, and the
   * only reason it is safe to do it without a confirmation is that it is undoable for
   * thirty days. The undo token lets the model offer "say undo" in the same breath,
   * so the recovery path does not require opening the app.
   */
  async forget(
    actor: Actor,
    shortId: ShortId,
    roomId: RoomId,
    reason?: string,
  ): Promise<{ item: Item; undoToken: string }> {
    if (!this.store.canWrite(actor.personId, roomId)) throw new NotPermittedError();

    const item = this.store.findByShortId(actor.personId, shortId, roomId);
    if (!item) throw new NotFoundError('Minnet finns inte.');
    if (item.status === 'deleted') {
      throw new ValidationError('Minnet ligger redan i papperskorgen.');
    }
    this.assertMayRemove(actor, item);

    return this.softDelete(actor, item, reason);
  }

  async undo(actor: Actor, undoToken: string): Promise<Item> {
    const itemId = this.store.undoTokens.get(undoToken);
    const item = itemId ? this.store.items.get(itemId) : undefined;
    if (!item) throw new NotFoundError('Det finns inget att ta tillbaka.');
    if (!this.store.canWrite(actor.personId, item.roomId)) throw new NotPermittedError();

    this.store.undoTokens.delete(undoToken);
    return this.restore(actor, item);
  }

  /**
   * Puts a copy of a memory into another room.
   *
   * Copies rather than relocates, and that is the point. A private memory that has been
   * shared exists twice: once in the personal room, still private, and once in the shared
   * room where other people read it. Moving it would mean the personal memory is now
   * visible to a room, which the first section of the scope says can never happen.
   */
  async share(
    actor: Actor,
    input: {
      shortId: ShortId;
      fromRoomId?: RoomId;
      toRoomId: RoomId;
      confirmed?: boolean;
    } & WriteProvenance,
  ): Promise<PlacementDecision> {
    const { item, target } = this.resolvePlacement(actor, input);

    if (!input.confirmed) {
      return {
        outcome: 'needs_approval',
        proposal: this.queueProposal(actor, {
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
    const { item, target } = this.resolvePlacement(actor, input);
    const origin = this.store.rooms.get(item.roomId)!;

    if (origin.id === target.id) {
      throw new ValidationError(`${item.shortId} ligger redan i ${target.title}.`);
    }

    // Moving *into* a shared room is a sharing act and needs the same yes.
    if (target.kind === 'shared' && !input.confirmed) {
      return {
        outcome: 'needs_approval',
        proposal: this.queueProposal(actor, {
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

    this.store.assertPlacementAllowed(target.id, true);

    const motivation =
      input.motivation ??
      deriveMotivation({
        kind: 'moved',
        roomTitle: target.title,
        roomKind: target.kind,
        fromRoomTitle: origin.title,
      });

    item.roomId = target.id;

    // Appended to the room it arrived in, so the receiving room's day shows it turning
    // up. `from_room_id` is what makes it readable as a move rather than a save.
    const event = this.store.append({
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
      source: this.sourceFor(actor, {}),
    });

    await this.markStale(origin.id, actor);
    await this.markStale(target.id, actor);
    return { outcome: 'placed', item, event };
  }

  async listProposals(actor: Actor): Promise<Proposal[]> {
    return [...this.store.proposals.values()]
      .filter((p) => p.personId === actor.personId && p.status === 'pending')
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  }

  async listDisputes(actor: Actor): Promise<Dispute[]> {
    const rooms = new Set(this.store.accessibleRoomIds(actor.personId));
    const seen = new Set<string>();
    const disputes: Dispute[] = [];

    for (const item of this.store.items.values()) {
      if (!rooms.has(item.roomId) || item.disputedBy.length === 0) continue;

      for (const otherId of item.disputedBy) {
        const other = this.store.items.get(otherId);
        if (!other) continue;

        // One entry per pair, not two: the link is symmetric and the queue is a list of
        // disagreements, not of statements involved in one.
        const key = [item.id, other.id].sort().join(':');
        if (seen.has(key)) continue;
        seen.add(key);

        const sides = [item, other]
          .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
          .map((side) => ({
            shortId: side.shortId,
            itemId: side.id,
            body: side.body,
            authorPersonId: side.authorPersonId,
            authorName: this.store.persons.get(side.authorPersonId)?.displayName ?? null,
            writtenAt: side.createdAt,
          }));

        disputes.push({
          roomId: item.roomId,
          roomTitle: this.store.rooms.get(item.roomId)?.title ?? '',
          sides,
          raisedAt: sides[1]!.writtenAt,
          reason: 'Två medlemmar har skrivit uppgifter som inte kan stämma samtidigt.',
        });
      }
    }

    return disputes.sort((a, b) => b.raisedAt.getTime() - a.raisedAt.getTime());
  }

  /**
   * Settles a disagreement by naming the side that stands.
   *
   * Only the author of the losing side or an owner of the room. No model, ever: there is
   * no tool for this and there will not be one, because a model choosing between two
   * people's accounts of the same thing is the failure this whole mechanism exists to
   * avoid. The loser is superseded by the winner through the ordinary path, so there is
   * still exactly one way for something to leave the current state.
   */
  async resolveDispute(
    actor: Actor,
    input: { winnerShortId: ShortId; loserShortId: ShortId; roomId?: RoomId; resolution?: string },
  ): Promise<Item> {
    const winner = this.store.findByShortId(actor.personId, input.winnerShortId, input.roomId);
    const loser = this.store.findByShortId(actor.personId, input.loserShortId, input.roomId);
    if (!winner || !loser) throw new NotFoundError('Minnet finns inte.');
    if (winner.roomId !== loser.roomId) throw new ValidationError('Uppgifterna ligger inte i samma rum.');
    if (!loser.disputedBy.includes(winner.id)) {
      throw new ValidationError('De här två uppgifterna är inte omtvistade.');
    }

    const role = this.store.roleIn(actor.personId, loser.roomId);
    if (role !== 'owner' && loser.authorPersonId !== actor.personId) {
      throw new NotPermittedError(
        'Bara den som skrev uppgiften eller rummets ägare kan avgöra en tvist.',
      );
    }

    this.unlinkDispute(winner, loser);
    this.supersede(actor, {
      loser,
      winner,
      resolution: input.resolution ?? 'avgjord av en människa',
    });

    this.store.append({
      roomId: loser.roomId,
      eventType: 'item.dispute_resolved',
      payload: {
        item_id: loser.id,
        short_id: loser.shortId,
        disputed_by: winner.id,
        winner_item_id: winner.id,
        resolution: input.resolution ?? 'avgjord av en människa',
      },
      actorPersonId: actor.personId,
      agentClient: actor.agentClient,
      clientId: actor.clientId ?? null,
      sessionRef: actor.sessionId,
      explicit: true,
      motivation: `${winner.shortId} gäller; ${loser.shortId} ersattes.`,
    });

    await this.markStale(loser.roomId, actor);
    return winner;
  }

  async resolveProposal(actor: Actor, id: ProposalId, accept: boolean): Promise<Item | null> {
    const proposal = this.store.proposals.get(id);
    if (!proposal || proposal.personId !== actor.personId) {
      throw new NotFoundError('Förslaget finns inte.');
    }
    if (proposal.status !== 'pending') throw new ValidationError('Förslaget är redan hanterat.');

    if (!accept) {
      proposal.status = 'rejected';
      this.store.append({
        roomId: proposal.roomId,
        eventType: 'proposal.rejected',
        payload: { proposal_id: proposal.id, body: proposal.body },
        actorPersonId: actor.personId,
        agentClient: actor.agentClient,
        clientId: actor.clientId ?? null,
      });
      return null;
    }

    proposal.status = 'accepted';

    const resulting = await this.applyProposal(actor, proposal);

    this.store.append({
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

  /**
   * What accepting a proposal actually does, per intent.
   *
   * Three outcomes, and the interesting one is a contradiction. Within one author it is a
   * correction and the old value is superseded — the 15 oktober becoming 1 november case
   * the scope describes. Across two authors in a shared room it is a *disagreement*, and
   * superseding would mean anyone in the room can quietly overwrite anyone else, with the
   * other person finding out when their own AI answers wrongly. Both statements stay, and
   * a person decides.
   */
  private async applyProposal(actor: Actor, proposal: Proposal): Promise<Item> {
    if (proposal.intent === 'share') {
      const source = proposal.sourceItemId ? this.store.items.get(proposal.sourceItemId) : undefined;
      if (!source) throw new NotFoundError('Minnet som skulle delas finns inte längre.');
      const target = this.store.rooms.get(proposal.roomId);
      if (!target) throw new NotFoundError('Rummet finns inte.');

      const placed = await this.placeShare(actor, source, target, undefined, actor.personId);
      return placed.item;
    }

    if (proposal.intent === 'update') {
      const target = proposal.sourceItemId ? this.store.items.get(proposal.sourceItemId) : undefined;
      if (!target) throw new NotFoundError('Minnet som skulle ändras finns inte längre.');
      return this.applyUpdate(actor, target, proposal.body, {}, actor.personId);
    }

    const conflicting = proposal.conflictsWith
      ? this.store.items.get(proposal.conflictsWith) ?? null
      : null;
    const room = this.store.rooms.get(proposal.roomId)!;
    const acrossAuthors =
      conflicting !== null &&
      room.kind === 'shared' &&
      conflicting.authorPersonId !== actor.personId;

    const item = await this.write(actor, {
      roomId: proposal.roomId,
      kind: proposal.kind,
      body: proposal.body,
      sensitivity: 'normal',
      approvedBy: actor.personId,
      explicit: true,
      // A disputed pair supersedes nothing, so the new memory is not a correction and
      // must not be recorded as one.
      supersedes: acrossAuthors ? null : conflicting?.id ?? null,
      previousBody: acrossAuthors ? null : conflicting?.body ?? null,
    });

    if (conflicting && conflicting.status === 'active') {
      if (acrossAuthors) {
        this.raiseDispute(actor, conflicting, item);
      } else {
        this.supersede(actor, { loser: conflicting, winner: item });
      }
    }

    return item;
  }

  // -------------------------------------------------------------------------
  // Shared with the trash, which reverses what happens here
  // -------------------------------------------------------------------------

  /** Used by both `undo` and `TrashPort.restore`, so the two cannot drift apart. */
  async restore(actor: Actor, item: Item): Promise<Item> {
    if (item.status !== 'deleted') return item;

    item.status = 'active';
    item.deletedAt = null;
    item.deletedBy = null;
    item.deletedByClient = null;
    item.purgeAfter = null;
    item.deleteReason = null;

    this.store.append({
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
        roomTitle: this.store.rooms.get(item.roomId)?.title ?? '',
        roomKind: this.store.rooms.get(item.roomId)?.kind ?? 'personal',
      }),
    });

    await this.markStale(item.roomId, actor);
    return item;
  }

  /**
   * Moves a memory to the trash. Shared by `forget` and by "ta bort mina bidrag".
   *
   * Leaving a room offers this deliberately rather than doing it silently, so the other
   * members see `item.deleted` with a motivation and an owner can undo it for thirty
   * days. A quiet mass deletion of someone's contributions is exactly the thing the
   * event log exists to make impossible.
   */
  async softDelete(
    actor: Actor,
    item: Item,
    reason?: string,
  ): Promise<{ item: Item; undoToken: string }> {
    const now = this.store.now();
    const undoToken = randomBytes(16).toString('base64url');
    const room = this.store.rooms.get(item.roomId);

    item.status = 'deleted';
    item.deletedAt = now;
    item.deletedBy = actor.personId;
    item.deletedByClient = actor.agentClient;
    item.purgeAfter = purgeDeadline(now);
    item.deleteReason = reason?.trim() || null;
    this.store.undoTokens.set(undoToken, item.id);

    this.store.append({
      roomId: item.roomId,
      eventType: 'item.deleted',
      payload: { item_id: item.id, short_id: item.shortId, body: item.body },
      actorPersonId: actor.personId,
      agentClient: actor.agentClient,
      clientId: actor.clientId ?? null,
      sessionRef: actor.sessionId,
      explicit: true,
      // The person's own phrasing when they gave one. It is what makes the trash readable
      // a week later: "borttaget" against forty rows is a list to re-derive.
      motivation:
        reason?.trim() ||
        deriveMotivation({
          kind: 'deleted',
          roomTitle: room?.title ?? '',
          roomKind: room?.kind ?? 'personal',
        }),
    });

    await this.markStale(item.roomId, actor);
    return { item, undoToken };
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private async write(
    actor: Actor,
    input: {
      roomId: RoomId;
      kind: ItemKind;
      body: string;
      sensitivity: Sensitivity;
      approvedBy?: PersonId;
      supersedes?: ItemId | null;
      /** What the superseded memory said, kept on the event that replaced it. */
      previousBody?: string | null;
      explicit?: boolean;
      motivation?: string;
      source?: MemorySource;
      /** Set when the memory arrived by being shared into this room. */
      sharedFrom?: { itemId: ItemId; shortId: ShortId; roomId: RoomId } | null;
      sharedWith?: SharedWith[] | null;
      eventType?: 'item.created' | 'item.shared';
    },
  ): Promise<Item> {
    const now = this.store.now();
    const room = this.store.rooms.get(input.roomId)!;
    const explicit = input.explicit ?? input.approvedBy !== undefined;

    const item: Item = {
      id: newId<ItemId>(),
      shortId: generateShortId() as ShortId,
      roomId: input.roomId,
      kind: input.kind,
      body: input.body,
      structured: {},
      sensitivity: input.sensitivity,
      status: 'active',
      validFrom: now,
      validTo: null,
      supersededBy: null,
      salience: BASE_SALIENCE[input.kind],
      tokenEstimate: estimateTokens(input.body),
      lastUsedAt: null,
      useCount: 0,
      createdAt: now,
      authorPersonId: actor.personId,
      authorClientId: actor.clientId ?? null,
      disputedBy: [],
      deletedAt: null,
      deletedBy: null,
      deletedByClient: null,
      purgeAfter: null,
      deleteReason: null,
    };

    // The storage-level guarantee, checked before the row exists rather than after.
    this.store.put(item, explicit);
    this.store.embeddings.set(item.id, (await this.llm.embed([input.body]))[0]!);

    if (input.supersedes) {
      const old = this.store.items.get(input.supersedes);
      if (old) old.supersededBy = item.id;
    }

    const eventType = input.eventType ?? 'item.created';
    const kind: MemoryEventKind = input.sharedFrom
      ? 'shared'
      : input.supersedes
        ? 'updated'
        : room.kind === 'personal'
          ? 'saved_private'
          : 'saved_to_room';

    this.store.append({
      roomId: input.roomId,
      eventType,
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
      // existed since 0001 and nothing filled it, so the chain was broken at the first link.
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
            ? { fromRoomTitle: this.store.rooms.get(input.sharedFrom.roomId)?.title ?? null }
            : {}),
          explicit,
        }),
      source: input.source ?? this.sourceFor(actor, {}),
      ...(input.sharedFrom ? { fromRoomId: input.sharedFrom.roomId, toRoomId: input.roomId } : {}),
    });

    await this.markStale(input.roomId, actor);
    return item;
  }

  /** The edit itself, once the gate has allowed it. */
  private async applyUpdate(
    actor: Actor,
    item: Item,
    next: string,
    provenance: WriteProvenance,
    approvedBy?: PersonId,
  ): Promise<Item> {
    const before = item.body;
    item.body = next;
    item.tokenEstimate = estimateTokens(next);
    this.store.embeddings.set(item.id, (await this.llm.embed([next]))[0]!);

    // The short id survives an edit on purpose: a person who said "change p-7k2m" is
    // still talking about p-7k2m afterwards.
    this.store.append({
      roomId: item.roomId,
      eventType: 'item.updated',
      payload: { item_id: item.id, short_id: item.shortId, body: next, previous: before },
      actorPersonId: actor.personId,
      agentClient: actor.agentClient,
      clientId: actor.clientId ?? null,
      sessionRef: actor.sessionId,
      approvedBy: approvedBy ?? null,
      explicit: true,
      motivation:
        provenance.motivation ??
        deriveMotivation({
          kind: 'updated',
          roomTitle: this.store.rooms.get(item.roomId)?.title ?? '',
          roomKind: this.store.rooms.get(item.roomId)?.kind ?? 'personal',
        }),
      source: provenance.source ?? this.sourceFor(actor, {}),
    });

    await this.markStale(item.roomId, actor);
    return item;
  }

  /**
   * Replacement, as an event rather than a side effect.
   *
   * The one operation that removes information from the current state used to be the one
   * operation the log did not record: ingest set `status = 'superseded'` and moved on.
   * `item.superseded` was in the view, the status enum and the history mapping, and was
   * never written. It is written here, in the same step as the status change, with both
   * ids and the old text — which is what makes "historiken visar både den ursprungliga
   * uppgiften och korrigeringen" true rather than aspirational.
   */
  private supersede(
    actor: Actor,
    input: { loser: Item; winner: Item; resolution?: string },
  ): void {
    const { loser, winner } = input;
    const previous = loser.body;

    loser.status = 'superseded';
    loser.validTo = this.store.now();
    loser.supersededBy = winner.id;

    this.store.append({
      roomId: loser.roomId,
      eventType: 'item.superseded',
      payload: {
        item_id: loser.id,
        short_id: loser.shortId,
        superseded_by: winner.id,
        supersedes: loser.id,
        previous,
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

  /**
   * Links two statements as incompatible. Neither wins and neither is hidden.
   *
   * Symmetric on purpose: a model asking about either one has to be told there are two,
   * and a queue listing disagreements should find them from whichever side it looks at.
   */
  private raiseDispute(actor: Actor, existing: Item, incoming: Item): void {
    if (!existing.disputedBy.includes(incoming.id)) existing.disputedBy.push(incoming.id);
    if (!incoming.disputedBy.includes(existing.id)) incoming.disputedBy.push(existing.id);

    const authorName = this.store.persons.get(existing.authorPersonId)?.displayName ?? null;
    const room = this.store.rooms.get(incoming.roomId)!;

    this.store.append({
      roomId: incoming.roomId,
      eventType: 'item.disputed',
      payload: {
        item_id: incoming.id,
        short_id: incoming.shortId,
        disputed_by: existing.id,
        body: incoming.body,
        reason: 'två medlemmar har skrivit uppgifter som inte kan stämma samtidigt',
        disputes: [
          { short_id: existing.shortId, body: existing.body, author_name: authorName },
          {
            short_id: incoming.shortId,
            body: incoming.body,
            author_name: this.store.persons.get(incoming.authorPersonId)?.displayName ?? null,
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

  private unlinkDispute(a: Item, b: Item): void {
    a.disputedBy = a.disputedBy.filter((id) => id !== b.id);
    b.disputedBy = b.disputedBy.filter((id) => id !== a.id);
  }

  /** The share itself, once confirmed or approved. */
  private async placeShare(
    actor: Actor,
    source: Item,
    target: Room,
    motivation?: string,
    approvedBy?: PersonId,
  ): Promise<{ outcome: 'placed'; item: Item; event: import('@photographic/core').MemoryEvent }> {
    // Recorded, never recomputed: who could read it at the moment it was shared is a fact
    // about that moment, and membership changes afterwards.
    const sharedWith: SharedWith[] = this.store.memberships
      .filter((m) => m.roomId === target.id && m.leftAt === null)
      .map((m) => ({
        personId: m.personId,
        name: this.store.persons.get(m.personId)?.displayName ?? null,
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

    const event = this.store
      .allEvents()
      .reverse()
      .find((e) => e.payload['item_id'] === item.id)!;

    return { outcome: 'placed', item, event };
  }

  /**
   * Resolves which memory and which room a placement is about, and refuses early.
   *
   * Write permission on the target is checked here rather than inside the storage guard,
   * so a person who cannot write to a room gets the same not-found as if it did not exist.
   */
  private resolvePlacement(
    actor: Actor,
    input: { shortId: ShortId; fromRoomId?: RoomId; toRoomId: RoomId },
  ): { item: Item; target: Room } {
    const item = this.store.findByShortId(actor.personId, input.shortId, input.fromRoomId);
    if (!item || item.status === 'deleted') throw new NotFoundError('Minnet finns inte.');

    const target = this.store.rooms.get(input.toRoomId);
    if (!target || !this.store.canWrite(actor.personId, input.toRoomId)) {
      throw new NotFoundError('Rummet finns inte.');
    }

    this.assertMayRemove(actor, item, 'Bara den som skrev uppgiften kan flytta eller dela den.');
    return { item, target };
  }

  /**
   * The author owns their contribution; the owner tidies the room.
   *
   * Everyone else disputes it, which is a different act with a different outcome. In a
   * shared room `forget` removes something for all five members on one person's
   * judgement, and that is not a correction — it is deleting someone else's work.
   */
  private assertMayRemove(actor: Actor, item: Item, message?: string): void {
    const role = this.store.roleIn(actor.personId, item.roomId);
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
    extra: { documentId?: string | null; documentName?: string | null; importedFrom?: string | null },
  ): MemorySource {
    return deriveSource({
      agentClient: actor.agentClient,
      sessionRef: actor.sessionId,
      ...extra,
    });
  }

  private queueProposal(
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
  ): Proposal {
    const proposal: Proposal = {
      id: newId<ProposalId>(),
      roomId: input.roomId,
      personId: actor.personId,
      intent: input.intent,
      kind: input.kind,
      body: input.body,
      reason: input.reason,
      conflictsWith: input.conflictsWith,
      sourceItemId: input.sourceItemId ?? null,
      proposedByClient: actor.agentClient,
      status: 'pending',
      createdAt: this.store.now(),
    };
    this.store.proposals.set(proposal.id, proposal);

    this.store.append({
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

  /**
   * A restatement is worth more than a first mention, not less.
   *
   * Salience decides what survives the profile ceiling, and something two different
   * models both thought worth saving is exactly what should outlast a one-off note.
   */
  private bumpSalience(item: Item): Item {
    item.salience = Math.min(1, item.salience + 0.05);
    item.useCount += 1;
    item.lastUsedAt = this.store.now();
    return item;
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

  /**
   * Marks projections stale and queues the rebuild, rather than rebuilding inline.
   *
   * Rebuilding here would put profile assembly on the latency path of every save, which
   * is the thing that makes a voice assistant feel broken.
   */
  private async markStale(roomId: RoomId, actor: Actor): Promise<void> {
    const room = this.store.rooms.get(roomId);
    const personId = room?.kind === 'personal' ? actor.personId : undefined;

    await this.projection.invalidate({ roomId, ...(personId ? { personId } : {}) });
    await this.jobs.enqueue({
      kind: 'rebuild_projections',
      payload: { roomId, personId: personId ?? null },
      dedupeKey: `rebuild:${roomId}`,
    });
  }
}
