/**
 * `PgHistory.changes` against a real local Postgres — the recursive walk over
 * `superseded_by`, on data produced by the real write path rather than by hand.
 *
 * Skipped rather than failed when no database is reachable; see
 * `postgres-services.test.ts` for why.
 *
 * The chain is built by the ordinary route a correction takes: a contradicting memory
 * goes to the approval queue, accepting it writes a *new* item and supersedes the old
 * one. That is why a per-item timeline cannot answer "hur har det här ändrats" — the
 * previous value is on a different row with a different short id — and it is why this
 * test asserts against short ids that change rather than against one that does not.
 */

import { randomUUID } from 'node:crypto';

import type { Actor, ShortId } from '@photographic/core';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createPool, databaseUrl } from '../pool.js';
import { createPostgresServices, type PostgresServices } from '../postgres-services.js';

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

async function newActor() {
  const email = `changes-test-${randomUUID()}@example.com`;
  const { person, personalRoom } = await wired!.services.identity.register({
    email,
    displayName: 'Emil',
  });
  return { actor: wired!.actorFor(person.id, 'claude-desktop'), personalRoom };
}

/** Saves something, then corrects it the way a model actually does. */
async function saveThenCorrect(
  actor: Actor,
  roomId: string,
  first: string,
  second: string,
): Promise<{ oldShortId: ShortId; newShortId: ShortId }> {
  const saved = await wired!.services.ingest.remember(actor, {
    roomId: roomId as never,
    body: first,
    kind: 'fact',
  });
  if (saved.outcome !== 'auto') throw new Error(`expected an automatic save, got ${saved.outcome}`);

  // A contradiction never writes on its own — it asks. Accepting is what supersedes.
  const correction = await wired!.services.ingest.remember(actor, {
    roomId: roomId as never,
    body: second,
    kind: 'fact',
  });
  if (correction.outcome !== 'needs_approval') {
    throw new Error(`expected the correction to queue, got ${correction.outcome}`);
  }

  const resulting = await wired!.services.ingest.resolveProposal(
    actor,
    correction.proposal.id,
    true,
  );

  return { oldShortId: saved.item.shortId, newShortId: resulting!.shortId };
}

const BEFORE = 'Dottern Vera tränar simning på tisdagar';
const AFTER = 'Dottern Vera tränar inte simning på tisdagar';

describe('following a correction across memories', () => {
  itIfDb('gives both values, in order, with what replaced what', async () => {
    const { actor, personalRoom } = await newActor();
    const { oldShortId, newShortId } = await saveThenCorrect(
      actor,
      personalRoom.id,
      BEFORE,
      AFTER,
    );

    // The short id changed, which is the whole reason this needs a chain walk.
    expect(newShortId).not.toBe(oldShortId);

    const [chainFromNew] = await wired!.services.history.changes(actor, [newShortId]);

    expect(chainFromNew!.currentBody).toBe(AFTER);
    expect(chainFromNew!.shortId).toBe(newShortId);
    expect(chainFromNew!.changeCount).toBe(1);
    expect(chainFromNew!.steps.map((step) => step.body)).toEqual([BEFORE, AFTER]);
    expect(chainFromNew!.steps[1]!.previousBody).toBe(BEFORE);
    expect(chainFromNew!.steps[0]!.at.getTime()).toBeLessThanOrEqual(
      chainFromNew!.steps[1]!.at.getTime(),
    );
  });

  itIfDb('one step per value, not one per event that recorded it', async () => {
    // A correction appends two events — `item.created` for the memory that replaces and
    // `item.superseded` for the one replaced — and both describe the same transition.
    // Rendering both would make one correction read as two.
    const { actor, personalRoom } = await newActor();
    const { newShortId } = await saveThenCorrect(actor, personalRoom.id, BEFORE, AFTER);

    const [chain] = await wired!.services.history.changes(actor, [newShortId]);

    expect(chain!.steps).toHaveLength(2);
    const events = await pool!.query<{ count: string }>(
      `SELECT count(*) AS count FROM app.event
       WHERE event_type IN ('item.created', 'item.superseded')
         AND (payload ->> 'short_id') IN ($1, $2)`,
      [chain!.steps[0]!.shortId, newShortId],
    );
    expect(Number(events.rows[0]!.count)).toBe(3);
  });

  itIfDb('resolves the same chain from the superseded id a person still remembers', async () => {
    // "Hur har p-7k2m ändrats" has to work when p-7k2m is the id from before the
    // correction — that is the id the person saw at the time.
    const { actor, personalRoom } = await newActor();
    const { oldShortId, newShortId } = await saveThenCorrect(
      actor,
      personalRoom.id,
      BEFORE,
      AFTER,
    );

    const [fromOld] = await wired!.services.history.changes(actor, [oldShortId]);

    expect(fromOld!.shortId).toBe(newShortId);
    expect(fromOld!.currentBody).toBe(AFTER);
  });

  itIfDb('carries each value\u2019s own provenance, not the head\u2019s', async () => {
    const { actor, personalRoom } = await newActor();
    const { newShortId } = await saveThenCorrect(actor, personalRoom.id, BEFORE, AFTER);

    const [chain] = await wired!.services.history.changes(actor, [newShortId]);

    for (const step of chain!.steps) {
      expect(step.agentClient).toBe('claude-desktop');
      expect(step.motivation).toBeTruthy();
      // "Hur vet du det?" and "hur har det ändrats?" are the same question at two
      // distances, so a step with no source is a correction a person cannot check.
      expect(step.source).not.toBeNull();
    }
  });

  itIfDb('collapses a chain of two corrections into three values', async () => {
    const { actor, personalRoom } = await newActor();
    const { newShortId } = await saveThenCorrect(actor, personalRoom.id, BEFORE, AFTER);

    const third = await wired!.services.ingest.update(
      actor,
      newShortId,
      personalRoom.id,
      'Dottern Vera tränar simning på torsdagar',
    );
    if (third.outcome !== 'updated') throw new Error('expected the edit to apply');

    const [chain] = await wired!.services.history.changes(actor, [newShortId]);

    expect(chain!.steps.map((step) => step.body)).toEqual([
      BEFORE,
      AFTER,
      'Dottern Vera tränar simning på torsdagar',
    ]);
    expect(chain!.changeCount).toBe(2);
    // An edit keeps the short id; a supersede does not. Both are in one chain.
    expect(chain!.shortId).toBe(newShortId);
  });

  itIfDb('reports a memory that has never changed as unchanged, not as missing', async () => {
    const { actor, personalRoom } = await newActor();
    const saved = await wired!.services.ingest.remember(actor, {
      roomId: personalRoom.id,
      body: 'Allergisk mot ketchup',
      kind: 'fact',
    });
    if (saved.outcome !== 'auto') throw new Error('expected an automatic save');

    const [chain] = await wired!.services.history.changes(actor, [saved.item.shortId]);

    expect(chain!.changeCount).toBe(0);
    expect(chain!.steps).toHaveLength(1);
    expect(chain!.firstSavedAt).toEqual(chain!.lastChangedAt);
  });
});

