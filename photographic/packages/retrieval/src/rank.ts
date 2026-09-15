/**
 * Post-fusion ranking adjustments.
 *
 * Kept pure, synchronous and separate from `search.ts` so that the interesting part --
 * "why is this above that" -- is testable without a database, a query planner or an
 * embedding model. Everything here is a multiplier on the fused score, never a
 * reordering rule, so the adjustments compose and every one of them can be reported
 * back through `explain.ts` with the exact factor it applied.
 *
 * Status handling is the one hard rule rather than a multiplier:
 *
 *  - `deleted` and `superseded` are excluded outright. Soft delete only works if the
 *    soft-deleted thing genuinely stops coming back, and a superseded item is by
 *    definition the wrong version of something we also have the right version of.
 *  - `archived` is penalised, not excluded. Archived means "evicted from the profile
 *    that gets injected every session", which is a budget decision, not a statement
 *    that the memory is false. It must stay findable, just not at the top.
 *
 * The SQL already filters `deleted` and `superseded` out; doing it again here is
 * deliberate duplication. This function is exported and pure, so it will eventually be
 * called from somewhere other than our own query, and a leak that only one of the two
 * layers prevents is a leak waiting for its second caller.
 */

import type { DocumentId, ItemStatus, RoomId, SearchHit, ShortId } from '@photographic/core';
import type { RankingConfig } from './config.js';
import { DEFAULT_RETRIEVAL_CONFIG } from './config.js';

/** Statuses that never appear in a search result, whatever their score. */
export const EXCLUDED_STATUSES: readonly ItemStatus[] = ['deleted', 'superseded'];

export interface RankableHit {
  /** Stable identity across arms: `item:<uuid>` or `chunk:<uuid>`. */
  key: string;
  kind: 'item' | 'chunk';
  id: string;
  roomId: RoomId;
  shortId: ShortId | null;
  text: string;
  documentId: DocumentId | null;
  /** Null for chunks, which have no lifecycle of their own. */
  status: ItemStatus | null;
  createdAt: Date;
  lastUsedAt: Date | null;
  useCount: number;
  fusedScore: number;
  /**
   * One side of an unresolved disagreement between two members of a room.
   *
   * Never used to rank — a disputed statement is not less relevant, and demoting it would
   * be a quiet way of picking a winner. It rides along so the caller can keep both sides
   * together and label them.
   */
  disputed?: boolean;
}

export interface RankAdjustment {
  /** Stable machine-readable label, rendered in the debug view. */
  reason: 'recency' | 'usage' | 'archived';
  factor: number;
  detail: string;
}

export interface RankedHit extends RankableHit {
  score: number;
  adjustments: RankAdjustment[];
}

export interface RankOptions {
  now: Date;
  config?: RankingConfig;
}

/**
 * Applies exclusions and boosts, returning hits ordered by final score.
 *
 * Ties break on the pre-adjustment fused score and then on key, so the result is a
 * total order regardless of how the adjustments happen to land.
 */
export function applyRanking(hits: RankableHit[], options: RankOptions): RankedHit[] {
  const config = options.config ?? DEFAULT_RETRIEVAL_CONFIG.ranking;
  const nowMs = options.now.getTime();

  const ranked: RankedHit[] = [];

  for (const hit of hits) {
    if (hit.status !== null && EXCLUDED_STATUSES.includes(hit.status)) continue;

    const adjustments: RankAdjustment[] = [];
    let score = hit.fusedScore;

    const recency = recencyFactor(hit.createdAt, nowMs, config);
    if (recency !== 1) {
      adjustments.push({
        reason: 'recency',
        factor: recency,
        detail: `${ageInDays(hit.createdAt, nowMs).toFixed(1)}d old, half-life ${config.recencyHalfLifeDays}d`,
      });
      score *= recency;
    }

    const usage = usageFactor(hit, nowMs, config);
    if (usage !== 1) {
      adjustments.push({
        reason: 'usage',
        factor: usage,
        detail: `used ${hit.useCount}x${hit.lastUsedAt ? `, last ${ageInDays(hit.lastUsedAt, nowMs).toFixed(1)}d ago` : ''}`,
      });
      score *= usage;
    }

    if (hit.status === 'archived') {
      adjustments.push({
        reason: 'archived',
        factor: config.archivedPenalty,
        detail: 'demoted from the profile, still findable',
      });
      score *= config.archivedPenalty;
    }

    ranked.push({ ...hit, score, adjustments });
  }

  ranked.sort(
    (a, b) => b.score - a.score || b.fusedScore - a.fusedScore || a.key.localeCompare(b.key),
  );
  return ranked;
}

/**
 * Mild exponential decay on age. At most `recencyWeight` extra for something written
 * seconds ago, decaying by half every `recencyHalfLifeDays`.
 *
 * Mild is the whole design. "Allergic to ketchup" was true four years ago and is still
 * true; a recency boost strong enough to bury it is a recency boost that has replaced
 * the product with a news feed. This exists to break ties between comparable memories,
 * not to rank by date.
 */
export function recencyFactor(createdAt: Date, nowMs: number, config: RankingConfig): number {
  if (config.recencyWeight === 0) return 1;
  const days = ageInDays(createdAt, nowMs);
  return 1 + config.recencyWeight * Math.pow(0.5, days / config.recencyHalfLifeDays);
}

/**
 * Boosts items that have actually been used before.
 *
 * `use_count` saturates logarithmically -- the difference between never used and used
 * twice matters, the difference between forty and eighty times does not -- and the
 * boost is halved for items whose last use is long past, so a burst of use two years
 * ago decays back towards neutral.
 *
 * Note that `app.item.use_count` is per item, not per person. The schema is frozen and
 * carries no per-person usage table, so "items the person has used before" is
 * approximated by "items that have been used before" wherever a room has more than one
 * member. In a personal room, which is where this boost matters most, the two are the
 * same thing.
 */
export function usageFactor(
  hit: Pick<RankableHit, 'useCount' | 'lastUsedAt'>,
  nowMs: number,
  config: RankingConfig,
): number {
  if (config.usageWeight === 0 || hit.useCount <= 0) return 1;

  const saturation = Math.min(
    1,
    Math.log1p(hit.useCount) / Math.log1p(config.usageSaturation),
  );
  const freshness = hit.lastUsedAt
    ? Math.pow(0.5, ageInDays(hit.lastUsedAt, nowMs) / config.recencyHalfLifeDays)
    : 0;

  return 1 + config.usageWeight * saturation * (0.5 + 0.5 * freshness);
}

function ageInDays(at: Date, nowMs: number): number {
  return Math.max(0, (nowMs - at.getTime()) / 86_400_000);
}

/** Drops the internal ranking fields, leaving the shape the port promises. */
export function toSearchHit(hit: RankedHit): SearchHit {
  return {
    kind: hit.kind,
    id: hit.id,
    roomId: hit.roomId,
    shortId: hit.shortId,
    text: hit.text,
    score: hit.score,
    documentId: hit.documentId,
    disputed: hit.disputed ?? false,
  };
}
