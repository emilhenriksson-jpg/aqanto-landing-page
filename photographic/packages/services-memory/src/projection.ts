/**
 * Derived state: the profile, the room brief, and what changed since you last looked.
 *
 * The profile is the only part of the system that is never searched. It is injected
 * whole, on every session, to every connected model — which is why it carries a hard
 * token ceiling instead of a relevance score. Append-only personal memory feels
 * magical for three months and is unusable after eighteen; the ceiling is what stops
 * that, and demotion by salience rather than truncation by position is what stops the
 * ceiling from cutting a sentence in half.
 */

import type {
  ActiveRoomContext,
  Actor,
  Brief,
  EventSeq,
  Item,
  ItemKind,
  Profile,
  ProfileSections,
  PersonId,
  ProjectionPort,
  RenderedItem,
  RoomId,
} from '@photographic/core';
import { NotFoundError, NotPermittedError } from '@photographic/core';
import {
  BRIEF_TOKEN_BUDGET,
  PROFILE_TOKEN_BUDGET,
  SECTION_BUDGETS,
  SINCE_LAST_SEEN_TOKEN_BUDGET,
  estimateTokens,
} from '@photographic/core';
import { renderProfile } from '@photographic/agent';

import { MemoryStore } from './store.js';

type SectionName = keyof ProfileSections;

/**
 * Which section a kind renders into.
 *
 * Instructions get their own section rather than being mixed in with facts, because
 * they are the only part the model is meant to obey rather than merely know. Flattening
 * the two is how "answer concisely" ends up treated as trivia.
 */
const SECTION_OF: Record<ItemKind, SectionName> = {
  identity: 'identity',
  fact: 'hardFacts',
  preference: 'preferences',
  instruction: 'instructions',
  never: 'never',
  decision: 'currentFocus',
  note: 'currentFocus',
};

const EMPTY_SECTIONS = (): ProfileSections => ({
  identity: [],
  hardFacts: [],
  preferences: [],
  instructions: [],
  never: [],
  currentFocus: [],
});

export class MemoryProjection implements ProjectionPort {
  /** Bumped per rebuild so a client can tell whether what it holds is current. */
  private versions = new Map<PersonId, number>();
  private staleProfiles = new Set<PersonId>();
  private staleBriefs = new Set<RoomId>();

  constructor(private readonly store: MemoryStore) {}

  async buildProfile(personId: PersonId): Promise<Profile> {
    const roomId = this.store.personalRoomIdOf(personId);
    if (!roomId) throw new NotFoundError('Personen har inget personligt rum.');

    const active = this.store
      .itemsInRoom(roomId)
      .filter((i) => i.status === 'active')
      // Salience first, then recency, because the tie-break decides which of two
      // equally important facts survives the ceiling and the newer one usually should.
      .sort((a, b) => b.salience - a.salience || b.createdAt.getTime() - a.createdAt.getTime());

    const sections = EMPTY_SECTIONS();
    const perSection = new Map<SectionName, number>();
    let total = 0;
    let included = 0;

    for (const item of active) {
      const name = SECTION_OF[item.kind];
      const cost = item.tokenEstimate;
      const sectionUsed = perSection.get(name) ?? 0;

      // Two ceilings, and both matter. The global one keeps the profile injectable; the
      // per-section one stops forty notes from crowding out the person's own name.
      if (total + cost > PROFILE_TOKEN_BUDGET) continue;
      if (sectionUsed + cost > SECTION_BUDGETS[name]) continue;

      sections[name].push({ shortId: item.shortId, body: item.body } satisfies RenderedItem);
      perSection.set(name, sectionUsed + cost);
      total += cost;
      included += 1;
    }

    const version = (this.versions.get(personId) ?? 0) + 1;
    this.versions.set(personId, version);

    const profile: Profile = {
      personId,
      rendered: '',
      sections,
      tokenCount: 0,
      itemCount: included,
      builtFromSeq: this.latestSeq(),
      version,
      builtAt: this.store.now(),
    };

    profile.rendered = renderProfile(profile);
    profile.tokenCount = estimateTokens(profile.rendered);

    this.store.profiles.set(personId, profile);
    this.staleProfiles.delete(personId);
    return profile;
  }

  /** Rebuilds on demand when stale, so a read never returns something known wrong. */
  async getProfile(personId: PersonId): Promise<Profile> {
    const cached = this.store.profiles.get(personId);
    if (cached && !this.staleProfiles.has(personId)) return cached;
    return this.buildProfile(personId);
  }

