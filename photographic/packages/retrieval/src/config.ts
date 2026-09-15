/**
 * Tuning knobs for hybrid retrieval.
 *
 * Every number here is inlined into SQL text rather than bound as a parameter, because
 * several of them sit in positions Postgres will not accept a parameter in (a
 * `regconfig` argument that must stay index-matchable, a `LIMIT` inside a CTE whose
 * plan we care about). That makes validation non-optional: `resolveConfig` rejects
 * anything that is not a finite number or a plain identifier, so nothing that reaches
 * a query string can carry SQL with it. Caller input never travels this path -- it is
 * always a bind parameter.
 */

import { ValidationError } from '@photographic/core';

export interface RankingConfig {
  /** Age at which the recency boost has decayed to half its strength. */
  recencyHalfLifeDays: number;
  /** Maximum proportional lift a brand new row can earn. Mild on purpose. */
  recencyWeight: number;
  /** Maximum proportional lift a heavily used item can earn. */
  usageWeight: number;
  /** `use_count` at which the usage boost is considered saturated. */
  usageSaturation: number;
  /**
   * Multiplier applied to `archived` items. Archived means "demoted out of the always
   * injected profile", not "gone": the item stays findable, it just has to be clearly
   * better than a live one to outrank it.
   */
  archivedPenalty: number;
}

export interface RetrievalConfig {
  /**
   * Text search configuration for `to_tsvector` / `plainto_tsquery`.
   *
   * Default `'simple'`, and that is a deliberate choice rather than laziness.
   * Swedish is the primary language here, and the alternatives are all worse:
   *
   *  - `'english'` stems Swedish words with English rules. "budgeten" does not lose
   *    its definite suffix, "mötet" does not become "möte", but "bilar" happily loses
   *    an English plural "s" that was never there. Wrong stemming produces silent
   *    false positives that nobody can debug from the outside.
   *  - `'swedish'` (snowball) is correct-ish for Swedish but destroys the mixed
   *    Swedish/English text our users actually write, and it collapses product names
   *    and short ids, which are exactly the rare tokens retrieval must match exactly.
   *  - `'simple'` does no stemming at all: lowercase, split, drop nothing. Recall for
   *    inflected forms is recovered by the trigram arm and by the vector arm, both of
   *    which are language-agnostic, instead of by a stemmer that is confidently wrong.
   *
   * The frozen indexes (`item_fts_idx`, `chunk_fts_idx`) are built on
   * `to_tsvector('simple', ...)`, so changing this value gives up index support until
   * a matching index exists. It is injectable anyway, because the moment we have real
   * Swedish query logs we will want to A/B it.
   */
  textSearchConfig: string;

  /**
   * The `k` in Reciprocal Rank Fusion: `score = sum over arms of 1 / (k + rank)`.
   *
   * 60 is the value from Cormack, Clarke & Buettcher (SIGIR 2009), and it is not
   * magic -- it is a flattener. Small k makes rank 1 dominate everything, so a single
   * confident arm wins outright and the second arm may as well not exist. Large k
   * flattens the curve until fusion degenerates into "how many arms found this".
   * At k=60 the gap between rank 1 and rank 2 is about 1.6%, while an item found by
   * both arms roughly doubles its score: agreement between arms beats a narrow lead
   * within one arm, which is the entire reason to fuse rather than to pick.
   */
  rrfK: number;

  /** How many candidates each arm retrieves before fusion. */
  candidatePoolSize: number;

  /** Relative weight of the lexical arm in the fusion. */
  lexicalWeight: number;
  /** Relative weight of the vector arm in the fusion. */
  vectorWeight: number;

  defaultLimit: number;
  maxLimit: number;

  /**
   * Scale factor applied to a trigram-only lexical score.
   *
   * Full-text hits score via `ts_rank_cd(..., 32)`, which is bounded in `[0, 1)`, plus
   * a bonus when every query term is present. Trigram similarity is also `[0, 1]` but
   * means something much weaker: "these strings look alike". Scaling it down keeps the
   * fallback ordered strictly below every genuine full-text match, so a misspelling is
   * rescued without a fuzzy match ever displacing an exact one.
   */
  trigramFallbackScale: number;

  /** Bonus added when a row matches every query term, not just some of them. */
  allTermsBonus: number;

