/**
 * History and provenance.
 *
 * The visible half of saving silently. Everything a model did without asking is here,
 * attributed to the client that did it, and `provenance` answers the question people
 * actually ask about AI memory — not "why did you forget" but "how do you know that
 * about me".
 */

import type { RoomId, ShortId } from '@photographic/core';
import { Hono } from 'hono';

import type { AppEnv } from '../context.js';
import { historyQuerySchema, shortIdParam } from '../schemas.js';
import { serialiseHistoryEntry } from '../serialise.js';
import { parseParams, parseQuery } from '../validation.js';
import { getActor, getServices } from './shared.js';

export function historyRoutes(): Hono<AppEnv> {
  const routes = new Hono<AppEnv>();

  routes.get('/history', async (c) => {
    const actor = getActor(c);
    const query = parseQuery(c, historyQuerySchema);

    const entries = await getServices(c).history.list(actor, {
      ...(query.room ? { roomId: query.room as RoomId } : {}),
      ...(query.since ? { since: query.since } : {}),
      ...(query.limit ? { limit: query.limit } : {}),
    });

    return c.json({ entries: entries.map(serialiseHistoryEntry) });
  });

  routes.get('/memory/:shortId/provenance', async (c) => {
    const actor = getActor(c);
    const { shortId } = parseParams(c, shortIdParam);
    const room = c.req.query('roomId') as RoomId | undefined;

    const provenance = await getServices(c).history.provenance(actor, shortId as ShortId, room);
    // Null is a 404, same as any other unreachable thing: a memory that is not yours
    // and a memory that does not exist must not be distinguishable.
    if (!provenance) {
      return c.json({ error: { code: 'not_found', message: 'Minnet finns inte.' } }, 404);
    }

    return c.json({
      shortId: provenance.shortId,
      body: provenance.body,
      roomTitle: provenance.roomTitle,
      savedAt: provenance.savedAt.toISOString(),
      savedByClient: provenance.savedByClient,
      approvedByName: provenance.approvedByName,
      // Three of scope §4's six questions were computed by `HistoryPort.provenance` and
      // dropped on the way out of this route: why it was stored where it is, where the
      // information came from, and whether it has changed since.
      motivation: provenance.motivation,
      source: provenance.source,
      changed: provenance.changed,
      /**
       * Which model has seen this text.
       *
       * `external: true` means the memory's own words were sent to a third party to make
       * it searchable by meaning. A person asking "hur vet du det om mig?" is entitled
       * to reach that, and until `0016_embedding_provenance.sql` nothing recorded it.
       * `null` means no vector was ever computed for this memory.
       *
       * The screen that shows this is another track's; what is owned here is that the
       * fact exists and is served.
       */
      embedding: provenance.embedding
        ? {
            provider: provenance.embedding.provider,
            model: provenance.embedding.model,
            external: provenance.embedding.external,
            at: provenance.embedding.at.toISOString(),
          }
        : null,
      timeline: provenance.timeline.map(serialiseHistoryEntry),
    });
  });

  return routes;
}
