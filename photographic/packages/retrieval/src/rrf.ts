/**
 * Reciprocal Rank Fusion.
 *
 * Pure and database-free on purpose: fusion is the part of retrieval most likely to be
 * quietly wrong, and a test that needs Postgres running is a test nobody runs.
 *
 * The method (Cormack, Clarke & Buettcher, SIGIR 2009) throws away every arm's raw
 * score and keeps only its ordering:
 *
 *     score(d) = sum over arms a containing d of  weight(a) / (k + rank_a(d))
 *
 * Discarding the scores is the point. A `ts_rank_cd` value and a cosine similarity are
 * not on the same scale, are not even on the same *kind* of scale, and any attempt to
 * normalise them into comparability needs a corpus-wide distribution that changes
 * every time someone writes a memory. Ranks are always comparable. The price is that
 * a runaway-best result looks the same as a merely-first one, which is exactly the
 * trade RRF is famous for being right about in practice.
 */

import { ValidationError } from '@photographic/core';
import { DEFAULT_RRF_K } from './config.js';

export interface ArmEntry {
  /** Stable identity of the document across arms. */
  key: string;
  /** 1-based position within this arm. */
  rank: number;
  /** The arm's own score, carried through for explanation only. Never fused. */
  rawScore: number;
}

export interface Arm {
  name: string;
  /** Defaults to 1. An arm we trust less contributes proportionally less. */
  weight?: number;
  entries: ArmEntry[];
}

export interface ArmContribution {
  arm: string;
  rank: number;
  rawScore: number;
  weight: number;
  /** `weight / (k + rank)` -- this arm's share of the fused score. */
  contribution: number;
}

export interface FusedEntry {
  key: string;
  score: number;
  /** Ordered by contribution, strongest arm first. */
  arms: ArmContribution[];
}

export interface FuseOptions {
  k?: number;
}

/**
 * Fuses ranked arms into one ordering, strongest first.
 *
 * Ties break on the best rank the document achieved in any arm, then on key, so the
 * output is a total order and two identical inputs always produce identical output.
 * Unstable ordering in a search result is indistinguishable from a ranking bug.
 */
export function fuseRrf(arms: Arm[], options: FuseOptions = {}): FusedEntry[] {
  const k = options.k ?? DEFAULT_RRF_K;
  if (!Number.isFinite(k) || k <= 0) {
    throw new ValidationError(`RRF k must be a finite number greater than zero, got ${k}`);
  }

  const fused = new Map<string, FusedEntry>();

  for (const arm of arms) {
    const weight = arm.weight ?? 1;
    const seen = new Set<string>();

    for (const entry of arm.entries) {
      if (!Number.isInteger(entry.rank) || entry.rank < 1) {
        throw new ValidationError(
          `arm "${arm.name}" produced rank ${entry.rank} for ${entry.key}; ranks are 1-based integers`,
        );
      }
      // One arm listing the same document twice would double-count it. Keep the best
      // rank and drop the rest rather than silently inflating the score.
      if (seen.has(entry.key)) continue;
      seen.add(entry.key);

      const contribution = weight / (k + entry.rank);
      const existing = fused.get(entry.key);
      const armContribution: ArmContribution = {
        arm: arm.name,
        rank: entry.rank,
        rawScore: entry.rawScore,
        weight,
        contribution,
      };

      if (existing) {
        existing.score += contribution;
        existing.arms.push(armContribution);
      } else {
        fused.set(entry.key, { key: entry.key, score: contribution, arms: [armContribution] });
      }
    }
  }

  const out = [...fused.values()];
  for (const entry of out) {
    entry.arms.sort((a, b) => b.contribution - a.contribution || a.arm.localeCompare(b.arm));
  }

  out.sort(
    (a, b) =>
      b.score - a.score || bestRank(a) - bestRank(b) || a.key.localeCompare(b.key),
  );
  return out;
}

function bestRank(entry: FusedEntry): number {
  let best = Number.POSITIVE_INFINITY;
  for (const arm of entry.arms) best = Math.min(best, arm.rank);
  return best;
}
