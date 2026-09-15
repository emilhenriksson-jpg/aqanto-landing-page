/**
 * Retrieval.
 *
 * The scope is applied while gathering candidates, never as a filter over results. That
 * distinction is the whole security model of shared rooms: a post-filter is one
 * forgotten line away from returning another person's memories, and the forgotten line
 * is invisible until someone notices their private room in a colleague's answer.
 *
 * Lexical and vector scores are fused with reciprocal rank rather than added, because
 * the two produce incomparable numbers and normalising them means choosing a weighting
 * that is wrong for one of them.
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

import { MemoryStore } from './store.js';

export const DEFAULT_SEARCH_LIMIT = 10;

/** Reciprocal-rank fusion constant. 60 is the value the original RRF paper settled on. */
const RRF_K = 60;

interface Candidate {
  kind: 'item' | 'chunk';
  id: string;
  roomId: RoomId;
  shortId: ShortId | null;
  text: string;
  documentId: import('@photographic/core').DocumentId | null;
  embedding: number[] | null;
  /** When an item was saved. `null` for a chunk — see `SearchHit.createdAt`. */
  createdAt: Date | null;
}

export class MemoryRetrieval implements RetrievalPort {
  constructor(
    private readonly store: MemoryStore,
    private readonly llm: LlmPort,
  ) {}

  async search(
    actor: Actor,
    input: { query: string; roomIds?: RoomId[]; limit?: number },
  ): Promise<SearchHit[]> {
    const query = input.query.trim();
    if (!query) return [];

    // Intersection, not replacement: a requested room list narrows the search, and a
    // room the actor cannot read is silently absent rather than an error, because
    // reporting it would confirm the room exists.
    const reachable = new Set(this.store.accessibleRoomIds(actor.personId));
    const scope = input.roomIds?.length
      ? input.roomIds.filter((id) => reachable.has(id))
      : [...reachable];
    if (scope.length === 0) return [];

    const candidates = this.candidatesIn(new Set(scope));
    if (candidates.length === 0) return [];

    const lexical = rankLexically(query, candidates);
    const [queryVector] = await this.llm.embed([query]);
    const semantic = rankSemantically(queryVector!, candidates);

    const fused = new Map<string, { candidate: Candidate; score: number }>();
    const contribute = (ranked: Candidate[]) => {
      ranked.forEach((candidate, index) => {
        const existing = fused.get(candidate.id);
        const score = 1 / (RRF_K + index + 1);
        if (existing) existing.score += score;
        else fused.set(candidate.id, { candidate, score });
      });
    };
    contribute(lexical);
    contribute(semantic);

    const hits = [...fused.values()]
      .sort((a, b) => b.score - a.score)
      .slice(0, input.limit ?? DEFAULT_SEARCH_LIMIT)
      .map(({ candidate, score }) => ({
        kind: candidate.kind,
        id: candidate.id,
        roomId: candidate.roomId,
        shortId: candidate.shortId,
        text: candidate.text,
        score,
        documentId: candidate.documentId,
        disputed: this.isDisputed(candidate.id),
        createdAt: candidate.createdAt,
      }));

    return this.withDisputedPartners(hits);
  }

  async listForRoom(
    actor: Actor,
    roomId: RoomId,
  ): Promise<Array<{ shortId: ShortId; kind: ItemKind; body: string }>> {
    if (!this.store.canRead(actor.personId, roomId)) throw new NotPermittedError();

    return this.store
      .itemsInRoom(roomId)
      .filter((item) => item.status === 'active')
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .map((item) => ({ shortId: item.shortId, kind: item.kind, body: item.body }));
  }

  private isDisputed(id: string): boolean {
    return (this.store.items.get(id as never)?.disputedBy.length ?? 0) > 0;
  }

  /**
   * A disputed statement never travels alone.
   *
   * If one side of a disagreement matches the query, the other side comes with it even
   * when it ranks below the cut. A model handed one of two contradictory statements
   * answers confidently and wrongly; a model handed both says there are two different
   * answers, which is true and is also what gets a person to settle it. Appended past the
   * limit rather than displacing a better hit, because this is about completeness rather
   * than relevance.
   */
  private withDisputedPartners(hits: SearchHit[]): SearchHit[] {
    const present = new Set(hits.map((hit) => hit.id));
    const extra: SearchHit[] = [];

    for (const hit of hits) {
      if (!hit.disputed) continue;
      const item = this.store.items.get(hit.id as never);
      if (!item) continue;

      for (const partnerId of item.disputedBy) {
        if (present.has(partnerId)) continue;
        const partner = this.store.items.get(partnerId);
        if (!partner || partner.status !== 'active') continue;

        present.add(partnerId);
        extra.push({
          kind: 'item',
          id: partner.id,
          roomId: partner.roomId,
          shortId: partner.shortId,
          text: partner.body,
          score: hit.score,
          documentId: null,
          disputed: true,
          createdAt: partner.createdAt,
        });
      }
    }

    return [...hits, ...extra];
  }

  /**
   * Only active items are searchable.
   *
   * A deleted memory that still turns up in search has not been deleted in any sense
   * the person would recognise, no matter what the trash screen says.
   */
  private candidatesIn(scope: Set<RoomId>): Candidate[] {
    const out: Candidate[] = [];

    for (const item of this.store.items.values()) {
      if (!scope.has(item.roomId)) continue;
      if (item.status !== 'active') continue;
      if (item.sensitivity === 'local_only') continue;
      out.push({
        kind: 'item',
        id: item.id,
        roomId: item.roomId,
        shortId: item.shortId,
        text: item.body,
        documentId: null,
        embedding: this.store.embeddings.get(item.id) ?? null,
        createdAt: item.createdAt,
      });
    }

    for (const chunk of this.store.chunks.values()) {
      if (!scope.has(chunk.roomId)) continue;
      out.push({
        kind: 'chunk',
        id: chunk.id,
        roomId: chunk.roomId,
        shortId: null,
        text: chunk.text,
        documentId: chunk.documentId,
        embedding: chunk.embedding,
        // Document ingestion does not expose a "when" through search yet — see
        // `SearchHit.createdAt`. Not this package's concern to add: chunking and its
        // schema belong to the platform track.
        createdAt: null,
      });
    }

    return out;
  }
}

/** Stands in for Postgres full-text ranking: term overlap, longer terms worth more. */
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

function rankSemantically(queryVector: number[], candidates: Candidate[]): Candidate[] {
  return candidates
    .filter((c) => c.embedding !== null)
    .map((candidate) => ({ candidate, score: cosine(queryVector, candidate.embedding!) }))
    // Unrelated text scores near zero against a hash-derived embedding, and letting it
    // through would put every memory in every result set at some rank.
    .filter((x) => x.score > 0.05)
    .sort((a, b) => b.score - a.score)
    .map((x) => x.candidate);
}

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i += 1) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}
