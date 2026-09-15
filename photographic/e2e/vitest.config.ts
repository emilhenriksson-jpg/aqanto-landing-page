import { defineConfig, mergeConfig } from 'vitest/config';

import shared from '../vitest.shared.js';

/**
 * One database, so one file at a time.
 *
 * Under `HARNESS=postgres` every file here runs against the same local Postgres and the
 * harness resets the schema per run, so in parallel one file drops the schema out from
 * under another. The symptom is a connection error inside `migrate`, which reads as a
 * database problem rather than as two suites sharing one.
 *
 * Harmless under `HARNESS=memory`, where each file builds its own store — not worth two
 * configs to avoid.
 */
export default mergeConfig(
  shared,
  defineConfig({
    test: {
      fileParallelism: false,
    },
  }),
);
