/**
 * Invites.
 *
 * The invite is the growth loop, and the thing that kills growth loops is asking for an
 * account before showing anything. So `peek` works with no token, no session and no
 * person: the recipient sees what they were invited to, and only then decides whether
 * to type an address.
 */

import { randomBytes } from 'node:crypto';

import type {
  Actor,
  Invite,
  InviteId,
  InvitePort,
  MemberRole,
  NotifyPort,
  PersonId,
  Room,
  RoomId,
} from '@photographic/core';
import { NotFoundError, NotPermittedError, ValidationError } from '@photographic/core';

import { MemoryStore, newId } from './store.js';

export const INVITE_TTL_DAYS = 14;

/** How much of the room an invite is allowed to show before anyone signs up. */
export const PREVIEW_ITEM_COUNT = 3;
export const PREVIEW_MAX_CHARS = 400;

export function inviteToken(): string {
  return randomBytes(24).toString('base64url');
}

export class MemoryInvites implements InvitePort {
  constructor(
    private readonly store: MemoryStore,
    private readonly notify: NotifyPort,
    private readonly baseUrl = 'https://photographic.me',
  ) {}

  async create(
    actor: Actor,
    input: { roomId: RoomId; channel: 'email' | 'sms'; destination: string; role?: MemberRole },
  ): Promise<{ invite: Invite; url: string }> {
    // Only someone who can write to the room may widen who can read it. A viewer
    // inviting others would let the least-trusted member grow the audience.
    if (!this.store.canWrite(actor.personId, input.roomId)) throw new NotPermittedError();

    const room = this.store.rooms.get(input.roomId);
    if (!room) throw new NotPermittedError();
    if (room.kind === 'personal') {
      // The personal room is the one place that is structurally private. Sharing it
      // would turn the profile every model reads into a document with an audience.
      throw new ValidationError('Det personliga rummet kan inte delas.');
    }

    const destination =
      input.channel === 'email' ? input.destination.trim().toLowerCase() : input.destination.trim();
    if (!destination) throw new ValidationError('Ange en mottagare.');

    const now = this.store.now();
    const invite: Invite = {
      id: newId<InviteId>(),
      roomId: input.roomId,
      invitedBy: actor.personId,
      channel: input.channel,
      destination,
      role: input.role ?? 'editor',
      status: 'pending',
      previewAllowed: true,
      expiresAt: new Date(now.getTime() + INVITE_TTL_DAYS * 24 * 60 * 60 * 1000),
      acceptedBy: null,
    };

    const token = inviteToken();
    const url = `${this.baseUrl}/invite/${token}`;
    this.store.invites.set(invite.id, { invite, token, url });

    await this.notify.sendInvite({
      channel: input.channel,
      destination,
      inviterName: this.store.persons.get(actor.personId)?.displayName ?? 'Någon',
      roomTitle: room.title,
      url,
    });

    return { invite, url };
  }

  async peek(token: string): Promise<{
    invite: Invite;
    room: Pick<Room, 'id' | 'title' | 'description'>;
    invitedByName: string | null;
    preview: string | null;
  } | null> {
    const row = this.find(token);
    if (!row) return null;

    const { invite } = row;
    if (invite.status === 'revoked') return null;
    if (invite.expiresAt <= this.store.now()) return null;

    const room = this.store.rooms.get(invite.roomId);
    if (!room) return null;

    return {
      invite,
      room: { id: room.id, title: room.title, description: room.description },
      invitedByName: this.store.persons.get(invite.invitedBy)?.displayName ?? null,
      preview: invite.previewAllowed ? this.previewOf(invite.roomId) : null,
    };
  }

  async accept(token: string, personId: PersonId): Promise<{ room: Room; role: MemberRole }> {
    const row = this.find(token);
    if (!row) throw new NotFoundError('Inbjudan finns inte.');

    const { invite } = row;
    if (invite.status === 'revoked') throw new NotPermittedError('Inbjudan är återkallad.');
    if (invite.expiresAt <= this.store.now()) throw new NotPermittedError('Inbjudan har gått ut.');

    const room = this.store.rooms.get(invite.roomId);
    if (!room) throw new NotFoundError('Rummet finns inte.');

    // Idempotent on purpose: the link arrives by email and gets clicked twice.
    const already = this.store.roleIn(personId, invite.roomId);
    if (already) return { room, role: already };

    this.store.addMembership({
      personId,
      roomId: invite.roomId,
      role: invite.role,
      invitedBy: invite.invitedBy,
    });

    invite.status = 'accepted';
    invite.acceptedBy = personId;

    this.store.append({
      roomId: invite.roomId,
      eventType: 'member.joined',
      payload: { person_id: personId, role: invite.role, via: 'invite' },
      actorPersonId: personId,
      agentClient: 'web',
    });

    return { room, role: invite.role };
  }

  async revoke(actor: Actor, inviteId: InviteId): Promise<void> {
    const row = this.store.invites.get(inviteId);
    if (!row) throw new NotFoundError('Inbjudan finns inte.');
    if (!this.store.canWrite(actor.personId, row.invite.roomId)) throw new NotPermittedError();
    row.invite.status = 'revoked';
  }

  private find(token: string) {
    for (const row of this.store.invites.values()) {
      if (row.token === token) return row;
    }
    return null;
  }

  /**
   * The few lines that make someone want in.
   *
   * Newest first and hard-capped: enough to recognise the room, not a way to read it
   * whole without ever joining.
   */
  private previewOf(roomId: RoomId): string | null {
    const bodies = this.store
      .itemsInRoom(roomId)
      .filter((i) => i.status === 'active' && i.sensitivity === 'normal')
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .slice(0, PREVIEW_ITEM_COUNT)
      .map((i) => i.body);

    if (bodies.length === 0) return null;

    let out = '';
    for (const body of bodies) {
      if (out.length + body.length + 1 > PREVIEW_MAX_CHARS) break;
      out += (out ? '\n' : '') + body;
    }
    return out || bodies[0]!.slice(0, PREVIEW_MAX_CHARS);
  }
}
