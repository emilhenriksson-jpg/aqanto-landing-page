/**
 * The Postgres OAuth stores, against a real database.
 *
 * These exist for one reason: the in-memory stores get atomicity for free from
 * single-threaded JavaScript, and Postgres does not. `consume` returning false the
 * second time is the difference between an authorization code that can be redeemed once
 * and one an intercepted redirect can race, and it is not a property a type checker can
 * see. So the interesting assertions here are the second calls.
 */

import { deriveClientIdentity, hashSecret, type NewOAuthClient } from '@photographic/auth';
import type { PersonId } from '@photographic/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createPool, reset } from '../index.js';
import { PgIdentity } from './identity.js';
import {
  PgAuthCodeStore,
  PgClientGrants,
  PgOAuthClientStore,
  PgPendingAuthorizationStore,
  PgTokenStore,
} from './oauth.js';

const pool = createPool();

const clients = new PgOAuthClientStore(pool);
const codes = new PgAuthCodeStore(pool);
const pending = new PgPendingAuthorizationStore(pool);
const tokens = new PgTokenStore(pool);
const grants = new PgClientGrants(pool);

let personId: PersonId;
let otherPersonId: PersonId;
let seq = 0;

const nextClientId = () => `pgm_client_test_${(seq += 1)}`;

function registration(name: string): NewOAuthClient {
  const identity = deriveClientIdentity(name);
  return {
    clientId: nextClientId(),
    clientSecretHash: null,
    clientName: name,
    redirectUris: ['https://example.test/callback'],
    grantTypes: ['authorization_code', 'refresh_token'],
    tokenEndpointAuth: 'none',
    registeredVia: 'dcr',
    cimdUrl: null,
    ...identity,
  };
}

beforeAll(async () => {
  await reset(pool);
  const identity = new PgIdentity(pool);
  personId = (await identity.register({ email: 'oauth-store@photographic.test' })).person.id;
  otherPersonId = (await identity.register({ email: 'oauth-other@photographic.test' })).person.id;
});

afterAll(async () => {
  await pool.end();
});

const inAnHour = () => new Date(Date.now() + 3_600_000);

describe('PgOAuthClientStore', () => {
  it('round-trips a registration including the frozen identity', async () => {
    const input = registration('Claude Desktop');
    const created = await clients.create(input);

    expect(created.clientId).toBe(input.clientId);
    expect(created.agentClient).toBe('claude-desktop');
    expect(created.clientLabel).toBe('Claude');
    expect(created.labelSource).toBe('registration');
    expect(created.redirectUris).toEqual(['https://example.test/callback']);

    const found = await clients.findByClientId(input.clientId);
    expect(found).toEqual(created);
  });

  it('records an unrecognised client as unknown rather than guessing', async () => {
    const created = await clients.create(registration('Some Random MCP Thing'));

    expect(created.agentClient).toBe('unknown');
    expect(created.clientLabel).toBe('okänd klient');
    expect(created.labelSource).toBe('unrecognised');
  });

  it('refuses to let a client change the identity it registered under', async () => {
    // The trigger, not a convention. Dynamic registration is open, so the registration
    // name is attacker-controlled by construction — and a client that could rename
    // itself would rewrite the attribution on memories it had already written.
    const created = await clients.create(registration('Cursor'));

    await expect(
      pool.query(`UPDATE app.oauth_client SET client_label = $2 WHERE client_id = $1`, [
        created.clientId,
        'Photographic Official',
      ]),
    ).rejects.toThrow(/immutable/);

    await expect(
      pool.query(`UPDATE app.oauth_client SET agent_client = 'claude-desktop' WHERE client_id = $1`, [
        created.clientId,
      ]),
    ).rejects.toThrow(/immutable/);
  });

  it('returns null for a client nobody registered', async () => {
    expect(await clients.findByClientId('pgm_client_nope')).toBeNull();
  });
});

describe('PgAuthCodeStore', () => {
  it('consumes a code exactly once', async () => {
    const client = await clients.create(registration('Claude'));
    const codeHash = hashSecret(`code-${seq}`);

    await codes.create({
      codeHash,
      clientId: client.clientId,
      personId,
      redirectUri: 'https://example.test/callback',
      codeChallenge: 'challenge',
      codeChallengeMethod: 'S256',
      scope: 'memory.read',
      expiresAt: inAnHour(),
    });

    expect(await codes.consume(codeHash, new Date())).toBe(true);
    // The second one is the whole test. A read-then-write implementation passes the
    // line above and fails here only under concurrency, which no suite would catch.
    expect(await codes.consume(codeHash, new Date())).toBe(false);
  });

  it('still returns a consumed code, because replay detection has to see it', async () => {
    const client = await clients.create(registration('Claude'));
    const codeHash = hashSecret(`replay-${seq}`);

    await codes.create({
      codeHash,
      clientId: client.clientId,
      personId,
      redirectUri: 'https://example.test/callback',
      codeChallenge: 'challenge',
      codeChallengeMethod: 'S256',
      scope: 'memory.read',
      expiresAt: inAnHour(),
    });
    await codes.consume(codeHash, new Date());

    const found = await codes.findByHash(codeHash);
    expect(found?.consumedAt).toBeInstanceOf(Date);
    expect(found?.personId).toBe(personId);
  });
});

