import { defineConfig } from 'vite';

/**
 * The client is a plain Vite app: no framework, because the entire surface is one
 * button, a transcript and two cards. Latency is the product, so the shipped bundle
 * should stay small enough to be irrelevant.
 */
export default defineConfig({
  build: {
    outDir: 'dist/client',
    emptyOutDir: true,
    target: 'es2022',
  },
  server: {
    port: 5273,
    proxy: {
      // `pnpm dev` runs the node server; `pnpm dev:client` runs without it and the
      // client falls back to mock mode when /api/config is unreachable.
      '/api': {
        target: 'http://127.0.0.1:8787',
        changeOrigin: true,
      },
    },
  },
});
