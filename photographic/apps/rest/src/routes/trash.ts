/**
 * The trash.
 *
 * A separate route group from memory, mirroring the port split, and for the same
 * reason: memory is the path a model drives, and this is the safety net a person
 * reaches for. It has to keep working when every assumption about the write path turns
 * out to be wrong, which is easier to be confident about when it does not share code
 * with the thing that was wrong.
 *
 * One surface for memories and documents. A person who deleted something looks in one place,
 * and a thirty-day promise that behaves differently for a file than for a memory is a promise
 * with a footnote. `:handle` is a short id or a document uuid; see `trashHandleOf`.
 */

import type { RoomId } from '@photographic/core';
import { NotFoundError, trashHandleOf } from '@photographic/core';
import { Hono } from 'hono';

import type { AppEnv } from '../context.js';
import { trashQuerySchema } from '../schemas.js';
import { serialiseDocument, serialiseItem, serialiseTrashEntry } from '../serialise.js';
import { parseQuery } from '../validation.js';
import { getActor, getServices } from './shared.js';

/**
 * Reads whichever kind of handle the path carries.
 *
 * One route for both because the two id shapes cannot collide — `p-7k2m` against a uuid — so
 * a client restores what it is looking at without branching on what kind of thing it is. An
 * unparseable segment is a 404 rather than a 400: a handle nobody can name is
 * indistinguishable from one that does not exist, which is the rule the rest of the API
 * follows for anything a caller might otherwise enumerate.
 */
function handleFrom(raw: string) {
  const handle = trashHandleOf(raw);
  if (!handle) throw new NotFoundError('Det finns inget med det id:t i papperskorgen.');
  return handle;
}

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

  /**
   * Restoring, whichever kind of thing it is.
   *
   * The response is discriminated the same way the entry is: `{ type: 'memory', item }` or
   * `{ type: 'document', document }`. A single shape with both fields nullable would make a
   * client check which one came back, which is the same guess in a different place.
   */
  routes.post('/trash/:handle/restore', async (c) => {
    const actor = getActor(c);
    const handle = handleFrom(c.req.param('handle'));
    const room = c.req.query('roomId') as RoomId | undefined;

    const restored = await getServices(c).trash.restore(actor, handle, room);

    if (restored.type === 'document') {
      return c.json({ type: 'document', document: serialiseDocument(restored.document) });
    }
    return c.json({ type: 'memory', item: serialiseItem(restored.item) });
  });

  /**
   * Deleting early, for people who want it gone now rather than in thirty days.
   *
   * Worth having even though the deadline exists: a person who has just realised they
   * said something they regret does not want to be told to wait a month, and refusing
   * would undermine the trust the retention window was built to create.
   */
  routes.delete('/trash/:handle', async (c) => {
    const actor = getActor(c);
    const handle = handleFrom(c.req.param('handle'));
    const room = c.req.query('roomId') as RoomId | undefined;

    await getServices(c).trash.purgeNow(actor, handle, room);
    return c.body(null, 204);
  });

  return routes;
}