describe('PgPendingAuthorizationStore', () => {
  it('parks a validated request and consumes it once', async () => {
    const client = await clients.create(registration('Claude'));
    const id = `pending-${seq}`;

    const created = await pending.create({
      id,
      clientId: client.clientId,
      clientName: client.clientName,
      redirectUri: 'https://example.test/callback',
      codeChallenge: 'challenge',
      scope: 'memory.read offline_access',
      state: 'xyz',
      resource: 'https://photographic.test/mcp',
      expiresAt: inAnHour(),
    });

    expect(created.state).toBe('xyz');
    expect(await pending.find(id)).toMatchObject({ id, redirectUri: 'https://example.test/callback' });

    expect(await pending.consume(id, new Date())).toBe(true);
    expect(await pending.consume(id, new Date())).toBe(false);
  });
});

describe('PgTokenStore', () => {
  async function issue(options: { clientId: string; refresh?: boolean; rooms?: string[] } ) {
    const raw = `tok-${(seq += 1)}`;
    return {
      raw,
      record: await tokens.create({
        tokenHash: hashSecret(raw),
        refreshHash: options.refresh ? hashSecret(`ref-${raw}`) : null,
        clientId: options.clientId,
        personId,
        scope: 'memory.read memory.write',
        roomScope: (options.rooms ?? []) as never,
        expiresAt: inAnHour(),
      }),
    };
  }

  it('round-trips a token and finds it by its hash', async () => {
    const client = await clients.create(registration('Claude'));
    const { raw, record } = await issue({ clientId: client.clientId });

    expect(record.roomScope).toEqual([]);
    expect(record.revokedAt).toBeNull();

    const found = await tokens.findByAccessHash(hashSecret(raw));
    expect(found?.id).toBe(record.id);
    expect(found?.scope).toBe('memory.read memory.write');
  });

  it('keeps an empty room scope empty rather than expanding it', async () => {
    // Empty means "every room the person belongs to, resolved now". A token that stored
    // its memberships would keep reading a room after the person left it, and nothing
    // would error.
    const client = await clients.create(registration('Claude'));
    const { record } = await issue({ clientId: client.clientId });
    expect(record.roomScope).toEqual([]);
  });

  it('finds a revoked refresh token, which is what reuse detection needs', async () => {
    const client = await clients.create(registration('Claude'));
    const raw = `tok-reuse-${(seq += 1)}`;
    const refresh = `ref-reuse-${seq}`;

    const record = await tokens.create({
      tokenHash: hashSecret(raw),
      refreshHash: hashSecret(refresh),
      clientId: client.clientId,
      personId,
      scope: 'memory.read offline_access',
      roomScope: [],
      expiresAt: inAnHour(),
    });

    await tokens.revoke(record.id, new Date());

    const found = await tokens.findByRefreshHash(hashSecret(refresh));
    expect(found?.id).toBe(record.id);
    expect(found?.revokedAt).toBeInstanceOf(Date);
  });

  it('revokes a family without touching another client or another person', async () => {
    const mine = await clients.create(registration('Claude'));
    const other = await clients.create(registration('Cursor'));

    const a = await issue({ clientId: mine.clientId });
    const b = await issue({ clientId: mine.clientId });
    const untouched = await issue({ clientId: other.clientId });

    const theirs = await tokens.create({
      tokenHash: hashSecret(`other-person-${(seq += 1)}`),
      refreshHash: null,
      clientId: mine.clientId,
      personId: otherPersonId,
      scope: 'memory.read',
      roomScope: [],
      expiresAt: inAnHour(),
    });

    const count = await tokens.revokeFamily(
      { clientId: mine.clientId, personId },
      new Date(),
    );
    expect(count).toBe(2);

    expect((await tokens.findByAccessHash(a.record.tokenHash))?.revokedAt).toBeInstanceOf(Date);
    expect((await tokens.findByAccessHash(b.record.tokenHash))?.revokedAt).toBeInstanceOf(Date);
    expect((await tokens.findByAccessHash(untouched.record.tokenHash))?.revokedAt).toBeNull();
    expect((await tokens.findByAccessHash(theirs.tokenHash))?.revokedAt).toBeNull();
  });

  it('revokes every token a person holds, for the deletion path', async () => {
    const identity = new PgIdentity(pool);
    const doomed = (await identity.register({ email: `doomed-${seq}@photographic.test` })).person.id;
    const one = await clients.create(registration('Claude'));
    const two = await clients.create(registration('Cursor'));

    for (const client of [one, two]) {
      await tokens.create({
        tokenHash: hashSecret(`doomed-${client.clientId}`),
        refreshHash: null,
        clientId: client.clientId,
        personId: doomed,
        scope: 'memory.read',
        roomScope: [],
        expiresAt: inAnHour(),
      });
    }

    expect(await tokens.revokeAllForPerson(doomed, new Date())).toBe(2);
    expect(await tokens.revokeAllForPerson(doomed, new Date())).toBe(0);
  });

  it('records when a token was last used', async () => {
    const client = await clients.create(registration('Claude'));
    const { record } = await issue({ clientId: client.clientId });

    expect(record.lastUsedAt).toBeNull();
    await tokens.touch(record.id, new Date());
    expect((await tokens.findByAccessHash(record.tokenHash))?.lastUsedAt).toBeInstanceOf(Date);
  });
});

