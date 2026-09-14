/**
 * Context: the endpoint the whole product exists to serve.
 *
 * Everything else here is management. This is the one a model calls at the start of a
 * session, and it has to be fast and complete, because a person opening a chat and
 * being asked who they are again is the exact experience they came here to stop.
 */

import type { RoomId } from '@photographic/core';
import { Hono } from 'hono';

import type { AppEnv } from '../context.js';
import { contextQuerySchema } from '../schemas.js';
import { serialiseBundle, serialiseProfile } from '../serialise.js';
import { parseQuery } from '../validation.js';
import { getActor, getServices } from './shared.js';

export function contextRoutes(): Hono<AppEnv> {
  const routes = new Hono<AppEnv>();

  routes.get('/context', async (c) => {
    const actor = getActor(c);
    const query = parseQuery(c, contextQuerySchema);
    const services = getServices(c);

    const bundle = await services.bundle.build(actor, {
      ...(query.room ? { activeRoomId: query.room as RoomId } : {}),
      ...(query.budget ? { budgetTokens: query.budget } : {}),
    });

    const rendered = services.bundle.render(bundle);

    // Recorded as a delivery when the caller has a session, which is what turns the
    // health screen from a guess into an observation. A client that fetches context and
    // does nothing with it still counts: we cannot see what it did with it, and
    // claiming otherwise would be the dishonest kind of green light.
    if (actor.sessionId) {
      await services.sessions.recordDelivery(
        actor.sessionId,
        'tool_call',
        bundle.profile.version,
      );
    }

    await services.audit.record({ actor, action: 'bundle' });

    return c.json(serialiseBundle(bundle, rendered));
  });

  /** Just the profile, for the paste-it-yourself path on clients with no connector. */
  routes.get('/profile', async (c) => {
    const actor = getActor(c);
    const profile = await getServices(c).projection.getProfile(actor.personId);
    return c.json({ profile: serialiseProfile(profile) });
  });

  /** The per-client delivery lights. Honest reporting, not a success claim. */
  routes.get('/clients', async (c) => {
    const actor = getActor(c);
    const health = await getServices(c).sessions.health(actor);

    return c.json({
      clients: health.map((entry) => ({
        agentClient: entry.agentClient,
        lastSeenAt: entry.lastSeenAt.toISOString(),
        profileDelivered: entry.profileDelivered,
        deliveryMethod: entry.deliveryMethod,
      })),
    });
  });

  return routes;
}
