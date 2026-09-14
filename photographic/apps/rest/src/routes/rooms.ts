/**
 * Rooms, membership and invites.
 *
 * The invite preview is the one endpoint here that takes no token. That is deliberate
 * and it is the growth loop: a person who is sent a link and meets a sign-up form
 * before seeing anything mostly closes the tab.
 */

import type { InviteId, RoomId } from '@photographic/core';
import { Hono } from 'hono';

import type { AppEnv } from '../context.js';
import { createRoomSchema, inviteSchema, roomIdParam } from '../schemas.js';
import {
  serialiseBrief,
  serialiseInvite,
  serialiseRoom,
  serialiseRoomSummary,
} from '../serialise.js';
import { parseJsonBody, parseParams } from '../validation.js';
import { getActor, getServices } from './shared.js';

export function roomRoutes(): Hono<AppEnv> {
  const routes = new Hono<AppEnv>();

  routes.get('/rooms', async (c) => {
    const actor = getActor(c);
    const rooms = await getServices(c).rooms.listForPerson(actor);
    return c.json({ rooms: rooms.map(serialiseRoomSummary) });
  });

  routes.post('/rooms', async (c) => {
    const actor = getActor(c);
    const input = await parseJsonBody(c, createRoomSchema);
    const room = await getServices(c).rooms.create(actor, input);
    return c.json({ room: serialiseRoom(room) }, 201);
  });

  routes.get('/rooms/:roomId', async (c) => {
    const actor = getActor(c);
    const { roomId } = parseParams(c, roomIdParam);
    const services = getServices(c);

    const room = await services.rooms.get(actor, roomId as RoomId);
    if (!room) {
      return c.json({ error: { code: 'not_found', message: 'Rummet finns inte.' } }, 404);
    }

    const brief = await services.projection.getBrief(actor, room.id);
    const members = await services.rooms.members(actor, room.id);

    return c.json({
      room: serialiseRoom(room),
      brief: serialiseBrief(brief),
      members: members.map((m) => ({
        personId: m.person.id,
        displayName: m.person.displayName,
        role: m.role,
      })),
    });
  });

  routes.post('/rooms/:roomId/seen', async (c) => {
    const actor = getActor(c);
    const { roomId } = parseParams(c, roomIdParam);
    await getServices(c).rooms.markSeen(actor, roomId as RoomId);
    return c.body(null, 204);
  });

  routes.delete('/rooms/:roomId', async (c) => {
    const actor = getActor(c);
    const { roomId } = parseParams(c, roomIdParam);
    await getServices(c).rooms.archive(actor, roomId as RoomId);
    return c.body(null, 204);
  });

  routes.post('/rooms/:roomId/invites', async (c) => {
    const actor = getActor(c);
    const { roomId } = parseParams(c, roomIdParam);
    const input = await parseJsonBody(c, inviteSchema);

    const { invite, url } = await getServices(c).invites.create(actor, {
      roomId: roomId as RoomId,
      channel: input.channel,
      destination: input.destination,
      ...(input.role ? { role: input.role } : {}),
    });

    // The URL comes back so the inviter can share it directly. It is the one place the
    // token appears, and it never goes in a log line.
    return c.json({ invite: serialiseInvite(invite), url }, 201);
  });

  routes.delete('/invites/:inviteId', async (c) => {
    const actor = getActor(c);
    const inviteId = c.req.param('inviteId') as InviteId;
    await getServices(c).invites.revoke(actor, inviteId);
    return c.body(null, 204);
  });

  return routes;
}

/**
 * The unauthenticated half: preview an invite, before any account exists.
 *
 * Mounted separately in `app.ts` so it sits outside the auth middleware. It is rate
 * limited harder than everything else, because it is the only endpoint a stranger can
 * call and the only one where guessing tokens would be worth anything.
 */
export function publicInviteRoutes(): Hono<AppEnv> {
  const routes = new Hono<AppEnv>();

  routes.get('/invites/:token', async (c) => {
    const token = c.req.param('token');
    const preview = await c.get('services').invites.peek(token);

    if (!preview) {
      return c.json({ error: { code: 'not_found', message: 'Inbjudan finns inte.' } }, 404);
    }

    return c.json({
      room: { title: preview.room.title, description: preview.room.description },
      invitedByName: preview.invitedByName,
      // A few lines of the room, so the person can see what they are joining. Capped
      // in the port, not here: reading a room whole without ever joining is not a
      // preview.
      preview: preview.preview,
      role: preview.invite.role,
      expiresAt: preview.invite.expiresAt.toISOString(),
    });
  });

  return routes;
}