/**
 * The leak this feature could reintroduce.
 *
 * A chain's steps are text the person replaced, and the one case that must never happen
 * is a superseded body coming back for a memory that has since been deleted. It has been
 * closed twice in this repo — `recent.ts` and `ask.ts`, both with allowlists over
 * actions, neither of which can help here, because showing those bodies *is* the
 * feature. So the rule is about the head of the chain, and this is the third lock: the
 * SQL itself, checked against a real delete.
 */
describe('a memory in the trash', () => {
  itIfDb('has no chain at all, and its old value does not come back', async () => {
    const { actor, personalRoom } = await newActor();
    const { oldShortId, newShortId } = await saveThenCorrect(
      actor,
      personalRoom.id,
      BEFORE,
      AFTER,
    );

    // It is there before the delete, which is what makes the assertion after it mean
    // something rather than passing for an unrelated reason.
    expect(await wired!.services.history.changes(actor, [newShortId])).toHaveLength(1);

    await wired!.services.ingest.forget(
      actor,
      newShortId,
      personalRoom.id,
      'stämmer inte längre',
    );

    // Asked by the current id, by the superseded id, and by both at once.
    for (const ids of [[newShortId], [oldShortId], [newShortId, oldShortId]]) {
      const chains = await wired!.services.history.changes(actor, ids);
      expect(chains).toEqual([]);
      expect(JSON.stringify(chains)).not.toContain('simning');
    }
  });

  itIfDb('does not suppress a live memory asked for in the same call', async () => {
    const { actor, personalRoom } = await newActor();
    const { newShortId } = await saveThenCorrect(actor, personalRoom.id, BEFORE, AFTER);
    const alive = await wired!.services.ingest.remember(actor, {
      roomId: personalRoom.id,
      body: 'Allergisk mot ketchup',
      kind: 'fact',
    });
    if (alive.outcome !== 'auto') throw new Error('expected an automatic save');

    await wired!.services.ingest.forget(actor, newShortId, personalRoom.id);

    const chains = await wired!.services.history.changes(actor, [
      newShortId,
      alive.item.shortId,
    ]);

    expect(chains.map((chain) => chain.shortId)).toEqual([alive.item.shortId]);
  });

  itIfDb('comes back once it is restored, because nothing was lost', async () => {
    const { actor, personalRoom } = await newActor();
    const { newShortId } = await saveThenCorrect(actor, personalRoom.id, BEFORE, AFTER);

    await wired!.services.ingest.forget(actor, newShortId, personalRoom.id);
    await wired!.services.trash.restore(actor, { type: 'memory', shortId: newShortId }, personalRoom.id);

    const [chain] = await wired!.services.history.changes(actor, [newShortId]);

    expect(chain!.steps.map((step) => step.body)).toEqual([BEFORE, AFTER]);
    // Restoring is not a change to what the memory says, so it is not a step.
    expect(chain!.changeCount).toBe(1);
  });
});

describe('somebody else\u2019s chain', () => {
  itIfDb('is not reachable by guessing its short id', async () => {
    const { actor: mine, personalRoom: myRoom } = await newActor();
    const { actor: theirs, personalRoom: theirRoom } = await newActor();

    const { newShortId: theirChain } = await saveThenCorrect(
      theirs,
      theirRoom.id,
      BEFORE,
      AFTER,
    );
    await saveThenCorrect(
      mine,
      myRoom.id,
      'Bor i Stockholm sedan 2019',
      'Bor inte i Stockholm sedan 2019',
    );

    // A short id supplied by a model is a request, never a grant — the room scope is
    // applied inside the query rather than as a filter over the result.
    expect(await wired!.services.history.changes(mine, [theirChain])).toEqual([]);
  });
});