  async buildBrief(roomId: RoomId): Promise<Brief> {
    const room = this.store.rooms.get(roomId);
    if (!room) throw new NotFoundError('Rummet finns inte.');

    const items = this.store
      .itemsInRoom(roomId)
      .filter((i) => i.status === 'active')
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

    const brief: Brief = {
      roomId,
      rendered: packLines(items, BRIEF_TOKEN_BUDGET),
      tokenCount: 0,
      builtFromSeq: this.latestSeq(),
      stale: false,
      builtAt: this.store.now(),
    };
    brief.tokenCount = estimateTokens(brief.rendered);

    this.store.briefs.set(roomId, brief);
    this.staleBriefs.delete(roomId);
    return brief;
  }

  async getBrief(actor: Actor, roomId: RoomId): Promise<Brief> {
    if (!this.store.canRead(actor.personId, roomId)) throw new NotPermittedError();
    const cached = this.store.briefs.get(roomId);
    if (cached && !this.staleBriefs.has(roomId)) return cached;
    return this.buildBrief(roomId);
  }

  async invalidate(input: { personId?: PersonId; roomId?: RoomId }): Promise<void> {
    if (input.personId) this.staleProfiles.add(input.personId);
    if (input.roomId) this.staleBriefs.add(input.roomId);
  }

  async activeRoomContext(actor: Actor, roomId: RoomId): Promise<ActiveRoomContext> {
    if (!this.store.canRead(actor.personId, roomId)) throw new NotPermittedError();

    const room = this.store.rooms.get(roomId);
    if (!room) throw new NotPermittedError();

    const brief = await this.getBrief(actor, roomId);
    const seen = this.store.readState.get(`${actor.personId}:${roomId}`) ?? 0;

    // "What happened while you were away" is the line that makes a shared room feel
    // alive rather than like a folder, so it is part of the injected context rather
    // than something the model has to think to ask for.
    const sinceLastSeen = packSince(
      this.store
        .allEvents()
        .filter((e) => e.roomId === roomId && e.seq > seen && e.actorPersonId !== actor.personId)
        .map((e) => describeEvent(this.store, e.eventType, e.payload, e.actorPersonId))
        .filter((line): line is string => line !== null),
      SINCE_LAST_SEEN_TOKEN_BUDGET,
    );

    return { roomId, title: room.title, brief: brief.rendered, sinceLastSeen };
  }

  private latestSeq(): EventSeq {
    return (this.store.allEvents().at(-1)?.seq ?? 0) as EventSeq;
  }
}

/**
 * Renders memories as a bulleted list, and the leading marker is not decoration.
 *
 * Room content reaches a model inside a `<room-content>` boundary, and a line that
 * starts flush-left reads far more like an instruction to the model than one that
 * starts as an item in a list. The marker is cheap and it keeps every line visibly
 * part of the data.
 */
function packLines(items: Item[], budgetTokens: number): string {
  const lines: string[] = [];
  let used = 0;

  for (const item of items) {
    const line = `- ${item.body} (${item.shortId})`;
    const cost = estimateTokens(line);
    if (used + cost > budgetTokens) break;
    lines.push(line);
    used += cost;
  }

  return lines.join('\n');
}

function packSince(lines: string[], budgetTokens: number): string[] {
  const out: string[] = [];
  let used = 0;
  for (const line of lines.reverse()) {
    const cost = estimateTokens(line);
    if (used + cost > budgetTokens) break;
    out.push(line);
    used += cost;
  }
  return out;
}

function describeEvent(
  store: MemoryStore,
  eventType: string,
  payload: Record<string, unknown>,
  actorPersonId: PersonId | null,
): string | null {
  const who = actorPersonId ? store.persons.get(actorPersonId)?.displayName ?? 'Någon' : 'Någon';
  const body = typeof payload['body'] === 'string' ? payload['body'] : null;

  switch (eventType) {
    case 'item.created':
      return body ? `- ${who} sparade: ${body}` : null;
    case 'item.updated':
      return body ? `- ${who} ändrade: ${body}` : null;
    case 'item.deleted':
      return `- ${who} tog bort ett minne`;
    case 'document.uploaded':
      return `- ${who} laddade upp ${String(payload['filename'] ?? 'ett dokument')}`;
    case 'member.joined':
      return `- ${who} gick med i rummet`;
    default:
      return null;
  }
}
