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
  LlmPort,
  Profile,
  ProfileSections,
  PersonId,
  ProjectionPort,
  RenderedItem,
  RoomHeadline,
  RoomId,
} from '@photographic/core';
import { NotFoundError, NotPermittedError } from '@photographic/core';
import {
  BRIEF_TOKEN_BUDGET,
  compassEntriesFrom,
  compassEntriesFromCache,
  PROFILE_TOKEN_BUDGET,
  ROOM_HEADLINE_TOKEN_BUDGET,
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
/**
 * Which section a kind renders into, or `undefined` when a kind is not part of
 * `ProfileSections` at all. `compass` is deliberately absent: it renders in its own
 * block with its own budget (see `renderCompass` in `@photographic/agent`), not mixed
 * into the standing-instructions section it would otherwise resemble most closely.
 */
const SECTION_OF: Partial<Record<ItemKind, SectionName>> = {
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
  private staleHeadlines = new Set<RoomId>();

  constructor(
    private readonly store: MemoryStore,
    private readonly llm: Pick<LlmPort, 'summarise'>,
  ) {}

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
      // Compass items are gathered separately below, into their own budgeted block —
      // never into a `ProfileSections` bucket, and never counted against
      // `PROFILE_TOKEN_BUDGET`, which is the profile's ceiling, not the Compass's.
      const name = SECTION_OF[item.kind];
      if (!name) continue;

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

    const compass = compassEntriesFrom(
      active
        .filter((item) => item.kind === 'compass')
        .map((item) => ({ shortId: item.shortId, body: item.body, structured: item.structured })),
    );

    const version = (this.versions.get(personId) ?? 0) + 1;
    this.versions.set(personId, version);

    const profile: Profile = {
      personId,
      rendered: '',
      sections,
      compass,
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
    if (!cached || this.staleProfiles.has(personId)) return this.buildProfile(personId);

    // Same guarantee the Postgres implementation makes, stated the same way: the six
    // principles come from `COMPASS_PRINCIPLES` for every slot nobody has personalised,
    // whatever is in the cache. There is no pre-migration profile to worry about here,
    // but "a compass is always six" should not be true only because this store happens
    // to be filled by one function.
    return { ...cached, compass: compassEntriesFromCache(cached.compass) };
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

  /**
   * The room in one sentence.
   *
   * Three sources, in descending order of how much they can be trusted to say what the
   * room is *for*. What the owner wrote wins outright and is never regenerated: a person
   * who took the trouble to describe their room should not find a model's paraphrase in
   * its place next week. Failing that the contents are summarised. A room with nothing
   * in it says so, because a model told "Inget sparat än" will stop trying to answer
   * from a room that cannot answer, while a model told nothing will search it.
   */
  async buildHeadline(roomId: RoomId): Promise<RoomHeadline> {
    const room = this.store.rooms.get(roomId);
    if (!room) throw new NotFoundError('Rummet finns inte.');

    // The personal room never needs summarising: the overview says the profile above is
    // this room, which is the only true thing to say about it. Summarising it anyway
    // would mean a model call on every fact a person saves about themselves — the most
    // frequent write in the product — for a sentence nothing reads.
    if (room.kind === 'personal') return this.cacheHeadline(roomId, '', 'owner');

    const owner = ownerHeadline(room.description);
    if (owner) return this.cacheHeadline(roomId, owner, 'owner');

    const bodies = this.store
      .itemsInRoom(roomId)
      .filter((i) => i.status === 'active')
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .slice(0, HEADLINE_SOURCE_ITEMS)
      .map((i) => i.body);

    if (bodies.length === 0) return this.cacheHeadline(roomId, EMPTY_HEADLINE, 'empty');

    const summary = oneSentence(
      await this.llm.summarise({
        texts: bodies,
        budgetTokens: ROOM_HEADLINE_TOKEN_BUDGET,
        as: 'headline',
      }),
    );

    return summary
      ? this.cacheHeadline(roomId, summary, 'derived')
      : this.cacheHeadline(roomId, EMPTY_HEADLINE, 'empty');
  }

  /**
   * Cached headlines, and a cheap stand-in for the ones not built yet.
   *
   * The stand-in is the point. This runs on every session start, so it cannot summarise
   * and it cannot wait — but returning nothing for a room the person created a minute
   * ago would hide the room from the overview, which is the one thing the overview must
   * not do. So an unbuilt headline comes back as the owner's description or as "nothing
   * saved yet", marked stale, and the job replaces it with something better.
   */
  async headlinesFor(roomIds: RoomId[]): Promise<Map<RoomId, RoomHeadline>> {
    const out = new Map<RoomId, RoomHeadline>();

    for (const roomId of roomIds) {
      const cached = this.store.headlines.get(roomId);
      if (cached && !this.staleHeadlines.has(roomId)) {
        out.set(roomId, cached);
        continue;
      }

      const room = this.store.rooms.get(roomId);
      if (!room) continue;

      out.set(roomId, {
        roomId,
        rendered: ownerHeadline(room.description) || cached?.rendered || EMPTY_HEADLINE,
        source: room.description ? 'owner' : cached?.source ?? 'empty',
        builtFromSeq: cached?.builtFromSeq ?? (0 as EventSeq),
        stale: true,
        builtAt: cached?.builtAt ?? this.store.now(),
      });
    }

    return out;
  }

  async invalidate(input: { personId?: PersonId; roomId?: RoomId }): Promise<void> {
    if (input.personId) this.staleProfiles.add(input.personId);
    if (input.roomId) {
      this.staleBriefs.add(input.roomId);
      this.staleHeadlines.add(input.roomId);
    }
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

  private cacheHeadline(
    roomId: RoomId,
    rendered: string,
    source: RoomHeadline['source'],
  ): RoomHeadline {
    const headline: RoomHeadline = {
      roomId,
      rendered,
      source,
      builtFromSeq: this.latestSeq(),
      stale: false,
      builtAt: this.store.now(),
    };

    this.store.headlines.set(roomId, headline);
    this.staleHeadlines.delete(roomId);
    return headline;
  }

  private latestSeq(): EventSeq {
    return (this.store.allEvents().at(-1)?.seq ?? 0) as EventSeq;
  }
}

/** How much of a room to read before saying what it is. */
const HEADLINE_SOURCE_ITEMS = 12;

const EMPTY_HEADLINE = 'Inget sparat än';

/**
 * What the owner wrote, kept as they wrote it.
 *
 * Not put through `oneSentence`. A person who describes their room in two short
 * sentences meant both of them, and cutting the second is how "Ledningsgruppen i
 * Buyersclub. Beslut och underlag." turns into a line that says less than the room's own
 * title. Only the length ceiling applies, because the overview still has to fit.
 */
function ownerHeadline(description: string | null): string {
  return clampHeadline((description ?? '').replace(/\s+/g, ' ').trim());
}

/**
 * Cuts a generated headline down to its first sentence.
 *
 * This applies to what the model wrote, not to what the person wrote. A summariser asked
 * for one sentence will sometimes produce three, and the second and third are where it
 * starts listing the contents — which is the brief's job and would push the next room out
 * of the model's attention on the way.
 */
function oneSentence(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (!flat) return '';

  const end = flat.search(/[.!?](\s|$)/);
  return clampHeadline(end === -1 ? flat : flat.slice(0, end + 1));
}

/** The last line of defence for a sentence that never ends. */
function clampHeadline(text: string): string {
  return text.length > HEADLINE_MAX_CHARS
    ? `${text.slice(0, HEADLINE_MAX_CHARS - 1).trimEnd()}…`
    : text;
}

/** Roughly the token budget expressed in characters. */
const HEADLINE_MAX_CHARS = ROOM_HEADLINE_TOKEN_BUDGET * 4;

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
