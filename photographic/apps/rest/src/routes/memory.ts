import { dispatchTool } from '@photographic/mcp';
import { z } from 'zod';
/**
 * The memory routes: what a connected model actually calls.
 *
 * These mirror the MCP tools one for one, because two surfaces that diverge means two
 * different products depending on which door the person came in through. The MCP server
 * and this API both dispatch into the same `Services`, and the tool descriptions in
 * `@photographic/agent` describe exactly these operations.
 */

import type { PlacementDecision, ProposalId, RoomId, ShortId } from '@photographic/core';
import { askMemory, memoryChanges } from '@photographic/core';
import { Hono } from 'hono';

import type { AppContext, AppEnv } from '../context.js';
import {
  placementSchema,
  proposeSchema,
  rememberSchema,
  resolveDisputeSchema,
  resolveProposalSchema,
  searchSchema,
  shortIdParam,
  undoSchema,
  updateSchema,
} from '../schemas.js';
import {
  serialiseAskHit,
  serialiseMemoryChange,
  serialiseDispute,
  serialiseItem,
  serialiseProposal,
  serialiseRouting,
  serialiseSearchHit,
} from '../serialise.js';
import { parseJsonBody, parseParams, parseQuery } from '../validation.js';
import { assertRoomInScope, getActor, getServices, resolveRoom } from './shared.js';

