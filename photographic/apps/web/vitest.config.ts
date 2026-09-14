import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

/**
 * The web app cannot use `vitest.shared.ts` from the workspace root: it needs the JSX
 * transform and a DOM environment.
 */
export default defineConfig({
  plugins: [react()],
  test: {
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
    css: false,
    testTimeout: 15_000,
  },
});
