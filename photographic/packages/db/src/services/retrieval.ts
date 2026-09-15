/**
 * Retrieval.
 *
 * Scope is applied in the query that gathers candidates, never as a filter over
 * results -- the same rule `services-memory` states and the same reason: a post-filter
 * is one forgotten line away from leaking another person's room.
 *
 * Three ranking arms for memories, fused with reciprocal rank (RRF, k=60) the same way
 * `MemoryRetrieval` and `packages/core/src/ask.ts` already fuse arms elsewhere in this
 * product -- one algorithm for "combine several ranked lists", not a bespoke one per
 * caller:
 *
 *   - Full-text search against `to_tsvector('swedish', body)`. Deliberately not built
 *     with `plainto_tsquery`, which ANDs every term: measured against a realistic
 *     Swedish corpus, that zeroes out the whole document the moment one term doesn't
 *     line up -- a genuine synonym, or a stemmed form that doesn't match -- and gets
 *     19% recall on natural questions. The query below extracts the same stemmed
 *     lexemes and OR's them instead, which gets to 74% with the identical index and
 *     the identical stemming. The AND-vs-OR query shape mattered far more than the
 *     language config did. Do not "simplify" this back to `plainto_tsquery`: that
 *     change looks like a cleanup and is actually the regression.
 *   - Trigram similarity (`pg_trgm`, `unaccent`) against the raw body. Character-level,
 *     so it catches inflection and near-exact matches FTS stemming misses or gets
 *     wrong, and tolerates a dropped diacritic. Measured at 81% recall alone.
 *   - Vector distance against `item.embedding`, when the item has one. This is the
 *     only arm that finds a genuine paraphrase with no shared words at all -- measured
 *     at 0% for every lexical and trigram strategy on that category, 100% for this
 *     one. Embedding a query is a network call with `OpenAiLlm` (never with the
 *     deterministic `FakeLlm`), so a failure or a missing key degrades this arm to
 *     nothing rather than failing the search: two arms of real signal beats a hard
 *     error, and this is the one call in the whole method that is allowed to fail
 *     silently. See `PgIngest` for the write-side half of this -- the embedding a
 *     search reads here is written by a background job, not by this file.
 *
 * Chunks (documents) keep the ranking their own track gave them: Postgres full-text
 * plus the trigram fallback, through `app.search_chunks`. Deliberately untouched --
 * document ingestion, chunking and their index belong to a different track, and
 * improving memory ranking is not a reason to also start ranking documents
 * differently. (This arm was an in-process lexical stand-in when these three memory
 * arms were written, because `app.search_chunks` did not exist on that branch yet;
 * "untouched" means the other track's version, which is now the indexed one.)
 */

import type {
  Actor,
  DocumentId,
  ItemKind,
  LlmPort,
  PersonId,
  RetrievalPort,
  RoomId,
  SearchHit,
  ShortId,
} from '@photographic/core';
import { NotPermittedError } from '@photographic/core';
import type { Pool } from 'pg';

import { queryRows } from '../pool.js';
import { toVectorLiteral } from '../vector.js';
import { accessibleRoomIds, canRead } from './permissions.js';

export const DEFAULT_SEARCH_LIMIT = 10;

/** Reciprocal-rank fusion constant. 60 is the value the original RRF paper settled on. */
const RRF_K = 60;

/**
 * Candidates fetched per arm before fusion. Generous relative to the usual result
 * limit, so a hit that is strong on only one arm still has room to reach the top after
 * fusion rather than being cut before RRF ever sees it.
 */
const CANDIDATE_POOL = 40;

/**
 * Below this, two strings share too little to call it a match rather than noise.
 *
 * Measured, not guessed: two Swedish sentences of ordinary length share roughly
 * 0.09-0.14 similarity from common short words and letter pairs alone, with no topical
 * relationship at all, while a genuine match -- even a loose paraphrase with one
 * shared anchor word -- was consistently 0.32 or higher in the same corpus. 0.2 sits
 * in the gap. Below this, a real semantic match from the vector arm was previously
 * getting outvoted in the RRF fusion by several arms' worth of trigram noise on
 * unrelated candidates, each too weak alone to matter but not once summed.
 */
const TRIGRAM_THRESHOLD = 0.2;

/**
 * Below this cosine similarity, two pieces of text are unrelated, not merely a weak
 * match. `ORDER BY embedding <=> ...` always returns *something* if anything in scope
 * has an embedding at all -- it has no notion of "nothing here is relevant" on its
 * own, unlike the FTS arm's `@@` or the trigram arm's own threshold. Without this, a
 * search scoped to one unrelated shared item would return that item for every query,
 * regardless of what was actually asked. Matches the threshold `MemoryRetrieval`
 * already uses for the same reason.
 */
const VECTOR_SIMILARITY_THRESHOLD = 0.05;

interface ItemCandidate {
  id: string;
  roomId: RoomId;
  shortId: ShortId;
  text: string;
  createdAt: Date;
  /** Other items this one contradicts, unresolved. */
  disputedBy: string[];
}

