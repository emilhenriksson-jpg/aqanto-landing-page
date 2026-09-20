/**
 * Context: the endpoint the whole product exists to serve.
 *
 * Everything else here is management. This is the one a model calls at the start of a
 * session, and it has to be fast and complete, because a person opening a chat and
 * being asked who they are again is the exact experience they came here to stop.
 */

import { clientDisplayName } from '@photographic/auth';
import { buildClients, chatgptPluginId, isDegraded } from '@photographic/connect';
import type { ConnectConfig } from '@photographic/connect';
import type { AgentClient, PersonId, RoomId } from '@photographic/core';
import { Hono } from 'hono';

import type { AppContext, AppEnv } from '../context.js';
import { contextQuerySchema, renameClientSchema, chatgptLaunchSchema } from '../schemas.js';
import { serialiseBundle, serialiseProfile } from '../serialise.js';
import { parseJsonBody, parseQuery } from '../validation.js';
import { getActor, getServices } from './shared.js';

export interface ContextRouteDeps {
  connect: ConnectConfig;
  /**
   * Per-person client grants. Null when there is no database behind the process, in
   * which case the registration half of `Klienter` is absent rather than faked.
   */
  clientGrants?: ClientGrants | null;
  /**
   * Kills every token one client holds for one person. Returns how many died.
   *
   * Injected because the authorization server owns tokens and this app owns routes.
   * Revoking here rather than asking the person to wait for expiry is the entire
   * difference between a disconnect button and a suggestion.
   */
  revokeClientTokens?: (input: { personId: PersonId; clientId: string }) => Promise<number>;
}

/**
 * The slice of `PgClientGrants` these routes use.
 *
 * Declared here rather than imported so `app.ts` and its tests do not have to load a
 * Postgres client to serve the rest of the API.
 */
export interface ClientGrants {
  list(personId: PersonId): Promise<
    Array<{
      clientId: string;
      chatgptPluginId?: string | null;
      displayName: string | null;
      clientLabel: string;
      agentClient: AgentClient;
      scope: string;
      firstSeenAt: Date;
      lastSeenAt: Date;
      revokedAt: Date | null;
      writesToday: number;
    }>
  >;
  rename(input: {
    personId: PersonId;
    clientId: string;
    displayName: string | null;
  }): Promise<boolean>;
  revoke(input: { personId: PersonId; clientId: string }): Promise<boolean>;
  setChatgptPlugin?(input: { personId: PersonId; clientId: string; pluginId: string }): Promise<boolean>;
}

