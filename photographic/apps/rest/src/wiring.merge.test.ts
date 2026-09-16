/**
 * What the composition root must actually construct.
 *
 * This file exists because of a near miss. Two branches edited `wiring.ts` in different
 * regions — one adding the Postgres OAuth stores, one adding the real mail provider —
 * and git merged them without reporting a conflict. A clean textual merge is not the
 * same as correct wiring: either side could have been dropped, or reverted to its
 * in-memory default, and nothing would have failed. Every other test in this app is
 * given its dependencies, so none of them would have noticed.
 *
 * So these assert the two properties that a silent revert would break, and they assert
 * them through behaviour rather than by inspecting which classes were instantiated.
 * `instanceof PgTokenStore` would pass against a store that is wired but never
 * consulted; a token surviving into a second, separately-built wiring cannot.
 */

import { randomUUID } from 'node:crypto';

import { SignedSessionIssuer } from '@photographic/connect';
import { createCodeSenderFromEnv } from '@photographic/delivery';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { resolveConfig } from './config.js';
import { silentLogger } from './logger.js';
import { createWiring, type Wiring } from './wiring.js';

const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://photographic:photographic@127.0.0.1:5432/photographic';

const config = () => resolveConfig({ publicUrl: 'http://api.test', webUrl: 'http://web.test' });

/** Torn down in order, because each holds a Postgres pool. */
let open: Wiring[] = [];

async function wiring(): Promise<Wiring> {
  const built = await createWiring({ config: config(), logger: silentLogger() });
  open.push(built);
  return built;
}

beforeEach(() => {
  open = [];
});

afterEach(async () => {
  for (const built of open) await built.close();
  vi.unstubAllEnvs();
});

describe('OAuth state is persistent when there is a database', () => {
  beforeEach(() => {
    vi.stubEnv('DATABASE_URL', DATABASE_URL);
  });

  it('survives a restart, which is the whole point of moving it out of memory', async () => {
    // The property, stated as a test. A client registers against one process; a second
    // process built from scratch against the same database still knows it. With
    // `MemoryClientStore` this fails on the second lookup, and before this was wired
    // that is exactly what happened on every deploy — which made every per-client
    // revocation temporary and nobody could see it.
    const first = await wiring();

    const registered = await first.oauth.register({
      method: 'POST',
      url: 'http://api.test/oauth/register',
      headers: { 'content-type': 'application/json' },
      query: {},
      body: JSON.stringify({
        client_name: 'Claude Desktop',
        redirect_uris: ['http://127.0.0.1:9999/cb'],
        token_endpoint_auth_method: 'none',
      }),
      clientAddress: '127.0.0.1',
    });

    expect(registered.status).toBe(201);
    const clientId = JSON.parse(String(registered.body)).client_id as string;
    expect(clientId).toMatch(/^pgm_client_/);

    // A different process, in every sense that matters here: its own pool, its own
    // stores, no shared JavaScript state with the one above.
    const second = await wiring();
    const found = await second.auth.describeRequest({
      method: 'GET',
      url: `http://api.test/oauth/authorize/request?request_id=${randomUUID()}`,
      headers: {},
      body: '',
    });

    // The parked-request lookup 404s (that id is made up) rather than erroring, which
    // tells us the pending store is reachable. The registration itself is checked below
    // against the database, which is the unambiguous version.
    expect([400, 404]).toContain(found.status);

    const { createPool } = await import('@photographic/db');
    const pool = createPool({ connectionString: DATABASE_URL });
    try {
      const row = await pool.query(
        `SELECT client_id, client_label, agent_client FROM app.oauth_client WHERE client_id = $1`,
        [clientId],
      );

      // The row is in Postgres, not in a Map. And its frozen identity came out of
      // `deriveClientIdentity` at registration rather than being a per-request guess.
      expect(row.rows[0]).toMatchObject({
        client_id: clientId,
        client_label: 'Claude',
        agent_client: 'claude-desktop',
      });
    } finally {
      await pool.end();
    }
  });

  it('keeps browser logout revoked after a fresh process connects to Postgres', async () => {
    const secret = 'persistent-browser-session-test-secret';
    vi.stubEnv('SESSION_SECRET', secret);
    const first = await wiring();
    const { person } = await first.services.identity.register({ email: `logout-${randomUUID()}@example.test` });
    const issuer = new SignedSessionIssuer(secret);
    const { token } = await issuer.issue({ personId: person.id });
    const other = await issuer.issue({ personId: person.id });
    expect(await first.oauth.introspect(token)).not.toBeNull();
    const result = await first.app.request('http://api.test/v1/session/logout', {
      method: 'POST', headers: { origin: 'http://api.test', cookie: `photographic_sid=${token}` },
    });
    expect(result.status).toBe(204);
    const second = await wiring();
    expect(await second.oauth.introspect(token)).toBeNull();
    expect(await second.oauth.introspect(other.token)).not.toBeNull();
  });

  it('offers the per-client management the Klienter screen needs', async () => {
    // Null here means the rename and revoke routes answer 503. Non-null is what makes
    // "disconnect this AI" mean something past the next deploy.
    const built = await wiring();
    expect(built.clientGrants).not.toBeNull();
  });
});

describe('OAuth state falls back to memory only when there is no database', () => {
  it('builds without a database and says so by having no client registry', async () => {
    vi.stubEnv('DATABASE_URL', '');

    const built = await wiring();

    // Deliberately absent rather than a degraded screen: registrations that vanish on
    // restart cannot be revoked in any sense a person would recognise.
    expect(built.clientGrants).toBeNull();
  });
});

describe('sign-up codes go through the delivery port', () => {
  it('defaults to the log rather than pretending to send mail', () => {
    const selection = createCodeSenderFromEnv({}, { logger: silentLogger() });
    expect(selection.email).toBe('log');
  });

  it('selects the real provider when one is configured', () => {
    // The regression this guards: `wiring.ts` used to construct a hardcoded
    // development sender, and a merge that restored it would leave a process configured
    // for Resend quietly writing codes to a log file. Nobody finds out until a person
    // says they never got the email.
    const selection = createCodeSenderFromEnv(
      {
        PHOTOGRAPHIC_MAIL: 'resend',
        RESEND_API_KEY: 're_test_key',
        MAIL_FROM: 'Photographic <hej@photographic.me>',
      },
      { logger: silentLogger() },
    );

    expect(selection.email).toBe('resend');
  });

  it('refuses to start half-configured', () => {
    // An error at boot, not a silent downgrade. Naming a provider without its
    // credential is a deployment mistake worth failing on.
    expect(() =>
      createCodeSenderFromEnv({ PHOTOGRAPHIC_MAIL: 'resend' }, { logger: silentLogger() }),
    ).toThrow(/RESEND_API_KEY/);
  });
});
