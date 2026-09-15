/**
 * The person's own basic identity: their first name.
 *
 * Separate from `routes/account.ts` (export and deletion) and from `routes/context.ts`
 * (session-start context and connected-client management) because this is neither: it is
 * the one piece of a person's own identity that is set directly from a form rather than
 * through a conversation with a model, and it has no MCP tool at all.
 */

import { Hono } from 'hono';

import type { AppEnv } from '../context.js';
import { setFirstNameSchema } from '../schemas.js';
import { parseJsonBody } from '../validation.js';
import { getActor, getServices } from './shared.js';

export function personRoutes(): Hono<AppEnv> {
  const routes = new Hono<AppEnv>();

  /**
   * Whatever the account screen needs to show right now: the name, or that there isn't
   * one yet. Read through `IdentityPort` rather than a new port method — `Person` already
   * carries `displayName`, which is exactly the cache `setFirstName` keeps in sync.
   */
  routes.get('/account', async (c) => {
    const actor = getActor(c);
    const person = await getServices(c).identity.findById(actor.personId);
    if (!person) {
      return c.json({ error: { code: 'not_found', message: 'Kontot finns inte.' } }, 404);
    }
    return c.json({ firstName: person.displayName });
  });

  /**
   * Sets it. First-party only (see `FIRST_PARTY_ONLY_ROUTES`) — the same reasoning as
   * renaming a connected client: no OAuth scope should let a connected AI rewrite what a
   * person is called, because a scope that permitted it would be held by every client
   * holding it. There is no MCP tool for this at all, on either side of that door.
   */
  routes.patch('/account/name', async (c) => {
    const actor = getActor(c);
    const { firstName } = await parseJsonBody(c, setFirstNameSchema);

    const item = await getServices(c).ingest.setFirstName(actor, firstName);
    return c.json({ firstName: item.body });
  });

  return routes;
}
