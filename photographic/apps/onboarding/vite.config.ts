import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

/**
 * Where the API lives during development.
 *
 * Proxied rather than called cross-origin, so the app uses same-origin relative paths in
 * development and in production alike. The alternative — an API base URL baked in at
 * build time — means the thing that works on a laptop is not the thing that ships.
 */
const API = process.env.API_ORIGIN ?? 'http://localhost:8787';

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/v1': { target: API, changeOrigin: true },
      '/oauth': { target: API, changeOrigin: true },
      '/.well-known': { target: API, changeOrigin: true },
    },
  },
  test: {
    include: ['src/**/*.test.tsx', 'src/**/*.test.ts'],
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    globals: true,
    passWithNoTests: false,
  },
});
