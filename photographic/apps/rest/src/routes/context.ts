/**
 * Context: the endpoint the whole product exists to serve.
 *
 * Everything else here is management. This is the one a model calls at the start of a
 * session, and it has to be fast and complete, because a person opening a chat and
 * being asked who they are again is the exact experience they came here to stop.
 */

import { buildClients, isDegraded } from '@photographic/connect';
import type { ConnectConfig } from '@photographic/connect';
import type { RoomId } from '@photographic/core';
import { Hono } from 'hono';

import type { AppEnv } from '../context.js';
import { contextQuerySchema } from '../schemas.js';
import { serialiseBundle, serialiseProfile } from '../serialise.js';
import { parseQuery } from '../validation.js';
import { getActor, getServices } from './shared.js';

export function contextRoutes(connect: ConnectConfig): Hono<AppEnv> {
  const routes = new Hono<AppEnv>();
  const clients = buildClients(connect);

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

  /**
   * The per-client delivery lights. Honest reporting, not a success claim.
   *
   * Only AI clients a person connected. Our own web and voice apps open sessions too, and
   * listing them here would put "web" in someone's list of connected AIs with a red light
   * next to it — the app they are reading the list in, reported as broken. A surface is
   * on this list when it is something a person chose to connect, which is exactly the set
   * `@photographic/connect` has descriptors for.
   *
   * `displayName` and `degraded` are decided here rather than left to the caller. Whether
   * `tool_call` counts as degraded depends on what the client was capable of, and that
   * table lives in `@photographic/connect` — every surface asking the same question
   * should get the same answer instead of each re-deriving it and disagreeing.
   */
  routes.get('/clients', async (c) => {
    const actor = getActor(c);
    const health = await getServices(c).sessions.health(actor);

    const connected = health.flatMap((entry) => {
      const client = clients.find((candidate) =>
        candidate.agentClients.includes(entry.agentClient),
      );
      if (!client) return [];

      return [
        {
          agentClient: entry.agentClient,
          displayName: client.displayName,
          lastSeenAt: entry.lastSeenAt.toISOString(),
          profileDelivered: entry.profileDelivered,
          deliveryMethod: entry.deliveryMethod,
          degraded: isDegraded(client.expectedDelivery, entry.deliveryMethod),
        },
      ];
    });

    return c.json({ clients: connected });
  });

  return routes;
}