  /**
   * Whether the trigram fallback also runs over `app.chunk.text`.
   *
   * Off by default. `app.item` has `item_body_trgm_idx`; `app.chunk` deliberately does
   * not, and the schema is frozen. Running `%>` over chunk text means a sequential
   * scan of every chunk in every accessible room, which is fine on a laptop and fatal
   * on a room with a few thousand pages in it. Documents are long enough that the
   * full-text arm plus the vector arm already cover misspellings adequately.
   */
  trigramOnChunks: boolean;

  /**
   * Extra floor on `word_similarity` for the trigram arm, or null to use the
   * connection's `pg_trgm.word_similarity_threshold` (0.6 by default).
   *
   * This can only narrow. The `%>` operator is what lets the GIN trigram index answer
   * the query at all, and it is gated by the GUC; an application-level number cannot
   * widen past it, only tighten inside it. Lowering the real threshold is a connection
   * setting, and pretending otherwise here would be a lie in a config field.
   */
  wordSimilarityThreshold: number | null;

  /**
   * Cosine distance above which a vector candidate is discarded, or null for no cut.
   *
   * Null by default. A nearest-neighbour arm always returns its k nearest rows, so
   * there is no such thing as "no vector results" -- there is only "the nearest thing
   * we have, which may be nonsense". A cutoff is the honest fix, but the right value
   * depends on the embedding model, and a wrong one silently deletes correct answers.
   * So it ships off, with the fusion and the ranking left to demote the noise, and it
   * is tuned per model once we can measure it.
   */
  maxVectorDistance: number | null;

  /** Dimension of the embedding column. Mismatches skip the vector arm loudly. */
  embeddingDimensions: number;

  ranking: RankingConfig;
}

export const DEFAULT_RRF_K = 60;

export const DEFAULT_RETRIEVAL_CONFIG: RetrievalConfig = {
  textSearchConfig: 'simple',
  rrfK: DEFAULT_RRF_K,
  candidatePoolSize: 60,
  lexicalWeight: 1,
  vectorWeight: 1,
  defaultLimit: 20,
  maxLimit: 100,
  trigramFallbackScale: 0.01,
  allTermsBonus: 0.5,
  trigramOnChunks: false,
  wordSimilarityThreshold: null,
  maxVectorDistance: null,
  embeddingDimensions: 1536,
  ranking: {
    recencyHalfLifeDays: 90,
    recencyWeight: 0.1,
    usageWeight: 0.15,
    usageSaturation: 10,
    archivedPenalty: 0.4,
  },
};

/** Postgres text search configuration names are plain identifiers. Nothing else. */
const IDENTIFIER = /^[a-z_][a-z0-9_]*$/;

export function resolveConfig(overrides: Partial<RetrievalConfig> = {}): RetrievalConfig {
  const config: RetrievalConfig = {
    ...DEFAULT_RETRIEVAL_CONFIG,
    ...overrides,
    ranking: { ...DEFAULT_RETRIEVAL_CONFIG.ranking, ...(overrides.ranking ?? {}) },
  };

  if (!IDENTIFIER.test(config.textSearchConfig)) {
    throw new ValidationError(
      `textSearchConfig must be a plain identifier, got ${JSON.stringify(config.textSearchConfig)}`,
    );
  }

  positive('rrfK', config.rrfK);
  positive('candidatePoolSize', config.candidatePoolSize);
  positive('defaultLimit', config.defaultLimit);
  positive('maxLimit', config.maxLimit);
  positive('embeddingDimensions', config.embeddingDimensions);
  nonNegative('lexicalWeight', config.lexicalWeight);
  nonNegative('vectorWeight', config.vectorWeight);
  nonNegative('trigramFallbackScale', config.trigramFallbackScale);
  nonNegative('allTermsBonus', config.allTermsBonus);
  positive('ranking.recencyHalfLifeDays', config.ranking.recencyHalfLifeDays);
  positive('ranking.usageSaturation', config.ranking.usageSaturation);
  nonNegative('ranking.recencyWeight', config.ranking.recencyWeight);
  nonNegative('ranking.usageWeight', config.ranking.usageWeight);
  nonNegative('ranking.archivedPenalty', config.ranking.archivedPenalty);

  if (config.wordSimilarityThreshold !== null) {
    nonNegative('wordSimilarityThreshold', config.wordSimilarityThreshold);
  }
  if (config.maxVectorDistance !== null) {
    nonNegative('maxVectorDistance', config.maxVectorDistance);
  }

  return config;
}

function positive(name: string, value: number): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new ValidationError(`${name} must be a finite number greater than zero, got ${value}`);
  }
}

function nonNegative(name: string, value: number): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new ValidationError(`${name} must be a finite number of at least zero, got ${value}`);
  }
}