/** Placed, or queued. Same two shapes for `share` and `move`, so a client learns one. */
function serialisePlacement(c: AppContext, decision: PlacementDecision) {
  if (decision.outcome === 'needs_approval') {
    return c.json(
      { outcome: 'needs_approval', proposal: serialiseProposal(decision.proposal) },
      202,
    );
  }
  return c.json(
    { outcome: 'placed', item: serialiseItem(decision.item), seq: decision.event.seq },
    201,
  );
}

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

    // Only resolved when the caller actually named somewhere. Naming nothing no longer
    // means "the personal room" — it means Photographic decides, and says why.
    const roomId =
      input.roomId || input.room ? await resolveRoom(c, actor, input) : undefined;

    const decision = await getServices(c).ingest.remember(actor, {
      ...(roomId ? { roomId } : {}),
      body: input.body,
      ...(input.kind ? { kind: input.kind } : {}),
      ...(input.sensitivity ? { sensitivity: input.sensitivity } : {}),
      ...(input.explicit === undefined ? {} : { explicit: input.explicit }),
      ...(input.motivation ? { motivation: input.motivation } : {}),
    });

    switch (decision.outcome) {
      case 'auto':
        return c.json(
          {
            outcome: 'auto',
            item: serialiseItem(decision.item),
            ...(decision.routing ? { routing: serialiseRouting(decision.routing) } : {}),
          },
          201,
        );

      case 'needs_approval':
        // 202: accepted, not yet done. The model is meant to tell the person it is
        // asking rather than report a save that has not happened.
        return c.json(
          {
            outcome: 'needs_approval',
            proposal: serialiseProposal(decision.proposal),
            ...(decision.routing ? { routing: serialiseRouting(decision.routing) } : {}),
          },
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

  routes.get('/context/contributions', async (c) => c.json(await getServices(c).ingest.contributionState(getActor(c))));
  routes.post('/context/contributions/prepare', async (c) => {
    const input = await parseJsonBody(c, z.unknown());
    const result = await dispatchTool({ services: getServices(c) }, getActor(c), 'prepare_context', input);
    return c.json(result, result.isError ? 400 : 200);
  });
  routes.post('/context/contributions/pause', async (c) => {
    const { paused } = await parseJsonBody(c, z.object({ paused: z.boolean() }).strict());
    return c.json(await getServices(c).ingest.pauseContributions(getActor(c), paused));
  });
  routes.post('/context/contributions/resolve', async (c) => {
    const input = await parseJsonBody(c, z.object({
      ids: z.array(z.string().uuid()).min(1).max(100),
      reviewedIds: z.array(z.string().uuid()).max(100).default([]), accept: z.boolean(),
      expectedReasons: z.record(z.string().uuid(), z.string().max(5000)),
    }).strict());
    return c.json({ results: await getServices(c).ingest.resolveContributions(getActor(c), {
      ids: input.ids as ProposalId[], reviewedIds: input.reviewedIds as ProposalId[], expectedReasons: input.expectedReasons, accept: input.accept,
    }) });
  });

  routes.post('/memory/proposals/:id', async (c) => {
    const actor = getActor(c);
    const { accept } = await parseJsonBody(c, resolveProposalSchema);
    const id = c.req.param('id') as ProposalId;

    const item = await getServices(c).ingest.resolveProposal(actor, id, accept);
    return c.json({ accepted: accept, item: item ? serialiseItem(item) : null });
  });

  /**
   * Editing a memory, through the same gate as saving one.
   *
   * Two outcomes rather than one, and the 202 matters: an edit in a shared room is now a
   * question, and a client that reported it as done would be telling the person their
   * correction had landed when four other people still see the old text.
   */
  routes.patch('/memory/:shortId', async (c) => {
    const actor = getActor(c);
    const { shortId } = parseParams(c, shortIdParam);
    const input = await parseJsonBody(c, updateSchema);
    const roomId = await resolveRoom(c, actor, input);

    const decision = await getServices(c).ingest.update(
      actor,
      shortId as ShortId,
      roomId,
      input.body,
      input.motivation ? { motivation: input.motivation } : {},
    );

    if (decision.outcome === 'needs_approval') {
      return c.json(
        { outcome: 'needs_approval', proposal: serialiseProposal(decision.proposal) },
        202,
      );
    }

    return c.json({ outcome: 'updated', item: serialiseItem(decision.item) });
  });

  /**
   * Asking to share a memory into another room. Always a 202, never a 201.
   *
   * This endpoint cannot place anything. It queues a proposal, and the only route that
   * turns a proposal into a placement is `POST /memory/proposals/:id`, which
   * `FIRST_PARTY_ONLY_ROUTES` restricts to the person's own browser session and which
   * `authenticate` protects against cross-site use. So the yes that widens an audience is
   * always a person pressing something on our own origin, and never a field in a request
   * body from whatever is holding a token.
   */
  routes.post('/memory/:shortId/share', async (c) => {
    const actor = getActor(c);
    const { shortId } = parseParams(c, shortIdParam);
    const input = await parseJsonBody(c, placementSchema);

    const decision = await getServices(c).ingest.share(actor, {
      shortId: shortId as ShortId,
      toRoomId: assertRoomInScope(actor, input.toRoomId as RoomId),
      ...(input.fromRoomId ? { fromRoomId: input.fromRoomId as RoomId } : {}),
      ...(input.motivation ? { motivation: input.motivation } : {}),
    });

    return serialisePlacement(c, decision);
  });

  /**
   * Moving a memory: private -> room, or room -> room. The short id survives.
   *
   * 202 whenever the target is a shared room, for the reason above. A move that only
   * narrows the audience answers 201, because there is no new reader to protect.
   */
  routes.post('/memory/:shortId/move', async (c) => {
    const actor = getActor(c);
    const { shortId } = parseParams(c, shortIdParam);
    const input = await parseJsonBody(c, placementSchema);

    const decision = await getServices(c).ingest.move(actor, {
      shortId: shortId as ShortId,
      toRoomId: assertRoomInScope(actor, input.toRoomId as RoomId),
      ...(input.fromRoomId ? { fromRoomId: input.fromRoomId as RoomId } : {}),
      ...(input.motivation ? { motivation: input.motivation } : {}),
    });

    return serialisePlacement(c, decision);
  });

  /**
   * Unresolved disagreements, in the same queue as proposals.
   *
   * Both are a person being asked to decide something a model is not allowed to decide,
   * and a second inbox is a second thing nobody opens.
   */
  routes.get('/memory/disputes', async (c) => {
    const actor = getActor(c);
    const disputes = await getServices(c).ingest.listDisputes(actor);
    return c.json({ disputes: disputes.map(serialiseDispute) });
  });

  /**
   * Settling one. There is no MCP tool for this and there will not be one: a model
   * choosing between two people's accounts of the same thing is the failure the whole
   * mechanism exists to avoid.
   */
  routes.post('/memory/disputes/resolve', async (c) => {
    const actor = getActor(c);
    const input = await parseJsonBody(c, resolveDisputeSchema);

    const item = await getServices(c).ingest.resolveDispute(actor, {
      winnerShortId: input.winnerShortId as ShortId,
      loserShortId: input.loserShortId as ShortId,
      ...(input.roomId ? { roomId: input.roomId as RoomId } : {}),
      ...(input.resolution ? { resolution: input.resolution } : {}),
    });

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
      c.req.query('reason'),
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

  /**
   * "Fråga mitt minne" (scope §7) lives here too, behind the same route `q` has always
   * used. `since`/`until`/`sort` are additive: a plain `q` with none of them takes the
   * exact path this route has always taken, unchanged, straight through
   * `RetrievalPort.search`. Only a date-scoped or oldest-first question composes in the
   * calendar via `askMemory` — see `packages/core/src/ask.ts` for why that composition
   * lives there rather than in a second implementation per route.
   */
  routes.get('/search', async (c) => {
    const actor = getActor(c);
    const input = parseQuery(c, searchSchema);
    const roomIds = input.room
      ? (Array.isArray(input.room) ? input.room : [input.room]).map((id) => id as never)
      : undefined;

    // `?changes=1` asks a different question from `q` alone: not "what is true now" but
    // "how did this get here". A correction writes a new memory and supersedes the old,
    // so the previous wording lives on a row search excludes by design — see
    // `packages/core/src/changes.ts`, which is where the composition lives for the same
    // reason `askMemory` does.
    if (input.changes) {
      const chains = await memoryChanges(getServices(c), actor, {
        ...(input.q ? { query: input.q } : {}),
        ...(roomIds ? { roomIds } : {}),
        ...(input.since ? { since: input.since } : {}),
        ...(input.until ? { until: input.until } : {}),
        ...(input.limit ? { limit: input.limit } : {}),
      });

      return c.json({ changes: chains.map(serialiseMemoryChange) });
    }

    if (input.since || input.until || input.sort === 'oldest') {
      const hits = await askMemory(getServices(c), actor, {
        ...(input.q ? { query: input.q } : {}),
        ...(roomIds ? { roomIds } : {}),
        ...(input.since ? { since: input.since } : {}),
        ...(input.until ? { until: input.until } : {}),
        ...(input.sort ? { sort: input.sort } : {}),
        ...(input.limit ? { limit: input.limit } : {}),
      });

      return c.json({ hits: hits.map(serialiseAskHit) });
    }

    const hits = await getServices(c).retrieval.search(actor, {
      query: input.q!,
      ...(roomIds ? { roomIds } : {}),
      ...(input.limit ? { limit: input.limit } : {}),
    });

    return c.json({ hits: hits.map(serialiseSearchHit) });
  });

  return routes;
}
