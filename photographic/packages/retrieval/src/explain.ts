/**
 * Why each hit matched.
 *
 * Silent retrieval is unfixable retrieval. When someone says "it did not find my note
 * about the boiler", the only useful answers are "the lexical arm had it at rank 40
 * and the cut was 20", "neither arm saw it because it is in a room you left" or "it
 * matched but the archived penalty pushed it under". None of those are recoverable
 * from a bare list of results, so search produces them as a first-class output rather
 * than as log lines nobody will have kept.
 *
 * This is consumed by the web app's debug view and by our own tests, which is why it
 * is a pure data structure built by a pure function: the explanation is derived from
 * the same values the ranking used, not reconstructed afterwards from a guess.
 */

import type { RoomId, SearchHit } from '@photographic/core';
import type { ArmContribution, FusedEntry } from './rrf.js';
import type { RankAdjustment, RankedHit } from './rank.js';

export type ArmName = 'lexical' | 'vector';

export interface HitExplanation {
  key: string;
  kind: 'item' | 'chunk';
  id: string;
  roomId: RoomId;
  /** Present for items so a model can act on the hit directly. */
  shortId: string | null;
  /** Which arms found this, with their rank inside each arm. Strongest arm first. */
  arms: ArmContribution[];
  /** Sum of the arm contributions, before ranking adjustments. */
  fusedScore: number;
  adjustments: RankAdjustment[];
  /** What the caller sees as `SearchHit.score`. */
  finalScore: number;
  /** 1-based position in the returned list. */
  finalRank: number;
}

export interface ArmReport {
  arm: ArmName;
  /** True when the arm actually ran. */
  used: boolean;
  /** Candidates the arm contributed to the fusion. */
  candidates: number;
  /** Set when `used` is false. */
  skippedReason?: string;
}

export interface ScopeReport {
  /** What the caller asked for, or null when they asked for everything they can read. */
  requestedRoomIds: RoomId[] | null;
  /** Rooms the actor can actually reach right now. */
  accessibleRoomIds: RoomId[];
  /** The intersection that the SQL was scoped to. Never wider than `accessible`. */
  searchedRoomIds: RoomId[];
}

export interface ExplainedSearch {
  query: string;
  hits: SearchHit[];
  explanations: HitExplanation[];
  scope: ScopeReport;
  arms: ArmReport[];
  rrfK: number;
  /** Candidates fused, before ranking exclusions and the limit. */
  fusedCandidates: number;
  /** Non-fatal degradations, e.g. the embedder being unavailable. */
  warnings: string[];
  tookMs: number;
}

/**
 * Pairs each ranked hit with the arm evidence that produced it.
 *
 * Hits whose fused entry is missing are impossible by construction -- the ranking runs
 * over the fusion output -- but rather than assert, an absent entry degrades to "no
 * arm evidence" so a bug in the pipeline shows up in the debug view instead of
 * throwing in front of a user.
 */
export function buildExplanations(
  ranked: RankedHit[],
  fused: Map<string, FusedEntry>,
): HitExplanation[] {
  return ranked.map((hit, index) => ({
    key: hit.key,
    kind: hit.kind,
    id: hit.id,
    roomId: hit.roomId,
    shortId: hit.shortId,
    arms: fused.get(hit.key)?.arms ?? [],
    fusedScore: hit.fusedScore,
    adjustments: hit.adjustments,
    finalScore: hit.score,
    finalRank: index + 1,
  }));
}

/** One-line human-readable rendering, for the debug view and for failing tests. */
export function formatExplanation(explanation: HitExplanation): string {
  const arms = explanation.arms.length
    ? explanation.arms
        .map((a) => `${a.arm}#${a.rank} (raw ${a.rawScore.toFixed(4)})`)
        .join(' + ')
    : 'no arm';
  const adjustments = explanation.adjustments.length
    ? ` [${explanation.adjustments.map((a) => `${a.reason} x${a.factor.toFixed(2)}`).join(', ')}]`
    : '';
  const label = explanation.shortId ?? `${explanation.kind}:${explanation.id.slice(0, 8)}`;

  return `${explanation.finalRank}. ${label} ${arms} -> fused ${explanation.fusedScore.toFixed(
    5,
  )}${adjustments} = ${explanation.finalScore.toFixed(5)}`;
}
