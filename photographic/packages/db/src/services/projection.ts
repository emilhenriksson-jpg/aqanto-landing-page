/**
 * Derived state: the profile, the room brief, and the room headline, backed by
 * Postgres.
 *
 * The profile and the brief are real projections (`app.profile`, `app.brief`), rebuilt
 * from `app.item` and cached in their own table exactly as the schema intends. The
 * headline has no table of its own -- the schema does not carve out a home for it
 * distinct from the brief -- so it is cached in memory here instead. That is a real
 * trade-off (the cache is cold after a restart, and the job that rebuilds it after a
 * write must have run in this same process to be seen), but it costs nothing to fix
 * later behind the same `ProjectionPort` and it is not part of the correctness of a
 * single request, which is what stopping the profile at a token ceiling actually is.
 */

import type {
  ActiveRoomContext,
  Actor,
  Brief,
  EventSeq,
  Item,
  ItemKind,
  LlmPort,
  PersonId,
  Profile,
  ProfileSections,
  ProjectionPort,
  RenderedItem,
  RoomHeadline,
  RoomId,
} from '@photographic/core';
import { NotFoundError, NotPermittedError } from '@photographic/core';
import {
  BRIEF_TOKEN_BUDGET,
  COMPASS_PRINCIPLES,
  compassEntriesFrom,
  PROFILE_TOKEN_BUDGET,
  ROOM_HEADLINE_TOKEN_BUDGET,
  SECTION_BUDGETS,
  SINCE_LAST_SEEN_TOKEN_BUDGET,
  estimateTokens,
} from '@photographic/core';
import type { CompassEntry } from '@photographic/core';
import { renderProfile } from '@photographic/agent';
import type { Pool } from 'pg';

import { execute, queryOne, queryRows, type Db } from '../pool.js';
import { mapItem, type ItemRow } from '../rows.js';
import { canRead } from './permissions.js';
import { personalRoomIdOf } from './identity.js';

/**
 * The durable half of `ProjectionPort.invalidate`, on whichever unit of work the caller
 * is inside.
 *
 * Split out so a lifecycle transition can mark its own derived state stale inside the
 * transaction that changed the state — the alternative is an item in the trash beside a
 * brief that still quotes it, with nothing left to notice the gap.
 */
export async function invalidateProjections(
  db: Db,
  input: { personId?: PersonId; roomId?: RoomId },
): Promise<void> {
  if (input.roomId) {
    await execute(db, `UPDATE app.brief SET stale = true WHERE room_id = $1`, [input.roomId]);
  }
  if (input.personId) {
    // No explicit "stale" flag on `app.profile`; deleting the cached row is what makes
    // the next read rebuild it, and it costs nothing extra to rebuild eagerly instead.
    await execute(db, `DELETE FROM app.profile WHERE person_id = $1`, [input.personId]);
  }
}

type SectionName = keyof ProfileSections;

/** See the matching constant in `MemoryProjection` for why `compass` is absent here. */
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

const EMPTY_HEADLINE = 'Inget sparat än';
const HEADLINE_SOURCE_ITEMS = 12;
const HEADLINE_MAX_CHARS = ROOM_HEADLINE_TOKEN_BUDGET * 4;

export class PgProjection implements ProjectionPort {
  /** Not a table in the schema; see the file comment. */
  private readonly headlines = new Map<RoomId, RoomHeadline>();
  private readonly staleHeadlines = new Set<RoomId>();

  constructor(
    private readonly pool: Pool,
    private readonly llm: Pick<LlmPort, 'summarise'>,
  ) {}

