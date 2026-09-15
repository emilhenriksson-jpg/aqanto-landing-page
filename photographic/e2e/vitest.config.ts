import { defineConfig, mergeConfig } from 'vitest/config';

import shared from '../vitest.shared.js';

/**
 * The journey and the live smoke cannot share a run.
 *
 * `journey.test.ts` calls `reset(pool)` on the local Postgres so a leftover row cannot
 * make a test pass for the wrong reason. `live-mcp.smoke.test.ts` drives a REST process
 * that is already serving that same database. Vitest runs test files in parallel, so
 * together they mean the journey drops the schema out from under a live signup, and the
 * live smoke fails with `relation "app.person" does not exist` — a collision that looks
 * exactly like a broken product.
 *
 * So the smoke is excluded from the default run and has its own script (`test:live`).
 * It is still skipped without `LIVE_MCP=1`; this is what makes setting that variable
 * safe rather than a way to break the suite.
 */
export default mergeConfig(
  shared,
  defineConfig({
    test: {
      exclude: ['**/node_modules/**', 'src/**/*.smoke.test.ts'],
    },
  }),
);
