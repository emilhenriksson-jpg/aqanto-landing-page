/**
 * The narrow surface this package needs from the outside world.
 *
 * Retrieval deliberately does not import `@photographic/db`. It needs exactly two
 * things -- something that can run a parameterised SQL statement, and something that
 * can turn text into vectors -- so it asks for exactly those. A `pg` `Pool`, a `pg`
 * `PoolClient` and the `Db` type from `@photographic/db` all satisfy `QueryRunner`
 * structurally, which means the same code runs against the shared pool in production
 * and against a throwaway pool inside a test transaction.
 */

import type { LlmPort } from '@photographic/core';
import type { RetrievalConfig } from './config.js';

/** The subset of `pg`'s `QueryResult` that retrieval reads. */
export interface QueryResultLike<Row> {
  rows: Row[];
}

/**
 * Anything that can run one parameterised statement.
 *
 * Every value that originates outside this package travels as a bind parameter. The
 * only things ever interpolated into SQL text are numbers and identifiers taken from
 * `RetrievalConfig`, and those are validated in `config.ts` before they get near a
 * query string.
 */
export interface QueryRunner {
  query<Row extends Record<string, any> = Record<string, any>>(
    text: string,
    params?: any[],
  ): Promise<QueryResultLike<Row>>;
}

/**
 * Just the embedding half of `LlmPort`. Retrieval never summarises, compares or
 * extracts, so it should not be able to: `FakeLlm` and the real OpenAI adapter both
 * satisfy this, and so does a three-line stub in a test.
 */
export type Embedder = Pick<LlmPort, 'embed'>;

export interface RetrievalDeps {
  db: QueryRunner;
  embedder: Embedder;
  /** Overrides merged over `DEFAULT_RETRIEVAL_CONFIG`. */
  config?: Partial<RetrievalConfig>;
  /** Injected so that recency scoring is deterministic under test. */
  now?: () => Date;
}