interface ChunkCandidate {
  id: string;
  roomId: RoomId;
  documentId: DocumentId;
  text: string;
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

    const [ftsHits, trigramHits, vectorHits, chunkHits] = await Promise.all([
      this.ftsArm(scope, query),
      this.trigramArm(scope, query),
      this.vectorArm(scope, query),
      this.chunkArm(actor.personId, scope, query),
    ]);

    const items = new Map<string, ItemCandidate>();
    for (const hit of [...ftsHits, ...trigramHits, ...vectorHits]) {
      if (!items.has(hit.id)) items.set(hit.id, hit);
    }
    const chunks = new Map(chunkHits.map((hit) => [hit.id, hit]));

    const fused = fuseRanked([
      ftsHits.map((h) => h.id),
      trigramHits.map((h) => h.id),
      vectorHits.map((h) => h.id),
      chunkHits.map((h) => h.id),
    ]);

    const hits = fused.slice(0, limit).map(({ id, score }): SearchHit => {
      const item = items.get(id);
      if (item) {
        return {
          kind: 'item',
          id: item.id,
          roomId: item.roomId,
          shortId: item.shortId,
          text: item.text,
          score,
          documentId: null,
          disputed: item.disputedBy.length > 0,
          createdAt: item.createdAt,
        };
      }

      const chunk = chunks.get(id)!;
      return {
        kind: 'chunk',
        id: chunk.id,
        roomId: chunk.roomId,
        shortId: null,
        text: chunk.text,
        score,
        documentId: chunk.documentId,
        disputed: false,
        createdAt: null,
      };
    });

