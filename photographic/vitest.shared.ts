import { defineConfig } from 'vitest/config';

/**
 * Shared test config. Every package has a one-line `vitest.config.ts` that re-exports
 * this, so a package can be tested on its own or from the workspace root.
 *
 * Note what this does *not* control: whether two packages' suites run at the same time.
 * `packages/db`, `e2e` and `apps/rest` all talk to the same local Postgres, and some of
 * them reset its schema, so the root `test` script runs packages one at a time
 * (`--workspace-concurrency=1`). Without that the symptom is
 * `relation "app.oauth_client" does not exist` in whichever suite happened to be
 * mid-request — a failure that moves between runs and reads as a bug in the code under
 * test rather than in the harness around it.
 */
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    passWithNoTests: true,
    environment: 'node',
    testTimeout: 15_000,
  },
});
