/**
 * Invites, backed by Postgres.
 *
 * The token is hashed at rest (`invite.token_hash`), exactly as the schema comment
 * requires: the raw token only ever exists in the sent link. SHA-256 is enough here --
 * this is a lookup key, not a password, and the token is 24 random bytes to begin with.
 */

import { createHash, randomBytes } from 'node:crypto';

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
import type { Pool } from 'pg';

import { queryOne, queryRows } from '../pool.js';
import { mapInvite, mapPerson, mapRoom, type InviteRow, type PersonRow, type RoomRow } from '../rows.js';
import { appendEvent } from './events.js';
import { canWrite, roleIn } from './permissions.js';

export const INVITE_TTL_DAYS = 14;
export const PREVIEW_ITEM_COUNT = 3;
export const PREVIEW_MAX_CHARS = 400;

export function inviteToken(): string {
  return randomBytes(24).toString('base64url');
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export class PgInvites implements InvitePort {
  constructor(
    private readonly pool: Pool,
    private readonly notify: NotifyPort,
    private readonly baseUrl = 'https://photographic.me',
  ) {}

  async create(
    actor: Actor,
    input: { roomId: RoomId; channel: 'email' | 'sms'; destination: string; role?: MemberRole },
  ): Promise<{ invite: Invite; url: string }> {
    if (!(await canWrite(this.pool, actor.personId, input.roomId))) throw new NotPermittedError();

    const room = await queryOne<RoomRow>(
      this.pool,
      `SELECT id, kind, slug, title, description, sensitivity, created_by, created_at, archived_at
       FROM app.room WHERE id = $1`,
      [input.roomId],
    );
    if (!room) throw new NotPermittedError();
    if (room.kind === 'personal') {
      throw new ValidationError('Det personliga rummet kan inte delas.');
    }

    const destination =
      input.channel === 'email' ? input.destination.trim().toLowerCase() : input.destination.trim();
    if (!destination) throw new ValidationError('Ange en mottagare.');

    const token = inviteToken();
    const url = `${this.baseUrl}/invite/${token}`;

    const row = await queryOne<InviteRow>(
      this.pool,
      `INSERT INTO app.invite (room_id, invited_by, channel, destination, role, token_hash, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, now() + interval '${INVITE_TTL_DAYS} days')
       RETURNING id, room_id, invited_by, channel, destination, role, status, preview_allowed, expires_at, accepted_by`,
      [input.roomId, actor.personId, input.channel, destination, input.role ?? 'editor', hashToken(token)],
    );
    const invite = mapInvite(row!);

    const inviter = await queryOne<PersonRow>(
      this.pool,
      `SELECT id, handle, display_name, email, phone, locale, created_at FROM app.person WHERE id = $1`,
      [actor.personId],
    );

    await this.notify.sendInvite({
      channel: input.channel,
      destination,
      inviterName: inviter ? mapPerson(inviter).displayName ?? 'Någon' : 'Någon',
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
    const row = await queryOne<InviteRow>(
      this.pool,
      `SELECT id, room_id, invited_by, channel, destination, role, status, preview_allowed, expires_at, accepted_by
       FROM app.invite WHERE token_hash = $1`,
      [hashToken(token)],
    );
    if (!row) return null;

    const invite = mapInvite(row);
    if (invite.status === 'revoked') return null;
    if (invite.expiresAt <= new Date()) return null;

    const room = await queryOne<RoomRow>(
      this.pool,
      `SELECT id, kind, slug, title, description, sensitivity, created_by, created_at, archived_at
       FROM app.room WHERE id = $1`,
      [invite.roomId],
    );
    if (!room) return null;

    const inviter = await queryOne<PersonRow>(
      this.pool,
      `SELECT id, handle, display_name, email, phone, locale, created_at FROM app.person WHERE id = $1`,
      [invite.invitedBy],
    );

    const mapped = mapRoom(room);
    return {
      invite,
      room: { id: mapped.id, title: mapped.title, description: mapped.description },
      invitedByName: inviter ? mapPerson(inviter).displayName : null,
      preview: invite.previewAllowed ? await this.previewOf(invite.roomId) : null,
    };
  }

  async accept(token: string, personId: PersonId): Promise<{ room: Room; role: MemberRole }> {
    const row = await queryOne<InviteRow>(
      this.pool,
      `SELECT id, room_id, invited_by, channel, destination, role, status, preview_allowed, expires_at, accepted_by
       FROM app.invite WHERE token_hash = $1`,
      [hashToken(token)],
    );
    if (!row) throw new NotFoundError('Inbjudan finns inte.');

    const invite = mapInvite(row);
    if (invite.status === 'revoked') throw new NotPermittedError('Inbjudan är återkallad.');
    if (invite.expiresAt <= new Date()) throw new NotPermittedError('Inbjudan har gått ut.');

    const roomRow = await queryOne<RoomRow>(
      this.pool,
      `SELECT id, kind, slug, title, description, sensitivity, created_by, created_at, archived_at
       FROM app.room WHERE id = $1`,
      [invite.roomId],
    );
    if (!roomRow) throw new NotFoundError('Rummet finns inte.');
    const room = mapRoom(roomRow);

    const already = await roleIn(this.pool, personId, invite.roomId);
    if (already) return { room, role: already };

    await this.pool.query(
      `INSERT INTO app.membership (person_id, room_id, role, invited_by)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (person_id, room_id) DO UPDATE SET role = $3, left_at = NULL`,
      [personId, invite.roomId, invite.role, invite.invitedBy],
    );

    await this.pool.query(
      `UPDATE app.invite SET status = 'accepted', accepted_by = $1, accepted_at = now() WHERE id = $2`,
      [personId, invite.id],
    );

    await appendEvent(this.pool, {
      roomId: invite.roomId,
      eventType: 'member.joined',
      payload: { person_id: personId, role: invite.role, via: 'invite' },
      actorPersonId: personId,
      agentClient: 'web',
    });

    return { room, role: invite.role };
  }

  async revoke(actor: Actor, inviteId: InviteId): Promise<void> {
    const row = await queryOne<InviteRow>(
      this.pool,
      `SELECT id, room_id, invited_by, channel, destination, role, status, preview_allowed, expires_at, accepted_by
       FROM app.invite WHERE id = $1`,
      [inviteId],
    );
    if (!row) throw new NotFoundError('Inbjudan finns inte.');
    const invite = mapInvite(row);
    if (!(await canWrite(this.pool, actor.personId, invite.roomId))) throw new NotPermittedError();

    await this.pool.query(`UPDATE app.invite SET status = 'revoked' WHERE id = $1`, [inviteId]);
  }

  private async previewOf(roomId: RoomId): Promise<string | null> {
    const rows = await queryRows<{ body: string }>(
      this.pool,
      `SELECT body FROM app.item
       WHERE room_id = $1 AND status = 'active' AND sensitivity = 'normal'
       ORDER BY created_at DESC
       LIMIT $2`,
      [roomId, PREVIEW_ITEM_COUNT],
    );
    const bodies = rows.map((r) => r.body);
    if (bodies.length === 0) return null;

    let out = '';
    for (const body of bodies) {
      if (out.length + body.length + 1 > PREVIEW_MAX_CHARS) break;
      out += (out ? '\n' : '') + body;
    }
    return out || bodies[0]!.slice(0, PREVIEW_MAX_CHARS);
  }
}