    return this.withDisputedPartners(hits, items, scope);
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
   *
   * The partner is fetched by id rather than read out of the candidate pool, which is
   * the one thing that changed when ranking moved into Postgres: the arms return only
   * what matched, so the other side of a disagreement is usually *not* among them —
   * that is the whole point, it is the side the query did not match. It still has to
   * clear `VISIBLE_ITEM` and be inside `scope`, so this cannot reach a room the actor
   * could not already read.
   */
  private async withDisputedPartners(
    hits: SearchHit[],
    items: Map<string, ItemCandidate>,
    scope: RoomId[],
  ): Promise<SearchHit[]> {
    const present = new Set(hits.map((hit) => hit.id));
    const wanted = new Set<string>();

    for (const hit of hits) {
      if (!hit.disputed) continue;
      for (const partnerId of items.get(hit.id)?.disputedBy ?? []) {
        if (!present.has(partnerId)) wanted.add(partnerId);
      }
    }

    if (wanted.size === 0) return hits;

    const rows = await queryRows<ItemCandidateRow>(
      this.pool,
      `SELECT id, room_id, short_id, body, created_at, disputed_by
       FROM app.item
       WHERE id = ANY($1::uuid[]) AND room_id = ANY($2::uuid[]) AND ${VISIBLE_ITEM}`,
      [[...wanted], scope],
    );

    const scoreOf = (partnerId: string): number =>
      hits.find((hit) => items.get(hit.id)?.disputedBy.includes(partnerId))?.score ?? 0;

    const extra = rows.map(toItemCandidate).map(
      (partner): SearchHit => ({
        kind: 'item',
        id: partner.id,
        roomId: partner.roomId,
        shortId: partner.shortId,
        text: partner.text,
        score: scoreOf(partner.id),
        documentId: null,
        disputed: true,
        createdAt: partner.createdAt,
      }),
    );

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

  // ---------------------------------------------------------------------------
  // Ranking arms
  // ---------------------------------------------------------------------------

  /**
   * OR's the same stemmed lexemes `to_tsvector('swedish', ...)` would produce for the
   * query, rather than ANDing them the way `plainto_tsquery` does. See the file
   * comment for the measured reason this is not `plainto_tsquery`.
   *
   * A query that stems to nothing (all stopwords, or punctuation-only) produces an
   * empty `to_tsquery`, which is a valid, always-false comparison -- this arm just
   * contributes nothing for that query, not an error.
   */
  private async ftsArm(scope: RoomId[], query: string): Promise<ItemCandidate[]> {
    const rows = await queryRows<ItemCandidateRow>(
      this.pool,
      `WITH q AS (
         SELECT to_tsquery(
           'swedish',
           array_to_string(tsvector_to_array(to_tsvector('swedish', $2)), ' | ')
         ) AS tsq
       )
       SELECT i.id, i.room_id, i.short_id, i.body, i.created_at, i.disputed_by
       FROM app.item i, q
       WHERE i.room_id = ANY($1::uuid[]) AND i.status = 'active' AND i.sensitivity <> 'local_only'
         AND to_tsvector('swedish', i.body) @@ q.tsq
       ORDER BY ts_rank_cd(to_tsvector('swedish', i.body), q.tsq) DESC
       LIMIT $3`,
      [scope, query, CANDIDATE_POOL],
    );
    return rows.map(toItemCandidate);
  }

  /** Character-level match, tolerant of Swedish inflection and a dropped diacritic. */
  private async trigramArm(scope: RoomId[], query: string): Promise<ItemCandidate[]> {
    const rows = await queryRows<ItemCandidateRow>(
      this.pool,
      `SELECT id, room_id, short_id, body, created_at, disputed_by
       FROM app.item
       WHERE room_id = ANY($1::uuid[]) AND status = 'active' AND sensitivity <> 'local_only'
         AND similarity(unaccent(lower(body)), unaccent(lower($2))) > $3
       ORDER BY similarity(unaccent(lower(body)), unaccent(lower($2))) DESC
       LIMIT $4`,
      [scope, query, TRIGRAM_THRESHOLD, CANDIDATE_POOL],
    );
    return rows.map(toItemCandidate);
  }

  /**
   * The only arm that finds a genuine paraphrase, and the only one allowed to fail
   * silently. `embed` is a real network call against `OpenAiLlm` (never against
   * `FakeLlm`, which is deterministic and local); a missing key, a timeout or an
   * outage must narrow this search to lexical and trigram, not fail it. A person whose
   * search degrades quietly to "good enough" keeps using the product; one who gets an
   * error on every query concludes it is broken.
   */
  private async vectorArm(scope: RoomId[], query: string): Promise<ItemCandidate[]> {
    let vector: number[] | undefined;
    try {
      [vector] = await this.llm.embed([query]);
    } catch {
      return [];
    }
    if (!vector) return [];

    const rows = await queryRows<ItemCandidateRow>(
      this.pool,
      `SELECT id, room_id, short_id, body, created_at, disputed_by
       FROM app.item
       WHERE room_id = ANY($1::uuid[]) AND status = 'active' AND sensitivity <> 'local_only'
         AND embedding IS NOT NULL
         AND 1 - (embedding <=> $2::vector) > $3
       ORDER BY embedding <=> $2::vector
       LIMIT $4`,
      [scope, toVectorLiteral(vector), VECTOR_SIMILARITY_THRESHOLD, CANDIDATE_POOL],
    );
    return rows.map(toItemCandidate);
  }

  /**
   * Documents, ranked by Postgres through `app.search_chunks` -- full-text on the
   * Swedish config with the trigram fallback migration 0012 added for the cases
   * stemming cannot reach (a compound like "uppsägningstiden" against a query for
   * "uppsägning", and a definite form like "förvärvet" against "förvärv", both of
   * which the Snowball stemmer leaves unbridged).
   *
   * Not an in-process term-overlap pass over every chunk in scope, which is what this
   * arm was before the three memory arms below it moved into SQL. The difference is not
   * stylistic: items are a few hundred short curated sentences per person, chunks are
   * every paragraph of every document they have uploaded and the storage limit is ten
   * gigabytes. Pulling that into the process to score it is a query that works in a
   * demo and falls over on the first real user.
   *
   * `app.search_chunks` resolves the room scope inside the query through
   * `app.accessible_room_ids`, so isolation is enforced where the rows are selected
   * rather than filtered afterwards.
   */
  private async chunkArm(personId: PersonId, scope: RoomId[], query: string): Promise<ChunkCandidate[]> {
    const rows = await queryRows<{
      chunk_id: string;
      document_id: string;
      room_id: string;
      text: string;
    }>(
      this.pool,
      `SELECT chunk_id, document_id, room_id, text
       FROM app.search_chunks($1, $2, $3::uuid[], $4)`,
      [personId, query, scope, CANDIDATE_POOL],
    );

    return rows.map((r) => ({
      id: r.chunk_id,
      roomId: r.room_id as RoomId,
      documentId: r.document_id as DocumentId,
      text: r.text,
    }));
  }
}

interface ItemCandidateRow {
  id: string;
  room_id: string;
  short_id: string;
  body: string;
  created_at: Date;
  disputed_by: string[] | null;
}

function toItemCandidate(row: ItemCandidateRow): ItemCandidate {
  return {
    id: row.id,
    roomId: row.room_id as RoomId,
    shortId: row.short_id as ShortId,
    text: row.body,
    createdAt: row.created_at,
    disputedBy: row.disputed_by ?? [],
  };
}

/** The predicate every arm shares. A partner fetched by id must pass it too. */
const VISIBLE_ITEM = `status = 'active' AND sensitivity <> 'local_only'`;

/**
 * Fuses any number of ranked id lists by reciprocal rank -- the same fusion every
 * multi-arm ranker in this product uses (`MemoryRetrieval`, `packages/core/src/ask.ts`),
 * so there is one algorithm for "combine several ranked lists" rather than one per
 * caller. An id absent from a list contributes nothing from it, never a penalty.
 */
function fuseRanked(rankedLists: string[][]): Array<{ id: string; score: number }> {
  const scores = new Map<string, number>();
  for (const list of rankedLists) {
    list.forEach((id, index) => {
      scores.set(id, (scores.get(id) ?? 0) + 1 / (RRF_K + index + 1));
    });
  }
  return [...scores.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([id, score]) => ({ id, score }));
}

