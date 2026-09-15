/**
 * Retrieval.
 *
 * Scope is applied in the query that gathers candidates, never as a filter over
 * results -- the same rule `services-memory` states and the same reason: a post-filter
 * is one forgotten line away from leaking another person's room.
 *
 * Two sources, ranked two ways, for a reason that is about size rather than taste.
 * Items are a few hundred short curated sentences per person, so word overlap in
 * TypeScript is fine and matches what `services-memory` does. Document chunks are every
 * paragraph of every file a person has uploaded, bounded only by a ten-gigabyte storage
 * limit — so those are ranked by Postgres full-text search in
 * `app.search_chunks`, where the index is.
 *
 * Semantic ranking needs real embeddings from `LlmPort.embed`. Those are not written to
 * `item.embedding` / `chunk.embedding` yet, and turning them on is additive to this
 * method — the chunks already exist with the column empty, which is the whole reason
 * chunking happens at ingest.
 */

import type {
  Actor,
  ItemKind,
  LlmPort,
  PersonId,
  RetrievalPort,
  RoomId,
  SearchHit,
  ShortId,
} from '@photographic/core';
import { dedupeHash, NotPermittedError } from '@photographic/core';
import type { Pool } from 'pg';

import { queryRows } from '../pool.js';
import { accessibleRoomIds, canRead } from './permissions.js';

export const DEFAULT_SEARCH_LIMIT = 10;

interface Candidate {
  kind: 'item' | 'chunk';
  id: string;
  roomId: RoomId;
  shortId: ShortId | null;
  text: string;
  documentId: string | null;
  /** Other items this one contradicts, unresolved. Empty for chunks. */
  disputedBy: string[];
  /** When an item was saved. `null` for a chunk — see `SearchHit.createdAt`. */
  createdAt: Date | null;
}

export class PgRetrieval implements RetrievalPort {
  constructor(
    private readonly pool: Pool,
    private readonly llm: LlmPort,
  ) {}

  async search(
    actor: Actor,
    input: { query: string; roomIds?: RoomId[]; limit?: number },
  ): Promise<SearchHit[]> {
    const query = input.query.trim();
    if (!query) return [];

    const reachable = new Set(await accessibleRoomIds(this.pool, actor.personId));
    const scope = input.roomIds?.length
      ? input.roomIds.filter((id) => reachable.has(id))
      : [...reachable];
    if (scope.length === 0) return [];

    const limit = input.limit ?? DEFAULT_SEARCH_LIMIT;

    // Two sources, ranked separately because they are different kinds of thing and no
    // single ranking is right for both. Items win ties: a sentence a person chose to
    // save about themselves is more likely to be the answer than a paragraph that
    // happened to be in a PDF.
    const [items, chunks] = await Promise.all([
      this.candidatesIn(scope),
      this.chunkHits(actor.personId, query, scope, limit),
    ]);

    // The embed call is kept so `LlmPort.embed` is exercised even though neither source
    // ranks by it yet (see file comment); dropping it silently would make it easy to
    // forget to wire in later.
    await this.llm.embed([query]);

    const ranked = [...rankLexically(query, items), ...chunks];
    if (ranked.length === 0) return [];

    const hits = ranked.slice(0, limit).map((candidate, index) => ({
      kind: candidate.kind,
      id: candidate.id,
      roomId: candidate.roomId,
      shortId: candidate.shortId,
      text: candidate.text,
      score: 1 / (60 + index + 1),
      documentId: candidate.documentId as never,
      disputed: candidate.disputedBy.length > 0,
      createdAt: candidate.createdAt,
    }));

    return this.withDisputedPartners(hits, [...items, ...chunks]);
  }

