import { defineConfig } from 'vitest/config';

/**
 * The live smoke, alone.
 *
 * Runs `*.smoke.test.ts` and nothing else, against a REST process that is already
 * listening. Separate from the default run because the journey resets the database that
 * process is serving — see `vitest.config.ts`.
 *
 * Written out rather than merged with `vitest.shared.ts`: `mergeConfig` concatenates
 * arrays, so an `include` written as an override would add the journey back instead of
 * replacing it, and the collision this file exists to prevent would happen anyway.
 */
export default defineConfig({
  test: {
    include: ['src/**/*.smoke.test.ts'],
    passWithNoTests: true,
    environment: 'node',
    // A tunnel adds a round trip to another continent to every request.
    testTimeout: 60_000,
  },
});
