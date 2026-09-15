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
  IngestPort,
  Item,
  ItemId,
  ItemKind,
  JobPort,
  LlmPort,
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
    },
  ): Promise<WriteDecision> {
    if (!this.store.canWrite(actor.personId, input.roomId)) throw new NotPermittedError();

    const body = input.body.trim().replace(/\s+/g, ' ');
    if (!body) throw new ValidationError('Tomt minne kan inte sparas.');
    if (body.length > MAX_BODY_CHARS) {
      throw new ValidationError('För långt för att sparas som ett minne. Ladda upp det som dokument.');
    }

    const kind = input.kind ?? classifyKind(body);
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
    for (const sibling of this.neighbours(body, siblings)) {
      const verdict = await this.llm.compare(body, sibling.body);
      if (verdict === 'same') {
        return { outcome: 'duplicate', existing: this.bumpSalience(sibling) };
      }
      if (verdict === 'contradicts') {
        contradicts = true;
        break;
      }
    }

    const gate = requiresApproval({
      kind,
      body,
      contradicts,
      explicit: input.explicit ?? false,
      roomIsShared: room.kind === 'shared',
    });

    if (gate.required) {
      const conflicting = contradicts
        ? this.neighbours(body, siblings)[0]?.id ?? null
        : null;
      return { outcome: 'needs_approval', proposal: this.queueProposal(actor, input.roomId, kind, body, gate.reason, conflicting) };
    }

    const item = await this.write(actor, {
      roomId: input.roomId,
      kind,
      body,
      sensitivity: input.sensitivity ?? 'normal',
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
    if (!this.store.canWrite(actor.personId, roomId)) throw new NotPermittedError();

    const item = this.store.findByShortId(actor.personId, shortId, roomId);
    if (!item || item.status === 'deleted') throw new NotFoundError('Minnet finns inte.');

    const next = body.trim().replace(/\s+/g, ' ');
    if (!next) throw new ValidationError('Tomt minne kan inte sparas.');

    const before = item.body;
    item.body = next;
    item.tokenEstimate = estimateTokens(next);
    await this.embed(item.id, next);

    // The short id survives an edit on purpose: a person who said "change p-7k2m" is
    // still talking about p-7k2m afterwards.
    this.store.append({
      roomId,
      eventType: 'item.updated',
      payload: { item_id: item.id, short_id: item.shortId, body: next, previous: before },
      actorPersonId: actor.personId,
      agentClient: actor.agentClient,
    });

    await this.markStale(item.roomId, actor);
    return item;
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

    const now = this.store.now();
    const undoToken = randomBytes(16).toString('base64url');

    item.status = 'deleted';
    item.deletedAt = now;
    item.deletedBy = actor.personId;
    item.deletedByClient = actor.agentClient;
    item.purgeAfter = purgeDeadline(now);
    item.deleteReason = reason?.trim() || null;
    this.store.undoTokens.set(undoToken, item.id);

    this.store.append({
      roomId,
      eventType: 'item.deleted',
      payload: { item_id: item.id, short_id: item.shortId, body: item.body },
      actorPersonId: actor.personId,
      agentClient: actor.agentClient,
    });

    await this.markStale(roomId, actor);
    return { item, undoToken };
  }

  async undo(actor: Actor, undoToken: string): Promise<Item> {
    const itemId = this.store.undoTokens.get(undoToken);
    const item = itemId ? this.store.items.get(itemId) : undefined;
    if (!item) throw new NotFoundError('Det finns inget att ta tillbaka.');
    if (!this.store.canWrite(actor.personId, item.roomId)) throw new NotPermittedError();

    this.store.undoTokens.delete(undoToken);
    return this.restore(actor, item);
  }

  async listProposals(actor: Actor): Promise<Proposal[]> {
    return [...this.store.proposals.values()]
      .filter((p) => p.personId === actor.personId && p.status === 'pending')
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
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
      });
      return null;
    }

    proposal.status = 'accepted';

    // Approving something that contradicts an existing memory replaces it rather than
    // sitting beside it. Two contradictory facts in the profile is the state that makes
    // every connected model unreliable at once.
    if (proposal.conflictsWith) {
      const old = this.store.items.get(proposal.conflictsWith);
      if (old && old.status === 'active') {
        old.status = 'superseded';
        old.validTo = this.store.now();
      }
    }

    const item = await this.write(actor, {
      roomId: proposal.roomId,
      kind: proposal.kind,
      body: proposal.body,
      sensitivity: 'normal',
      approvedBy: actor.personId,
      supersedes: proposal.conflictsWith,
    });

    this.store.append({
      roomId: proposal.roomId,
      eventType: 'proposal.accepted',
      payload: { proposal_id: proposal.id, item_id: item.id, body: item.body },
      actorPersonId: actor.personId,
      agentClient: actor.agentClient,
      approvedBy: actor.personId,
    });

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
    });

    await this.markStale(item.roomId, actor);
    return item;
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  /**
   * The item is already in the store by the time this runs (`store.put` happens
   * first in `write`; `item.body` is already reassigned in `update`), so a failed or
   * unavailable embedder must never make the write itself fail. `FakeLlm` never
   * throws, but this package's `llm` is an injected `LlmPort` and nothing prevents a
   * caller from wiring a real one in here too -- degrading to lexical-only ranking on
   * failure is the same guarantee `PgRetrieval`/`PgIngest` make for the same reason.
   */
  private async embed(itemId: ItemId, body: string): Promise<void> {
    try {
      const [vector] = await this.llm.embed([body]);
      if (vector) this.store.embeddings.set(itemId, vector);
    } catch {
      // No embedding this time; the semantic ranking arm just has nothing for this
      // item until the next successful write touches it.
    }
  }

  private async write(
    actor: Actor,
    input: {
      roomId: RoomId;
      kind: ItemKind;
      body: string;
      sensitivity: 'normal' | 'sensitive';
      approvedBy?: import('@photographic/core').PersonId;
      supersedes?: ItemId | null;
    },
  ): Promise<Item> {
    const now = this.store.now();
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
      deletedAt: null,
      deletedBy: null,
      deletedByClient: null,
      purgeAfter: null,
      deleteReason: null,
    };

    this.store.put(item);
    await this.embed(item.id, input.body);

    if (input.supersedes) {
      const old = this.store.items.get(input.supersedes);
      if (old) old.supersededBy = item.id;
    }

    this.store.append({
      roomId: input.roomId,
      eventType: 'item.created',
      payload: {
        item_id: item.id,
        short_id: item.shortId,
        kind: item.kind,
        body: item.body,
      },
      actorPersonId: actor.personId,
      agentClient: actor.agentClient,
      approvedBy: input.approvedBy ?? null,
    });

    await this.markStale(input.roomId, actor);
    return item;
  }

  private queueProposal(
    actor: Actor,
    roomId: RoomId,
    kind: ItemKind,
    body: string,
    reason: string,
    conflictsWith: ItemId | null,
  ): Proposal {
    const proposal: Proposal = {
      id: newId<ProposalId>(),
      roomId,
      personId: actor.personId,
      kind,
      body,
      reason,
      conflictsWith,
      proposedByClient: actor.agentClient,
      status: 'pending',
      createdAt: this.store.now(),
    };
    this.store.proposals.set(proposal.id, proposal);

    this.store.append({
      roomId,
      eventType: 'proposal.created',
      payload: { proposal_id: proposal.id, body, kind, reason },
      actorPersonId: actor.personId,
      agentClient: actor.agentClient,
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
