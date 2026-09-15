/**
 * The calendar: the memory's timeline.
 *
 * Two endpoints, which are the two steps of the zoom the scope asks for — dag ->
 * minneshändelse -> källa. There is deliberately no week, month or year route. Those are
 * derivable from the same log whenever they are wanted, and shipping summaries before the
 * thing being summarised existed would have meant four screens of averages over one
 * screen of facts.
 */

import type { EventSeq, RoomId } from '@photographic/core';
import { Hono } from 'hono';

import type { AppEnv } from '../context.js';
import { calendarDaySchema, seqParam } from '../schemas.js';
import { serialiseCalendarDay, serialiseMemoryEventDetail } from '../serialise.js';
import { parseParams, parseQuery } from '../validation.js';
import { assertRoomInScope, getActor, getServices } from './shared.js';

export function calendarRoutes(): Hono<AppEnv> {
  const routes = new Hono<AppEnv>();

  /**
   * One day, oldest first.
   *
   * `room` narrows it to a single room, which is the view an owner of a shared room
   * actually needs: nothing gates incoming material from the other members, so the only
   * thing between a room and a contribution nobody noticed is a day that shows it plainly.
   */
  routes.get('/calendar/day', async (c) => {
    const actor = getActor(c);
    const query = parseQuery(c, calendarDaySchema);

    const day = await getServices(c).calendar.day(actor, {
      date: query.date,
      ...(query.tz ? { timeZone: query.tz } : {}),
      ...(query.room ? { roomId: assertRoomInScope(actor, query.room as RoomId) } : {}),
    });

    return c.json(serialiseCalendarDay(day));
  });

  /**
   * One event, zoomed: how the memory got here, every value it has held, and the source
   * it came from.
   *
   * Addressed by `seq` rather than by a uuid, because a day hands the caller sequence
   * numbers and an event is immutable — the number it was written under is the only handle
   * it will ever need.
   */
  routes.get('/calendar/events/:seq', async (c) => {
    const actor = getActor(c);
    const { seq } = parseParams(c, seqParam);

    const detail = await getServices(c).calendar.event(actor, seq as EventSeq);
    // Null is a 404 like any other unreachable thing: an event in someone else's room and
    // an event that does not exist must not be distinguishable.
    if (!detail) {
      return c.json({ error: { code: 'not_found', message: 'Händelsen finns inte.' } }, 404);
    }

    return c.json(serialiseMemoryEventDetail(detail));
  });

  return routes;
}
