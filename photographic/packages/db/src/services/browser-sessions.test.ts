import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createPool, reset } from '../index.js';
import { PgBrowserSessionRevocations } from './browser-sessions.js';
const pool = createPool();
beforeAll(async () => { await reset(pool); });
afterAll(async () => { await pool.end(); });
it('persists revocation across connections and ignores expired records', async () => {
  const hash = createHash('sha256').update(randomUUID()).digest('hex');
  const first = new PgBrowserSessionRevocations(pool);
  expect(await first.has(hash)).toBe(false);
  await first.add(hash, new Date(Date.now() + 60_000));
  const anotherPool = createPool();
  try {
    const second = new PgBrowserSessionRevocations(anotherPool);
    expect(await second.has(hash)).toBe(true);
    await second.add(hash, new Date(Date.now() + 60_000));
    const expired = createHash('sha256').update(randomUUID()).digest('hex');
    await second.add(expired, new Date(Date.now() - 1));
    expect(await second.has(expired)).toBe(false);
  } finally { await anotherPool.end(); }
});
