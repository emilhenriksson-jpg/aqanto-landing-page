import { SignedSessionIssuer } from '@photographic/connect';
import { describe, expect, it } from 'vitest';
import { browserSessions, MemorySessionRevocations } from './browser-sessions.js';

const secret = 'browser-session-test-secret';
describe('browser session revocation', () => {
  it('rejects a replay after logout across verifiers, without revoking a second session', async () => {
    const store = new MemorySessionRevocations();
    const first = browserSessions(secret, store);
    const second = browserSessions(secret, store);
    const issuer = new SignedSessionIssuer(secret);
    const a = await issuer.issue({ personId: 'person-a' });
    const b = await issuer.issue({ personId: 'person-a' });
    expect(await first.verify(a.token)).toBe('person-a');
    await first.revoke(a.token);
    await first.revoke(a.token);
    expect(await second.verify(a.token)).toBeNull();
    expect(await second.verify(b.token)).toBe('person-a');
  });
  it('never persists invalid tokens and propagates storage failures', async () => {
    let writes = 0;
    const sessions = browserSessions(secret, {
      has: async () => { throw new Error('database unavailable'); },
      add: async () => { writes++; throw new Error('database unavailable'); },
    });
    await sessions.revoke('forged');
    expect(writes).toBe(0);
    const valid = await new SignedSessionIssuer(secret).issue({ personId: 'person-a' });
    await expect(sessions.verify(valid.token)).rejects.toThrow('database unavailable');
    await expect(sessions.revoke(valid.token)).rejects.toThrow('database unavailable');
  });
});

import { afterEach, vi } from 'vitest';
import { createWiring } from './wiring.js';
import { resolveConfig } from './config.js';
import { silentLogger } from './logger.js';
afterEach(() => vi.unstubAllEnvs());
it('logout makes the same credential fail for both cookies and bearer requests', async () => {
  vi.stubEnv('DATABASE_URL', '');
  vi.stubEnv('SESSION_SECRET', secret);
  const built = await createWiring({
    config: resolveConfig({ publicUrl: 'https://photographic.test', environment: 'test' }),
    logger: silentLogger(),
  });
  try {
    const { person } = await built.services.identity.register({ email: 'logout@example.test' });
    const issuer = new SignedSessionIssuer(secret);
    const { token } = await issuer.issue({ personId: person.id });
    const other = await issuer.issue({ personId: person.id });
    const url = 'https://photographic.test';
    expect((await built.app.request(`${url}/v1/account`, { headers: { cookie: `photographic_sid=${token}` } })).status).toBe(200);
    const result = await built.app.request(`${url}/v1/session/logout`, {
      method: 'POST', headers: { origin: url, cookie: `photographic_sid=${token}` },
    });
    expect(result.status).toBe(204);
    expect((await built.app.request(`${url}/v1/account`, { headers: { cookie: `photographic_sid=${token}` } })).status).toBe(401);
    expect((await built.app.request(`${url}/v1/account`, { headers: { authorization: `Bearer ${token}` } })).status).toBe(401);
    expect(await built.oauth.introspect(token)).toBeNull();
    expect(await built.oauth.introspect(other.token)).not.toBeNull();
  } finally { await built.close(); }
});
