import { defineConfig, mergeConfig } from 'vitest/config';

import shared from '../vitest.shared.js';

/**
 * Two rules, both about the same hazard: this suite wipes a database.
 *
 * The Postgres harness calls `reset(pool)` before every run, so a leftover row cannot
 * make a test pass for the wrong reason. That is destructive, and it collides with
 * anything else reading the same schema — the failure surfaces as
 * `relation "app.person" does not exist` somewhere unrelated, which looks exactly like a
 * broken product rather than two test files fighting.
 *
 * **One file at a time.** `journey.test.ts`, `calendar.test.ts` and `documents.test.ts`
 * each build a harness, so each resets. Run in parallel, they delete each other's
 * fixtures halfway through. Harmless under `HARNESS=memory`, where each file builds its
 * own store — not worth two configs to avoid.
 *
 * **The live smoke is excluded from the default run**, and has its own script
 * (`test:live`) and config. It drives a REST process that is already listening against a
 * real database, which is not something to start concurrently with a suite that resets
 * one. It is still skipped without `LIVE_MCP=1`, which is what makes setting that
 * variable safe rather than a way to break the suite.
 *
 * Worth knowing when reading the older reasoning: the harness now resets a database of
 * its own (`..._e2e`, see `harness.ts`) rather than the one `pnpm db:seed` fills and the
 * live process serves. That removed the specific collision between the journey and a live
 * signup. Both rules stay anyway — they are cheap, and the isolation is a property of the
 * harness that a future change could reasonably drop.
 */
export default mergeConfig(
  shared,
  defineConfig({
    test: {
      // Replaces the default exclude, hence node_modules being named explicitly.
      exclude: ['**/node_modules/**', 'src/**/*.smoke.test.ts'],
      fileParallelism: false,
    },
  }),
);
