/**
 * Retrieval.
 *
 * Scope is applied in the query that gathers candidates, never as a filter over
 * results -- the same rule `services-memory` states and the same reason: a post-filter
 * is one forgotten line away from leaking another person's room.
 *
 * Ranking is lexical only for now (word overlap, the same stand-in `services-memory`
 * uses for Postgres full-text ranking). Semantic ranking needs real embeddings from
 * `LlmPort.embed`, which the fake produces but which are not yet written to
 * `item.embedding` / `chunk.embedding` by this package's write path; wiring that in is
 * additive to this method; behaviour visible to a caller does not change.
 */

import type {
  Actor,
  ItemKind,
  LlmPort,
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

    const candidates = await this.candidatesIn(scope);
    if (candidates.length === 0) return [];

    // The embed call is kept so `LlmPort.embed` is exercised even though this method
    // does not yet rank by it (see file comment); dropping it silently would make it
    // easy to forget to wire in later.
    await this.llm.embed([query]);

    const ranked = rankLexically(query, candidates);

    return ranked.slice(0, input.limit ?? DEFAULT_SEARCH_LIMIT).map((candidate, index) => ({
      kind: candidate.kind,
      id: candidate.id,
      roomId: candidate.roomId,
      shortId: candidate.shortId,
      text: candidate.text,
      score: 1 / (60 + index + 1),
      documentId: candidate.documentId as never,
    }));
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
    const items = await queryRows<{ id: string; room_id: string; short_id: string; body: string }>(
      this.pool,
      `SELECT id, room_id, short_id, body FROM app.item
       WHERE room_id = ANY($1::uuid[]) AND status = 'active' AND sensitivity <> 'local_only'`,
      [scope],
    );
    const chunks = await queryRows<{ id: string; room_id: string; document_id: string; text: string }>(
      this.pool,
      `SELECT id, room_id, document_id, text FROM app.chunk WHERE room_id = ANY($1::uuid[])`,
      [scope],
    );

    return [
      ...items.map((r) => ({
        kind: 'item' as const,
        id: r.id,
        roomId: r.room_id as RoomId,
        shortId: r.short_id as ShortId,
        text: r.body,
        documentId: null,
      })),
      ...chunks.map((r) => ({
        kind: 'chunk' as const,
        id: r.id,
        roomId: r.room_id as RoomId,
        shortId: null,
        text: r.text,
        documentId: r.document_id,
      })),
    ];
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
