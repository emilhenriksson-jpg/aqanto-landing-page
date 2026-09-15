import { serve } from '@hono/node-server';
import { Hono } from 'hono';

/**
 * Tiny health process for the voice placeholder. Real realtime audio is not here yet;
 * `pnpm --filter @photographic/voice dev:client` is the surface to look at.
 */
const app = new Hono();

app.get('/health', (c) => c.json({ ok: true, app: 'voice', ready: false }));

const port = Number(process.env.PORT ?? 5274);
serve({ fetch: app.fetch, port }, () => {
  console.log(JSON.stringify({ msg: 'voice_placeholder_listening', port }));
});
