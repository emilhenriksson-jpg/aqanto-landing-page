import { defineConfig } from 'vitest/config';

/**
 * Shared test config. Every package has a one-line `vitest.config.ts` that re-exports
 * this, so a package can be tested on its own or from the workspace root.
 */
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    passWithNoTests: true,
    environment: 'node',
    testTimeout: 15_000,
  },
});
