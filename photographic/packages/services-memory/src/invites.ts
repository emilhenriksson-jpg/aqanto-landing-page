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
import { canInvite } from '@photographic/core';

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
    // Owner only. Inviting is not a write, it is a disclosure decision: it settles who
    // gets to read everything already in the room, including the forty lines written
    // before the invitation was sent. That belongs to whoever set the room up.
    this.assertOwner(actor, input.roomId);

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
    // An invite that has been used, revoked or has run out is not a window into the
    // room any more. `pending` is the only state that shows content, which also means a
    // spent link and a fictional one are the same answer.
    if (invite.status !== 'pending') return null;
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

  /**
   * Redeems an invite, once.
   *
   * An invite link travels through email, SMS, screenshots and forwarded threads, and
   * "it only works once" is the only assumption a person actually makes about one.
   * Nothing here used to check `status`, so after the first acceptance the link kept
   * letting people in until someone revoked it or fourteen days passed — and the person
   * who sent it had no way to know.
   *
   * Everything that is not `pending` is refused as a not-found, the same answer an
   * unknown token gets, so a spent link cannot be distinguished from a fictional one.
   */
  async accept(token: string, personId: PersonId): Promise<{ room: Room; role: MemberRole }> {
    const row = this.find(token);
    if (!row) throw new NotFoundError('Inbjudan finns inte.');

    const { invite } = row;
    const room = this.store.rooms.get(invite.roomId);
    if (!room) throw new NotFoundError('Rummet finns inte.');

    // Before the status check, because the link genuinely does arrive by email and get
    // clicked twice by the same person — and the second click must not read as a stranger
    // reusing a spent invite.
    const already = this.store.roleIn(personId, invite.roomId);
    if (already) return { room, role: already };

    if (invite.status !== 'pending') throw new NotFoundError('Inbjudan finns inte.');
    if (invite.expiresAt <= this.store.now()) throw new NotFoundError('Inbjudan finns inte.');

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

  /**
   * Revoking stops a link that has not been redeemed yet.
   *
   * It does *not* remove anyone who already joined — that is `RoomPort.removeMember`.
   * This is the most common misunderstanding in products with invites, and it is
   * dangerous in the wrong direction: you believe you have shut someone out while they
   * go on reading everything.
   */
  async revoke(actor: Actor, inviteId: InviteId): Promise<void> {
    const row = this.store.invites.get(inviteId);
    if (!row) throw new NotFoundError('Inbjudan finns inte.');
    this.assertOwner(actor, row.invite.roomId);
    row.invite.status = 'revoked';
  }

  /** Owner-only, because the list is the room's future audience. */
  async listForRoom(actor: Actor, roomId: RoomId): Promise<Invite[]> {
    this.assertOwner(actor, roomId);

    return [...this.store.invites.values()]
      .map((row) => row.invite)
      .filter((invite) => invite.roomId === roomId)
      .sort((a, b) => b.expiresAt.getTime() - a.expiresAt.getTime());
  }

  /**
   * Writes `expired` on invites whose deadline has passed.
   *
   * The enum value existed and nothing ever set it, so expiry was a runtime comparison
   * and `status` did not describe reality. Writing it down is what makes a list of open
   * invites honest — and revoking something you cannot see is not a feature.
   */
  async expireOverdue(limit = 500): Promise<number> {
    const now = this.store.now();
    let closed = 0;

    for (const row of this.store.invites.values()) {
      if (closed >= limit) break;
      if (row.invite.status !== 'pending') continue;
      if (row.invite.expiresAt > now) continue;

      row.invite.status = 'expired';
      closed += 1;
    }

    return closed;
  }

  private assertOwner(actor: Actor, roomId: RoomId): void {
    const role = this.store.roleIn(actor.personId, roomId);
    if (!role || !canInvite(role)) throw new NotPermittedError();
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
