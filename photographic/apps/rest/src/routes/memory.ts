/**
 * The memory routes: what a connected model actually calls.
 *
 * These mirror the MCP tools one for one, because two surfaces that diverge means two
 * different products depending on which door the person came in through. The MCP server
 * and this API both dispatch into the same `Services`, and the tool descriptions in
 * `@photographic/agent` describe exactly these operations.
 */

import type { ProposalId, ShortId } from '@photographic/core';
import { Hono } from 'hono';

import type { AppEnv } from '../context.js';
import {
  proposeSchema,
  rememberSchema,
  resolveProposalSchema,
  searchSchema,
  shortIdParam,
  undoSchema,
  updateSchema,
} from '../schemas.js';
import {
  serialiseItem,
  serialiseProposal,
  serialiseSearchHit,
} from '../serialise.js';
import { parseJsonBody, parseParams, parseQuery } from '../validation.js';
import { getActor, getServices, resolveRoom } from './shared.js';

export function memoryRoutes(): Hono<AppEnv> {
  const routes = new Hono<AppEnv>();

  /**
   * The write path. Returns which of the three tiers happened, and the response shape
   * differs per tier on purpose: a model has to be able to tell "saved" from "I need to
   * ask them first" without guessing, and a single 201 for both would make the
   * difference invisible.
   */
  routes.post('/memory', async (c) => {
    const actor = getActor(c);
    const input = await parseJsonBody(c, rememberSchema);
    const roomId = await resolveRoom(c, actor, input);

    const decision = await getServices(c).ingest.remember(actor, {
      roomId,
      body: input.body,
      ...(input.kind ? { kind: input.kind } : {}),
      ...(input.sensitivity ? { sensitivity: input.sensitivity } : {}),
      ...(input.explicit === undefined ? {} : { explicit: input.explicit }),
    });

    switch (decision.outcome) {
      case 'auto':
        return c.json({ outcome: 'auto', item: serialiseItem(decision.item) }, 201);

      case 'needs_approval':
        // 202: accepted, not yet done. The model is meant to tell the person it is
        // asking rather than report a save that has not happened.
        return c.json(
          { outcome: 'needs_approval', proposal: serialiseProposal(decision.proposal) },
          202,
        );

      case 'duplicate':
        return c.json({ outcome: 'duplicate', item: serialiseItem(decision.existing) }, 200);
    }
  });

  /** Always a proposal. Used by the import flow; see `IngestPort.propose`. */
  routes.post('/memory/proposals', async (c) => {
    const actor = getActor(c);
    const input = await parseJsonBody(c, proposeSchema);
    const roomId = await resolveRoom(c, actor, input);

    const proposal = await getServices(c).ingest.propose(actor, {
      roomId,
      body: input.body,
      ...(input.kind ? { kind: input.kind } : {}),
      ...(input.reason ? { reason: input.reason } : {}),
      ...(input.source ? { source: input.source } : {}),
    });

    return c.json({ proposal: serialiseProposal(proposal) }, 201);
  });

  routes.get('/memory/proposals', async (c) => {
    const actor = getActor(c);
    const proposals = await getServices(c).ingest.listProposals(actor);
    return c.json({ proposals: proposals.map(serialiseProposal) });
  });

  routes.post('/memory/proposals/:id', async (c) => {
    const actor = getActor(c);
    const { accept } = await parseJsonBody(c, resolveProposalSchema);
    const id = c.req.param('id') as ProposalId;

    const item = await getServices(c).ingest.resolveProposal(actor, id, accept);
    return c.json({ accepted: accept, item: item ? serialiseItem(item) : null });
  });

  routes.patch('/memory/:shortId', async (c) => {
    const actor = getActor(c);
    const { shortId } = parseParams(c, shortIdParam);
    const input = await parseJsonBody(c, updateSchema);
    const roomId = await resolveRoom(c, actor, input);

    const item = await getServices(c).ingest.update(
      actor,
      shortId as ShortId,
      roomId,
      input.body,
    );
    return c.json({ item: serialiseItem(item) });
  });

  /**
   * Soft delete. Returns the undo token, which is what lets the model say "say undo if
   * that was wrong" in the same reply rather than sending the person to a settings
   * screen they have never opened.
   */
  routes.delete('/memory/:shortId', async (c) => {
    const actor = getActor(c);
    const { shortId } = parseParams(c, shortIdParam);
    const roomId = await resolveRoom(c, actor, {
      ...(c.req.query('roomId') ? { roomId: c.req.query('roomId')! } : {}),
      ...(c.req.query('room') ? { room: c.req.query('room')! } : {}),
    });

    const { item, undoToken } = await getServices(c).ingest.forget(
      actor,
      shortId as ShortId,
      roomId,
    );

    return c.json({
      item: serialiseItem(item),
      undoToken,
      daysRecoverable: 30,
    });
  });

  routes.post('/memory/undo', async (c) => {
    const actor = getActor(c);
    const { undoToken } = await parseJsonBody(c, undoSchema);
    const item = await getServices(c).ingest.undo(actor, undoToken);
    return c.json({ item: serialiseItem(item) });
  });

  routes.get('/search', async (c) => {
    const actor = getActor(c);
    const input = parseQuery(c, searchSchema);
    const roomIds = input.room
      ? (Array.isArray(input.room) ? input.room : [input.room]).map((id) => id as never)
      : undefined;

    const hits = await getServices(c).retrieval.search(actor, {
      query: input.q,
      ...(roomIds ? { roomIds } : {}),
      ...(input.limit ? { limit: input.limit } : {}),
    });

    return c.json({ hits: hits.map(serialiseSearchHit) });
  });

  return routes;
}
