import { defineConfig, mergeConfig } from 'vitest/config';

import shared from '../vitest.shared.js';

/**
 * Two collisions, two separate fixes. Both are needed and neither replaces the other.
 *
 * **The live smoke is excluded from this run entirely.** `live-mcp.smoke.test.ts` drives
 * a REST process that is already serving the local Postgres, while `journey.test.ts`
 * calls `reset(pool)` on that same database — so together the journey drops the schema
 * out from under a live signup and the smoke fails with `relation "app.person" does not
 * exist`, which looks exactly like a broken product. It has its own config and script
 * (`test:live`), and is still skipped without `LIVE_MCP=1`, which is what makes setting
 * that variable safe rather than a way to break the suite.
 *
 * **The files that remain run one at a time.** Excluding the smoke is not enough once
 * there is more than one suite in the default run: under `HARNESS=postgres` both
 * `journey.test.ts` and `documents.test.ts` build a harness against the same database
 * and the harness resets the schema per run, so in parallel one file drops the schema
 * out from under the other. The symptom is a connection error inside `migrate`, which
 * reads as a database problem rather than as two suites sharing one.
 *
 * Harmless under `HARNESS=memory`, where each file builds its own store — not worth two
 * configs to avoid.
 */
export default mergeConfig(
  shared,
  defineConfig({
    test: {
      exclude: ['**/node_modules/**', 'src/**/*.smoke.test.ts'],
      fileParallelism: false,
    },
  }),
);
