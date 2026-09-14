/**
 * The trash.
 *
 * A separate route group from memory, mirroring the port split, and for the same
 * reason: memory is the path a model drives, and this is the safety net a person
 * reaches for. It has to keep working when every assumption about the write path turns
 * out to be wrong, which is easier to be confident about when it does not share code
 * with the thing that was wrong.
 */

import type { RoomId, ShortId } from '@photographic/core';
import { Hono } from 'hono';

import type { AppEnv } from '../context.js';
import { shortIdParam, trashQuerySchema } from '../schemas.js';
import { serialiseItem, serialiseTrashEntry } from '../serialise.js';
import { parseParams, parseQuery } from '../validation.js';
import { getActor, getServices } from './shared.js';

export function trashRoutes(): Hono<AppEnv> {
  const routes = new Hono<AppEnv>();

  routes.get('/trash', async (c) => {
    const actor = getActor(c);
    const query = parseQuery(c, trashQuerySchema);

    const entries = await getServices(c).trash.list(actor, {
      ...(query.room ? { roomId: query.room as RoomId } : {}),
      ...(query.limit ? { limit: query.limit } : {}),
    });

    return c.json({
      entries: entries.map(serialiseTrashEntry),
      retentionDays: 30,
    });
  });

  routes.post('/trash/:shortId/restore', async (c) => {
    const actor = getActor(c);
    const { shortId } = parseParams(c, shortIdParam);
    const room = c.req.query('roomId') as RoomId | undefined;

    const item = await getServices(c).trash.restore(actor, shortId as ShortId, room);
    return c.json({ item: serialiseItem(item) });
  });

  /**
   * Deleting early, for people who want it gone now rather than in thirty days.
   *
   * Worth having even though the deadline exists: a person who has just realised they
   * said something they regret does not want to be told to wait a month, and refusing
   * would undermine the trust the retention window was built to create.
   */
  routes.delete('/trash/:shortId', async (c) => {
    const actor = getActor(c);
    const { shortId } = parseParams(c, shortIdParam);
    const room = c.req.query('roomId') as RoomId | undefined;

    await getServices(c).trash.purgeNow(actor, shortId as ShortId, room);
    return c.body(null, 204);
  });

  return routes;
}