describe('PgClientGrants', () => {
  it('lists a client under its frozen label until the person renames it', async () => {
    const client = await clients.create(registration('Claude Desktop'));
    await grants.record({ personId, clientId: client.clientId, scope: 'memory.read' });

    const listed = (await grants.list(personId)).find((row) => row.clientId === client.clientId);
    expect(listed).toMatchObject({
      clientLabel: 'Claude',
      displayName: null,
      agentClient: 'claude-desktop',
      scope: 'memory.read',
      revokedAt: null,
      writesToday: 0,
    });

    await grants.rename({ personId, clientId: client.clientId, displayName: 'Claude på jobbdatorn' });
    const renamed = (await grants.list(personId)).find((row) => row.clientId === client.clientId);
    expect(renamed?.displayName).toBe('Claude på jobbdatorn');
    // The frozen label survives the rename: it is the audit trail, not the display.
    expect(renamed?.clientLabel).toBe('Claude');
  });

  it('keeps one person\'s rename out of another person\'s view of the same client', async () => {
    const client = await clients.create(registration('Cursor'));
    await grants.record({ personId, clientId: client.clientId, scope: 'memory.read' });
    await grants.record({ personId: otherPersonId, clientId: client.clientId, scope: 'memory.read' });

    await grants.rename({ personId, clientId: client.clientId, displayName: 'Min Cursor' });

    const theirs = (await grants.list(otherPersonId)).find((r) => r.clientId === client.clientId);
    expect(theirs?.displayName).toBeNull();
  });

  it('re-authorizing clears a revocation', async () => {
    // Otherwise a person who revokes a client and then deliberately connects it again is
    // left with a client they just approved and which silently does not work.
    const client = await clients.create(registration('Claude'));
    await grants.record({ personId, clientId: client.clientId, scope: 'memory.read' });

    expect(await grants.revoke({ personId, clientId: client.clientId })).toBe(true);
    expect(await grants.isRevoked({ personId, clientId: client.clientId })).toBe(true);
    // Revoking twice is not an error, but it is not a second revocation either.
    expect(await grants.revoke({ personId, clientId: client.clientId })).toBe(false);

    await grants.record({ personId, clientId: client.clientId, scope: 'memory.read' });
    expect(await grants.isRevoked({ personId, clientId: client.clientId })).toBe(false);
  });

  it('counts writes against a daily budget and refuses past it', async () => {
    const client = await clients.create(registration('Claude'));
    await grants.record({ personId, clientId: client.clientId, scope: 'memory.write' });

    const first = await grants.recordWrite({ personId, clientId: client.clientId, limit: 2 });
    expect(first).toEqual({ allowed: true, writes: 1 });

    const second = await grants.recordWrite({ personId, clientId: client.clientId, limit: 2 });
    expect(second).toEqual({ allowed: true, writes: 2 });

    const third = await grants.recordWrite({ personId, clientId: client.clientId, limit: 2 });
    expect(third).toEqual({ allowed: false, writes: 3 });

    const listed = (await grants.list(personId)).find((row) => row.clientId === client.clientId);
    // The number the screen shows and the number the budget refused on are the same one.
    expect(listed?.writesToday).toBe(3);
  });

  it('renaming a client nobody granted reports not found', async () => {
    expect(
      await grants.rename({ personId, clientId: 'pgm_client_nope', displayName: 'x' }),
    ).toBe(false);
  });
});
