/**
 * "Hur vet du det om mig?" against a real database.
 *
 * Skipped rather than failed when no Postgres is reachable, the same as the other
 * integration suites here: "no database on this machine" and "the SQL is wrong" are
 * different problems and only one of them is this file's to report.
 */

import { randomUUID } from 'node:crypto';

import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { Item, WriteDecision } from '@photographic/core';

import { createPool, databaseUrl } from '../pool.js';
import { createPostgresServices, type PostgresServices } from '../postgres-services.js';

/** These fixtures write to a personal room, where nothing needs approving. */
function saved(decision: WriteDecision): Item {
  if (decision.outcome !== 'auto') throw new Error(`Förväntade en direkt skrivning, fick ${decision.outcome}`);
  return decision.item;
}

let pool: Pool | null = null;
let wired: PostgresServices | null = null;

async function databaseReachable(): Promise<boolean> {
  const probe = createPool({ connectionString: databaseUrl(), max: 1 });
  try {
    await probe.query('SELECT 1');
    return true;
  } catch {
    return false;
  } finally {
    await probe.end();
  }
}

beforeAll(async () => {
  if (!(await databaseReachable())) return;
  pool = createPool({ connectionString: databaseUrl() });
  wired = await createPostgresServices({ pool, baseUrl: 'https://photographic.test' });
});

afterAll(async () => {
  await wired?.close();
});

const itIfDb = (name: string, fn: () => Promise<void>) =>
  it(name, async (ctx) => {
    if (!wired) ctx.skip();
    await fn();
  });

describe('PgHistory.provenance', () => {
  itIfDb('answers where a memory came from, not only what happened to it', async () => {
    const { person } = await wired!.services.identity.register({
      email: `prov-${randomUUID()}@example.com`,
      displayName: 'Emil',
    });
    const actor = wired!.actorFor(person.id, 'claude-desktop');
    const room = await wired!.services.identity.personalRoomOf(person.id);

    const item = saved(
      await wired!.services.ingest.remember(actor, {
        roomId: room.id,
        body: 'Allergisk mot ketchup',
        source: { kind: 'conversation', label: 'Samtal med Claude', ref: 'sess-prov-1', uri: null },
      }),
    );

    const provenance = await wired!.services.history.provenance(actor, item.shortId);

    expect(provenance).not.toBeNull();
    expect(provenance!.body).toBe('Allergisk mot ketchup');
    expect(provenance!.savedByClient).toBe('claude-desktop');
    // The two the REST route used to compute and then drop, and the reason a person
    // could not get from a memory to its origin anywhere in the app.
    expect(provenance!.source?.label).toBe('Samtal med Claude');
    expect(provenance!.timeline.length).toBeGreaterThan(0);
    expect(provenance!.timeline[0]?.action).toBe('saved');
  });

  itIfDb('finds nothing for someone else’s memory, the same as for a fictional one', async () => {
    const mine = await wired!.services.identity.register({
      email: `prov-${randomUUID()}@example.com`,
      displayName: 'Emil',
    });
    const theirs = await wired!.services.identity.register({
      email: `prov-${randomUUID()}@example.com`,
      displayName: 'Jacob',
    });

    const owner = wired!.actorFor(mine.person.id, 'claude-desktop');
    const room = await wired!.services.identity.personalRoomOf(mine.person.id);
    const item = saved(
      await wired!.services.ingest.remember(owner, { roomId: room.id, body: 'Hemligt om Emil' }),
    );

    const stranger = wired!.actorFor(theirs.person.id, 'claude-desktop');
    expect(await wired!.services.history.provenance(stranger, item.shortId)).toBeNull();
    expect(
      await wired!.services.history.provenance(stranger, 'p-zzzz' as never),
    ).toBeNull();
  });

  /*
   * The event query used to match on `payload ->> 'item_id'` with no room filter at all,
   * so it read every event on the platform and trusted that anything naming this item
   * was safe to show. It also ignored `event_payload_idx`, which is `jsonb_path_ops` and
   * can only answer containment — a sequential scan over the whole log, on a link that
   * now sits on every memory row.
   */
  itIfDb('reads only the rooms the asker may see, and does so through the payload index', async () => {
    const { person } = await wired!.services.identity.register({
      email: `prov-${randomUUID()}@example.com`,
      displayName: 'Emil',
    });
    const actor = wired!.actorFor(person.id, 'claude-desktop');
    const room = await wired!.services.identity.personalRoomOf(person.id);

    const item = saved(
      await wired!.services.ingest.remember(actor, {
        roomId: room.id,
        body: `Unikt för proveniens ${randomUUID()}`,
      }),
    );

    const provenance = await wired!.services.history.provenance(actor, item.shortId);
    expect(provenance!.timeline.every((entry) => entry.roomId === room.id)).toBe(true);

    // Whether the planner *chooses* the index depends on how much is in the table, and
    // a test database has nothing in it. What is worth pinning is that the index can
    // answer this predicate at all: `event_payload_idx` is `jsonb_path_ops`, so it can
    // serve `@>` and cannot serve `->>`, and the same EXPLAIN against the old form finds
    // no index to use however cheap it is told scanning is.
    const client = await pool!.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL enable_seqscan = off');
      const plan = await client.query<{ 'QUERY PLAN': string }>(
        `EXPLAIN SELECT e.seq FROM app.event e
         WHERE e.payload @> jsonb_build_object('item_id', $1::text)`,
        [item.id],
      );
      expect(plan.rows.map((row) => row['QUERY PLAN']).join('\n')).toContain('event_payload_idx');
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });
});