  async buildProfile(personId: PersonId): Promise<Profile> {
    const roomId = await personalRoomIdOf(this.pool, personId);
    if (!roomId) throw new NotFoundError('Personen har inget personligt rum.');

    const rows = await queryRows<ItemRow>(
      this.pool,
      `SELECT id, short_id, room_id, kind, body, structured, sensitivity, status,
              valid_from, valid_to, superseded_by, salience, token_estimate, last_used_at,
              use_count, created_at, deleted_at, deleted_by, deleted_by_client, purge_after,
              delete_reason
       FROM app.item
       WHERE room_id = $1 AND status = 'active'
       ORDER BY salience DESC, created_at DESC`,
      [roomId],
    );
    const active = rows.map(mapItem);

    const sections = EMPTY_SECTIONS();
    const perSection = new Map<SectionName, number>();
    let total = 0;
    let included = 0;

    for (const item of active) {
      // See `MemoryProjection.buildProfile` for why `compass` items skip this loop
      // entirely and are gathered separately below.
      const name = SECTION_OF[item.kind];
      if (!name) continue;

      const cost = item.tokenEstimate;
      const sectionUsed = perSection.get(name) ?? 0;

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

    const builtFromSeq = await this.latestSeq();
    const version = await this.nextProfileVersion(personId);

    let rendered = renderProfile({
      personId,
      rendered: '',
      sections,
      compass,
      tokenCount: 0,
      itemCount: included,
      builtFromSeq,
      version,
      builtAt: new Date(),
    });
    const tokenCount = estimateTokens(rendered);
    const builtAt = new Date();

    await execute(
      this.pool,
      `INSERT INTO app.profile (person_id, rendered, sections, compass, token_count, item_count, built_from_seq, version, built_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (person_id) DO UPDATE SET
         rendered = $2, sections = $3, compass = $4, token_count = $5, item_count = $6,
         built_from_seq = $7, version = $8, built_at = $9`,
      [
        personId,
        rendered,
        JSON.stringify(sections),
        JSON.stringify(compass),
        tokenCount,
        included,
        builtFromSeq,
        version,
        builtAt,
      ],
    );

    return {
      personId,
      rendered,
      sections,
      compass,
      tokenCount,
      itemCount: included,
      builtFromSeq,
      version,
      builtAt,
    };
  }

  async getProfile(personId: PersonId): Promise<Profile> {
    const row = await queryOne<{
      person_id: string;
      rendered: string;
      sections: ProfileSections;
      compass: CompassEntry[];
      token_count: number;
      item_count: number;
      built_from_seq: string;
      version: number;
      built_at: Date;
    }>(
      this.pool,
      `SELECT person_id, rendered, sections, compass, token_count, item_count, built_from_seq, version, built_at
       FROM app.profile WHERE person_id = $1`,
      [personId],
    );
    if (!row) return this.buildProfile(personId);

    // A profile cached before `0015_personal_compass.sql` has `compass = '[]'`, the
    // column default, and returning it would deliver a person no compass at all until
    // something else happened to rebuild their profile. Treated as a cache miss rather
    // than as an answer: the six principles are not optional and their absence is not a
    // state the person chose. Rebuilding also refreshes the cached text, so a later edit
    // to a default in `packages/core/src/compass.ts` reaches an existing account instead
    // of stopping at whatever was cached the day they signed up.
    //
    // Bounded: the rebuild writes the full set, so this happens once per stale profile.
    if (!Array.isArray(row.compass) || row.compass.length !== COMPASS_PRINCIPLES.length) {
      return this.buildProfile(personId);
    }

    return {
      personId,
      rendered: row.rendered,
      sections: row.sections,
      compass: row.compass,
      tokenCount: row.token_count,
      itemCount: row.item_count,
      builtFromSeq: Number(row.built_from_seq) as EventSeq,
      version: row.version,
      builtAt: row.built_at,
    };
  }

  async buildBrief(roomId: RoomId): Promise<Brief> {
    const room = await queryOne<{ id: string }>(this.pool, `SELECT id FROM app.room WHERE id = $1`, [
      roomId,
    ]);
    if (!room) throw new NotFoundError('Rummet finns inte.');

    const rows = await queryRows<ItemRow>(
      this.pool,
      `SELECT id, short_id, room_id, kind, body, structured, sensitivity, status,
              valid_from, valid_to, superseded_by, salience, token_estimate, last_used_at,
              use_count, created_at, deleted_at, deleted_by, deleted_by_client, purge_after,
              delete_reason
       FROM app.item
       WHERE room_id = $1 AND status = 'active'
       ORDER BY created_at DESC`,
      [roomId],
    );
    const items = rows.map(mapItem);

    const rendered = packLines(items, BRIEF_TOKEN_BUDGET);
    const tokenCount = estimateTokens(rendered);
    const builtFromSeq = await this.latestSeq();
    const builtAt = new Date();
    const version = await this.nextBriefVersion(roomId);

    await execute(
      this.pool,
      `INSERT INTO app.brief (room_id, rendered, token_count, built_from_seq, stale, version, built_at)
       VALUES ($1, $2, $3, $4, false, $5, $6)
       ON CONFLICT (room_id) DO UPDATE SET
         rendered = $2, token_count = $3, built_from_seq = $4, stale = false, version = $5, built_at = $6`,
      [roomId, rendered, tokenCount, builtFromSeq, version, builtAt],
    );

    return { roomId, rendered, tokenCount, builtFromSeq, stale: false, builtAt };
  }

  async getBrief(actor: Actor, roomId: RoomId): Promise<Brief> {
    if (!(await canRead(this.pool, actor.personId, roomId))) throw new NotPermittedError();

    const row = await queryOne<{
      room_id: string;
      rendered: string;
      token_count: number;
      built_from_seq: string;
      stale: boolean;
      built_at: Date;
    }>(
      this.pool,
      `SELECT room_id, rendered, token_count, built_from_seq, stale, built_at
       FROM app.brief WHERE room_id = $1`,
      [roomId],
    );
    if (!row || row.stale) return this.buildBrief(roomId);

    return {
      roomId,
      rendered: row.rendered,
      tokenCount: row.token_count,
      builtFromSeq: Number(row.built_from_seq) as EventSeq,
      stale: row.stale,
      builtAt: row.built_at,
    };
  }

  async buildHeadline(roomId: RoomId): Promise<RoomHeadline> {
    const room = await queryOne<{ kind: string; description: string | null }>(
      this.pool,
      `SELECT kind, description FROM app.room WHERE id = $1`,
      [roomId],
    );
    if (!room) throw new NotFoundError('Rummet finns inte.');

    if (room.kind === 'personal') return this.cacheHeadline(roomId, '', 'owner');

    const owner = ownerHeadline(room.description);
    if (owner) return this.cacheHeadline(roomId, owner, 'owner');

    const rows = await queryRows<{ body: string }>(
      this.pool,
      `SELECT body FROM app.item WHERE room_id = $1 AND status = 'active'
       ORDER BY created_at DESC LIMIT $2`,
      [roomId, HEADLINE_SOURCE_ITEMS],
    );
    const bodies = rows.map((r) => r.body);
    if (bodies.length === 0) return this.cacheHeadline(roomId, EMPTY_HEADLINE, 'empty');

    const summary = oneSentence(
      await this.llm.summarise({ texts: bodies, budgetTokens: ROOM_HEADLINE_TOKEN_BUDGET, as: 'headline' }),
    );

    return summary
      ? this.cacheHeadline(roomId, summary, 'derived')
      : this.cacheHeadline(roomId, EMPTY_HEADLINE, 'empty');
  }

  async headlinesFor(roomIds: RoomId[]): Promise<Map<RoomId, RoomHeadline>> {
    const out = new Map<RoomId, RoomHeadline>();
    if (roomIds.length === 0) return out;

    const rows = await queryRows<{ id: string; description: string | null }>(
      this.pool,
      `SELECT id, description FROM app.room WHERE id = ANY($1::uuid[])`,
      [roomIds],
    );
    const descriptions = new Map(rows.map((r) => [r.id as RoomId, r.description]));

    for (const roomId of roomIds) {
      const cached = this.headlines.get(roomId);
      if (cached && !this.staleHeadlines.has(roomId)) {
        out.set(roomId, cached);
        continue;
      }

      const description = descriptions.get(roomId);
      if (description === undefined) continue;

      out.set(roomId, {
        roomId,
        rendered: ownerHeadline(description) || cached?.rendered || EMPTY_HEADLINE,
        source: description ? 'owner' : cached?.source ?? 'empty',
        builtFromSeq: cached?.builtFromSeq ?? (0 as EventSeq),
        stale: true,
        builtAt: cached?.builtAt ?? new Date(),
      });
    }

    return out;
  }

  async invalidate(input: { personId?: PersonId; roomId?: RoomId }): Promise<void> {
    if (input.roomId) this.staleHeadlines.add(input.roomId);
    await invalidateProjections(this.pool, input);
  }

  async activeRoomContext(actor: Actor, roomId: RoomId): Promise<ActiveRoomContext> {
    if (!(await canRead(this.pool, actor.personId, roomId))) throw new NotPermittedError();

    const room = await queryOne<{ title: string }>(this.pool, `SELECT title FROM app.room WHERE id = $1`, [
      roomId,
    ]);
    if (!room) throw new NotPermittedError();

    const brief = await this.getBrief(actor, roomId);

    const readState = await queryOne<{ last_seen_seq: string }>(
      this.pool,
      `SELECT last_seen_seq FROM app.room_read_state WHERE person_id = $1 AND room_id = $2`,
      [actor.personId, roomId],
    );
    const seen = readState ? Number(readState.last_seen_seq) : 0;

    const rows = await queryRows<{
      event_type: string;
      payload: Record<string, unknown>;
      actor_person_id: string | null;
      actor_name: string | null;
    }>(
      this.pool,
      `SELECT e.event_type, e.payload, e.actor_person_id, p.display_name AS actor_name
       FROM app.event e
       LEFT JOIN app.person p ON p.id = e.actor_person_id
       WHERE e.room_id = $1 AND e.seq > $2
         AND (e.actor_person_id IS NULL OR e.actor_person_id <> $3)
       ORDER BY e.seq ASC`,
      [roomId, seen, actor.personId],
    );

    const lines = rows
      .map((r) => describeEvent(r.event_type, r.payload, r.actor_name))
      .filter((line): line is string => line !== null);

    const sinceLastSeen = packSince(lines, SINCE_LAST_SEEN_TOKEN_BUDGET);

    return { roomId, title: room.title, brief: brief.rendered, sinceLastSeen };
  }

  private cacheHeadline(roomId: RoomId, rendered: string, source: RoomHeadline['source']): RoomHeadline {
    const headline: RoomHeadline = {
      roomId,
      rendered,
      source,
      builtFromSeq: 0 as EventSeq,
      stale: false,
      builtAt: new Date(),
    };
    this.headlines.set(roomId, headline);
    this.staleHeadlines.delete(roomId);
    return headline;
  }

  private async latestSeq(): Promise<EventSeq> {
    const row = await queryOne<{ seq: string | null }>(this.pool, `SELECT max(seq) AS seq FROM app.event`);
    return (row?.seq ? Number(row.seq) : 0) as EventSeq;
  }

  private async nextProfileVersion(personId: PersonId): Promise<number> {
    const row = await queryOne<{ version: number }>(
      this.pool,
      `SELECT version FROM app.profile WHERE person_id = $1`,
      [personId],
    );
    return (row?.version ?? 0) + 1;
  }

  private async nextBriefVersion(roomId: RoomId): Promise<number> {
    const row = await queryOne<{ version: number }>(
      this.pool,
      `SELECT version FROM app.brief WHERE room_id = $1`,
      [roomId],
    );
    return (row?.version ?? 0) + 1;
  }
}

function ownerHeadline(description: string | null): string {
  return clampHeadline((description ?? '').replace(/\s+/g, ' ').trim());
}

function oneSentence(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (!flat) return '';
  const end = flat.search(/[.!?](\s|$)/);
  return clampHeadline(end === -1 ? flat : flat.slice(0, end + 1));
}

function clampHeadline(text: string): string {
  return text.length > HEADLINE_MAX_CHARS
    ? `${text.slice(0, HEADLINE_MAX_CHARS - 1).trimEnd()}…`
    : text;
}

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
  for (const line of [...lines].reverse()) {
    const cost = estimateTokens(line);
    if (used + cost > budgetTokens) break;
    out.push(line);
    used += cost;
  }
  return out;
}

function describeEvent(
  eventType: string,
  payload: Record<string, unknown>,
  actorName: string | null,
): string | null {
  const who = actorName ?? 'Någon';
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
