/**
 * Rooms, membership and invites.
 *
 * The invite preview is the one endpoint here that takes no token. That is deliberate
 * and it is the growth loop: a person who is sent a link and meets a sign-up form
 * before seeing anything mostly closes the tab.
 */

import type { InviteId, PersonId, RoomId } from '@photographic/core';
import { Hono } from 'hono';

import type { AppEnv } from '../context.js';
import {
  createRoomSchema,
  describeRoomSchema,
  inviteSchema,
  leaveRoomSchema,
  roomIdParam,
} from '../schemas.js';
import {
  serialiseBrief,
  serialiseDocument,
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
      // `isSelf` is computed here, from the actor this request already resolved, rather
      // than asking the client to know its own person id: nothing before this exposed it,
      // and the room screen's only use for it is telling other members apart from you
      // when naming who a room is shared with.
      members: members.map((m) => ({
        personId: m.person.id,
        displayName: m.person.displayName,
        role: m.role,
        isSelf: m.person.id === actor.personId,
      })),
    });
  });

  /**
   * Active memories in a room, for the room screen.
   *
   * The room GET returns brief + members only — a rendered summary is not a list the UI
   * can soft-delete against. Search needs a query. This is the plain list: shortId, kind,
   * body. Membership is enforced inside retrieval; unreachable rooms are 404.
   */
  routes.get('/rooms/:roomId/items', async (c) => {
    const actor = getActor(c);
    const { roomId } = parseParams(c, roomIdParam);

    const items = await getServices(c).retrieval.listForRoom(actor, roomId as RoomId);
    return c.json({
      items: items.map((item) => ({
        shortId: item.shortId,
        kind: item.kind,
        body: item.body,
      })),
    });
  });

  /**
   * Documents in a room, for the Dokument shelf.
   *
   * The card fields, not the contents: the extracted text and the original bytes each
   * have their own endpoint under `/documents/:id`, because either can be megabytes and
   * a list that sometimes carries one is a list that sometimes times out.
   *
   * `extraction` is here so the shelf can say "kan inte läsas" on a scanned PDF rather
   * than showing a row that looks like every other one and silently is not searchable.
   *
   * Membership is enforced inside `DocumentPort`; unreachable rooms are 404.
   */
  routes.get('/rooms/:roomId/documents', async (c) => {
    const actor = getActor(c);
    const { roomId } = parseParams(c, roomIdParam);

    const documents = await getServices(c).documents.listForRoom(actor, roomId as RoomId);
    return c.json({ documents: documents.map(serialiseDocument) });
  });

  /**
   * The room's short context, which is the sentence every connected model reads about
   * this room. Kept as its own endpoint rather than a general room update: this is the
   * one field a person edits after naming a room, and the only one that changes what
   * every AI they use understands the room to be.
   */
  routes.patch('/rooms/:roomId/description', async (c) => {
    const actor = getActor(c);
    const { roomId } = parseParams(c, roomIdParam);
    const { description } = await parseJsonBody(c, describeRoomSchema);

    const room = await getServices(c).rooms.describe(actor, roomId as RoomId, description ?? null);
    return c.json({ room: serialiseRoom(room) });
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

  /**
   * Open invites for a room. Owner-only, because the list is the room's future audience.
   *
   * Revoking something you cannot see is not a feature.
   */
  routes.get('/rooms/:roomId/invites', async (c) => {
    const actor = getActor(c);
    const { roomId } = parseParams(c, roomIdParam);

    const invites = await getServices(c).invites.listForRoom(actor, roomId as RoomId);
    return c.json({ invites: invites.map(serialiseInvite) });
  });

  routes.delete('/invites/:inviteId', async (c) => {
    const actor = getActor(c);
    const inviteId = c.req.param('inviteId') as InviteId;
    await getServices(c).invites.revoke(actor, inviteId);
    return c.body(null, 204);
  });

  /**
   * Leaving a room. The membership ends; the contributions stay.
   *
   * `removeContributions` is the person's own choice and is never defaulted: it takes her
   * memories to the ordinary trash first, visibly, where an owner can undo it for thirty
   * days. Defaulting it either way would be a decision we took on her behalf about other
   * people's memory.
   */
  routes.post('/rooms/:roomId/leave', async (c) => {
    const actor = getActor(c);
    const { roomId } = parseParams(c, roomIdParam);
    const input = await parseJsonBody(c, leaveRoomSchema);

    await getServices(c).rooms.leave(actor, roomId as RoomId, {
      ...(input.removeContributions === undefined
        ? {}
        : { removeContributions: input.removeContributions }),
    });
    return c.body(null, 204);
  });

  /**
   * Removing someone else. Owner-only, and never touches their contributions.
   *
   * Distinct from revoking an invite on purpose: revoking stops a link nobody has used
   * yet, and this ends a membership. Conflating them is the common and dangerous mistake
   * — believing you have shut someone out while they go on reading everything.
   */
  routes.delete('/rooms/:roomId/members/:personId', async (c) => {
    const actor = getActor(c);
    const { roomId } = parseParams(c, roomIdParam);
    const personId = c.req.param('personId') as PersonId;

    await getServices(c).rooms.removeMember(actor, roomId as RoomId, personId);
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
