/**
 * The approval gate on `update`, against a real database.
 *
 * `remember` forwards the caller's own `explicit` flag into `requiresApproval`, so a
 * fresh memory cannot skip the "too long to save automatically" gate just by asking —
 * there is no `explicit` field on the create request a caller could set in the first
 * place. `update` used to pass a literal `explicit: true` into the same gate, which
 * switched that rule off for every edit: a connected client holding ordinary
 * `memory.write` could silently grow an existing memory to `MAX_BODY_CHARS` with no
 * review, something a brand-new memory of the same length could never do. This file
 * asserts the fix side by side, on the same body length, through the same gate.
 */

import type { Actor, RoomId } from '@photographic/core';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { createPool, createPostgresServices, reset, type PostgresServices } from '../index.js';
import { MAX_BODY_CHARS } from './ingest.js';

const pool = createPool();

let wired: PostgresServices;
let emil: Actor;
let personalRoom: RoomId;

beforeEach(async () => {
  await reset(pool);
  wired = await createPostgresServices({ pool });

  const one = await wired.services.identity.register({
    email: 'emil@ingest-approval.test',
    displayName: 'Emil',
  });
  emil = wired.actorFor(one.person.id);
  personalRoom = one.personalRoom.id;
});

afterAll(async () => {
  await pool.end();
});

/** Long enough to trip the length gate, short enough to stay under `MAX_BODY_CHARS`. */
const LONG_BODY = 'Ö'.repeat(500);
if (LONG_BODY.length >= MAX_BODY_CHARS) {
  throw new Error('test body must stay under MAX_BODY_CHARS to exercise the approval gate, not the hard cap');
}

describe('the length gate holds on update exactly as it does on create', () => {
  it('a fresh 500-character memory needs approval', async () => {
    const decision = await wired.services.ingest.remember(emil, {
      roomId: personalRoom,
      body: LONG_BODY,
    });

    expect(decision.outcome).toBe('needs_approval');
    if (decision.outcome === 'needs_approval') {
      expect(decision.proposal.reason).toMatch(/långt/);
    }
  });

  it('editing an existing memory to the same 500 characters needs approval too', async () => {
    // A short memory first, saved automatically — the edit below must not inherit any
    // leftover slack from the original body's own gate outcome.
    const created = await wired.services.ingest.remember(emil, {
      roomId: personalRoom,
      body: 'en kort anteckning',
    });
    if (created.outcome !== 'auto') throw new Error('expected the short body to auto-save');
    const shortId = created.item.shortId;

    const decision = await wired.services.ingest.update(emil, shortId, personalRoom, LONG_BODY);

    expect(decision.outcome).toBe('needs_approval');
    if (decision.outcome === 'needs_approval') {
      expect(decision.proposal.reason).toMatch(/långt/);
      expect(decision.proposal.body).toBe(LONG_BODY);
    }

    // And it genuinely did not apply: the stored item is still the original, short body.
    const [item] = await wired.services.retrieval.listForRoom(emil, personalRoom);
    expect(item?.body).toBe('en kort anteckning');
  });

  it('the same edit with an explicit flag on the request would not save it any faster either — there is no such flag', async () => {
    // `updateSchema` has no `explicit` field: nothing a caller sends can reach the
    // `update` signature's `provenance` beyond `motivation`/`source`. Asserted here as a
    // type-level fact so a future change that quietly adds one is a compile error this
    // test would need editing to accept, not a silent reopening of the gate.
    const created = await wired.services.ingest.remember(emil, {
      roomId: personalRoom,
      body: 'kort igen',
    });
    if (created.outcome !== 'auto') throw new Error('expected the short body to auto-save');

    type UpdateProvenance = Parameters<typeof wired.services.ingest.update>[4];
    type HasExplicit = 'explicit' extends keyof NonNullable<UpdateProvenance> ? true : false;
    const hasExplicit: HasExplicit = false;
    expect(hasExplicit).toBe(false);

    const decision = await wired.services.ingest.update(
      emil,
      created.item.shortId,
      personalRoom,
      LONG_BODY,
    );
    expect(decision.outcome).toBe('needs_approval');
  });

  it('other gates still hold on update exactly as before — a shared room still queues', async () => {
    const shared = await wired.services.rooms.create(emil, { title: 'Delat rum' });
    const created = await wired.services.ingest.remember(emil, {
      roomId: shared.id,
      body: 'en kort delad anteckning',
      explicit: true,
    });
    if (created.outcome !== 'needs_approval') throw new Error('expected a shared write to queue');
    const item = await wired.services.ingest.resolveProposal(emil, created.proposal.id, true);
    if (!item) throw new Error('expected the proposal to resolve');

    const decision = await wired.services.ingest.update(emil, item.shortId, shared.id, 'kort ändring');
    expect(decision.outcome).toBe('needs_approval');
  });
});
