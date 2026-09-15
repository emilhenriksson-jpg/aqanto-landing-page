import { defineConfig, mergeConfig } from 'vitest/config';

import shared from '../../vitest.shared.js';

/**
 * One database, so one file at a time.
 *
 * Every test file here runs against the same local Postgres and several of them call
 * `reset()` to start from a known schema. Run in parallel, one file's reset truncates
 * another file's fixtures halfway through it, and the failure moves around between runs
 * — which reads as flakiness in the code under test rather than in the harness.
 *
 * The alternative is a database per file. Not worth it yet: these suites are seconds
 * long, and a schema-per-worker setup is a second thing to keep in step with the
 * migrations.
 */
export default mergeConfig(
  shared,
  defineConfig({
    test: {
      fileParallelism: false,
    },
  }),
);