  /**
   * A disputed statement never travels alone.
   *
   * If one side of a disagreement matches the query, the other side comes with it even
   * when it ranks below the cut. A model handed one of two contradictory statements
   * answers confidently and wrongly; a model handed both says there are two different
   * answers, which is true and is also what gets a person to settle it. Appended past
   * the limit rather than displacing a better hit, because this is about completeness
   * rather than relevance.
   */
  private withDisputedPartners(hits: SearchHit[], candidates: Candidate[]): SearchHit[] {
    const present = new Set(hits.map((hit) => hit.id));
    const byId = new Map(candidates.map((candidate) => [candidate.id, candidate]));
    const extra: SearchHit[] = [];

    for (const hit of hits) {
      if (!hit.disputed) continue;

      for (const partnerId of byId.get(hit.id)?.disputedBy ?? []) {
        if (present.has(partnerId)) continue;
        const partner = byId.get(partnerId);
        if (!partner) continue;

        present.add(partnerId);
        extra.push({
          kind: partner.kind,
          id: partner.id,
          roomId: partner.roomId,
          shortId: partner.shortId,
          text: partner.text,
          score: hit.score,
          documentId: partner.documentId as never,
          disputed: true,
          createdAt: partner.createdAt,
        });
      }
    }

    return [...hits, ...extra];
  }

  async listForRoom(
    actor: Actor,
    roomId: RoomId,
  ): Promise<Array<{ shortId: ShortId; kind: ItemKind; body: string }>> {
    if (!(await canRead(this.pool, actor.personId, roomId))) throw new NotPermittedError();

    const rows = await queryRows<{ short_id: string; kind: ItemKind; body: string }>(
      this.pool,
      `SELECT short_id, kind, body FROM app.item
       WHERE room_id = $1 AND status = 'active'
       ORDER BY created_at DESC`,
      [roomId],
    );

    return rows.map((row) => ({
      shortId: row.short_id as ShortId,
      kind: row.kind,
      body: row.body,
    }));
  }

  private async candidatesIn(scope: RoomId[]): Promise<Candidate[]> {
    const items = await queryRows<{
      id: string;
      room_id: string;
      short_id: string;
      body: string;
      disputed_by: string[] | null;
      created_at: Date;
    }>(
      this.pool,
      `SELECT id, room_id, short_id, body, disputed_by, created_at FROM app.item
       WHERE room_id = ANY($1::uuid[]) AND status = 'active' AND sensitivity <> 'local_only'`,
      [scope],
    );

    return items.map((r) => ({
      kind: 'item' as const,
      id: r.id,
      roomId: r.room_id as RoomId,
      shortId: r.short_id as ShortId,
      text: r.body,
      documentId: null,
      disputedBy: r.disputed_by ?? [],
      createdAt: r.created_at,
    }));
  }

  /**
   * Document chunks, ranked by Postgres full-text search.
   *
   * Not loaded into memory and ranked in TypeScript like items are, and the difference
   * is not stylistic. Items are a few hundred short curated sentences per person;
   * chunks are every paragraph of every document they have ever uploaded, and the
   * storage limit is ten gigabytes. Pulling that into the process to score it is a
   * query that works in a demo and falls over on the first real user.
   *
   * `app.search_chunks` resolves the room scope inside the query through
   * `app.accessible_room_ids`. A post-filter over results is one forgotten line away
   * from returning another person's room, and that failure looks like a working search.
   */
  private async chunkHits(
    personId: PersonId,
    query: string,
    scope: RoomId[],
    limit: number,
  ): Promise<Array<Candidate & { rank: number }>> {
    const rows = await queryRows<{
      chunk_id: string;
      document_id: string;
      room_id: string;
      heading: string | null;
      text: string;
      rank: number;
    }>(
      this.pool,
      `SELECT chunk_id, document_id, room_id, heading, text, rank
       FROM app.search_chunks($1, $2, $3::uuid[], $4)`,
      [personId, query, scope, limit],
    );

    return rows.map((row) => ({
      kind: 'chunk' as const,
      id: row.chunk_id,
      roomId: row.room_id as RoomId,
      shortId: null,
      text: row.text,
      documentId: row.document_id,
      disputedBy: [],
      // Document ingestion does not expose a "when" through search yet — see
      // `SearchHit.createdAt`. Not this package's concern to add: chunking and its
      // schema belong to the platform track.
      createdAt: null,
      rank: row.rank,
    }));
  }
}

function rankLexically(query: string, candidates: Candidate[]): Candidate[] {
  const terms = dedupeHash(query).split(' ').filter(Boolean);
  if (terms.length === 0) return [];

  return candidates
    .map((candidate) => {
      const haystack = ` ${dedupeHash(candidate.text)} `;
      let score = 0;
      for (const term of terms) {
        if (haystack.includes(` ${term} `)) score += term.length;
        else if (haystack.includes(term)) score += term.length / 2;
      }
      return { candidate, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .map((x) => x.candidate);
}