export function contextRoutes(deps: ContextRouteDeps): Hono<AppEnv> {
  const routes = new Hono<AppEnv>();
  const connect = deps.connect;
  const clients = buildClients(connect);
  const grants = deps.clientGrants ?? null;

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
    const registrations = grants ? await grants.list(actor.personId) : [];

    const connected = health.flatMap((entry) => {
      const client = clients.find((candidate) =>
        candidate.agentClients.includes(entry.agentClient),
      );
      if (!client) return [];

      // The registration a session belongs to, matched on the frozen `agent_client`
      // rather than on the name the client sent. That is the whole point of freezing it.
      const grant = registrations.find((row) => row.agentClient === entry.agentClient);

      return [
        {
          agentClient: entry.agentClient,
          clientId: grant?.clientId ?? null,
          chatgptPluginId: grant?.revokedAt ? null : grant?.chatgptPluginId ?? null,
          // The person's own name wins, then the frozen label, then the connect
          // descriptor. Never the registration name a client chose for itself.
          displayName: clientDisplayName({
            displayName: grant?.displayName ?? null,
            clientLabel: grant?.clientLabel ?? client.displayName,
          }),
          renamed: Boolean(grant?.displayName),
          lastSeenAt: entry.lastSeenAt.toISOString(),
          profileDelivered: entry.profileDelivered,
          deliveryMethod: entry.deliveryMethod,
          degraded: isDegraded(client.expectedDelivery, entry.deliveryMethod),
          scope: grant?.scope ?? null,
          writesToday: grant?.writesToday ?? null,
          revoked: Boolean(grant?.revokedAt),
        },
      ];
    });

    /**
     * Registrations with no session yet, or whose session predates the grant table.
     *
     * Worth listing separately rather than dropping: a client that registered and holds
     * a live token but has not opened a session is exactly the thing a person needs to
     * be able to see in order to revoke it.
     */
    const dormant = registrations
      .filter((row) => !connected.some((entry) => entry.clientId === row.clientId))
      .map((row) => ({
        agentClient: row.agentClient,
        clientId: row.clientId,
        chatgptPluginId: row.revokedAt ? null : row.chatgptPluginId ?? null,
        displayName: clientDisplayName(row),
        renamed: Boolean(row.displayName),
        lastSeenAt: row.lastSeenAt.toISOString(),
        profileDelivered: false,
        deliveryMethod: null,
        degraded: false,
        scope: row.scope,
        writesToday: row.writesToday,
        revoked: Boolean(row.revokedAt),
      }));

    return c.json({ clients: [...connected, ...dormant] });
  });

  routes.patch('/clients/:clientId/chatgpt-launch', async (c) => {
    const actor = getActor(c);
    if (!grants?.setChatgptPlugin) return noRegistry(c);
    const { link } = await parseJsonBody(c, chatgptLaunchSchema);
    const pluginId = chatgptPluginId(link);
    if (!pluginId) return c.json({ error: { code: 'validation', message: 'Ange länken till din privata Photographic-app på chatgpt.com.' } }, 400);
    const clientId = c.req.param('clientId');
    const saved = await grants.setChatgptPlugin({ personId: actor.personId, clientId, pluginId });
    if (!saved) return c.json({ error: { code: 'not_found', message: 'En aktiv ChatGPT-koppling behövs.' } }, 404);
    return c.json({ clientId, chatgptPluginId: pluginId });
  });

  /**
   * Renames a client: "Claude på jobbdatorn".
   *
   * The person's name for it, stored against their own grant. The client's own label is
   * immutable by database trigger, so this is the only way the name shown in history and
   * in "hur vet du det?" can change — and it can only be changed by the person, never by
   * the client describing itself differently on its next request.
   *
   * `null` hands the name back to the frozen label.
   */
  routes.patch('/clients/:clientId', async (c) => {
    const actor = getActor(c);
    if (!grants) return noRegistry(c);

    const clientId = c.req.param('clientId');
    const { displayName } = await parseJsonBody(c, renameClientSchema);

    const renamed = await grants.rename({
      personId: actor.personId,
      clientId,
      displayName: displayName ?? null,
    });
    if (!renamed) {
      return c.json({ error: { code: 'not_found', message: 'Klienten finns inte.' } }, 404);
    }

    return c.json({ clientId, displayName: displayName ?? null });
  });

  /**
   * Disconnects one client. Every token it holds dies now, not at expiry.
   *
   * Two steps that both matter. Revoking the token family is what stops the next
   * request; marking the grant revoked is what makes it stick, and is the difference
   * between "this client's token expired" and "this person does not want this client
   * reading their memory". Authorizing the client again clears it.
   */
  routes.delete('/clients/:clientId', async (c) => {
    const actor = getActor(c);
    if (!grants) return noRegistry(c);

    const clientId = c.req.param('clientId');
    const revoked = await grants.revoke({ personId: actor.personId, clientId });
    const tokens = deps.revokeClientTokens
      ? await deps.revokeClientTokens({ personId: actor.personId, clientId })
      : 0;

    if (!revoked && tokens === 0) {
      return c.json({ error: { code: 'not_found', message: 'Klienten finns inte.' } }, 404);
    }

    return c.json({ clientId, revoked: true, tokensRevoked: tokens });
  });

  return routes;
}

/**
 * Said plainly rather than as an empty list.
 *
 * An empty `Klienter` screen reads as "no AI can reach your memory", which would be a
 * false statement about a process whose tokens live in memory. 503 is the honest answer:
 * the feature needs persistence and this deployment has none.
 */
function noRegistry(c: AppContext) {
  return c.json(
    {
      error: {
        code: 'unavailable',
        message: 'Klienthantering kräver en databas. Sätt DATABASE_URL.',
      },
    },
    503,
  );
}
