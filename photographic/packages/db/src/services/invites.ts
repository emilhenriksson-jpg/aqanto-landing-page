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
import { canInvite } from '@photographic/core';
import type { Pool } from 'pg';

import { queryOne, queryRows, withTransaction, type Db } from '../pool.js';
import { mapInvite, mapPerson, mapRoom, type InviteRow, type PersonRow, type RoomRow } from '../rows.js';
import { appendEvent } from './events.js';
import { assertNotFrozen, roleIn } from './permissions.js';

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
    await assertNotFrozen(this.pool, actor.personId);

    // Owner only. Inviting is not a write, it is a disclosure decision: it settles who
    // gets to read everything already in the room, retroactively.
    await this.assertOwner(actor, input.roomId);

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
    // An invite that has been used, revoked or run out is not a window into the room any
    // more. `pending` is the only state that shows content, which also makes a spent link
    // and a fictional one the same answer.
    if (invite.status !== 'pending') return null;
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

  /**
   * Redeems an invite, once.
   *
   * An invite link travels through email, SMS, screenshots and forwarded threads, and
   * "it only works once" is the only assumption a person actually makes about one.
   * Nothing here used to check `status`, so after the first acceptance the link kept
   * letting people in until someone revoked it or fourteen days passed — and whoever sent
   * it had no way to know.
   *
   * The status update is conditional on `status = 'pending'` in SQL rather than checked
   * and then written, so two people clicking the same link at the same moment cannot both
   * pass: one row update wins and the other gets the same not-found as an unknown token.
   */
  /**
   * `db` defaults to the pool. Passed an already-open client — from
   * `registerWithInvite` in `postgres-services.ts` — `withTransaction` nests as a
   * savepoint on the same transaction that just registered the person, so a spent,
   * expired or otherwise invalid invite rolls the registration back with it instead of
   * leaving an orphan account behind.
   */
  async accept(
    token: string,
    personId: PersonId,
    db: Db = this.pool,
  ): Promise<{ room: Room; role: MemberRole }> {
    const row = await queryOne<InviteRow>(
      this.pool,
      `SELECT id, room_id, invited_by, channel, destination, role, status, preview_allowed, expires_at, accepted_by
       FROM app.invite WHERE token_hash = $1`,
      [hashToken(token)],
    );
    if (!row) throw new NotFoundError('Inbjudan finns inte.');

    const invite = mapInvite(row);

    const roomRow = await queryOne<RoomRow>(
      this.pool,
      `SELECT id, kind, slug, title, description, sensitivity, created_by, created_at, archived_at
       FROM app.room WHERE id = $1`,
      [invite.roomId],
    );
    if (!roomRow) throw new NotFoundError('Rummet finns inte.');
    const room = mapRoom(roomRow);

    // Before the status check, because the link genuinely does arrive by email and get
    // clicked twice by the same person — and the second click must not read as a stranger
    // reusing a spent invite. Read through the pool rather than `db`: a person freshly
    // registered inside the same not-yet-committed transaction cannot already be a member
    // of anything, so this answer is correct either way, and reading the ambient snapshot
    // avoids a query that would otherwise need to know whether it is inside one.
    const already = await roleIn(this.pool, personId, invite.roomId);
    if (already) return { room, role: already };

    return withTransaction(db, async (tx) => {
      const claimed = await tx.query(
        `UPDATE app.invite
         SET status = 'accepted', accepted_by = $1, accepted_at = now()
         WHERE id = $2 AND status = 'pending' AND expires_at > now()`,
        [personId, invite.id],
      );
      if (claimed.rowCount === 0) throw new NotFoundError('Inbjudan finns inte.');

      await tx.query(
        `INSERT INTO app.membership (person_id, room_id, role, invited_by)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (person_id, room_id) DO UPDATE SET role = $3, left_at = NULL`,
        [personId, invite.roomId, invite.role, invite.invitedBy],
      );

      await appendEvent(tx, {
        roomId: invite.roomId,
        eventType: 'member.joined',
        payload: { person_id: personId, role: invite.role, via: 'invite' },
        actorPersonId: personId,
        agentClient: 'web',
        motivation: 'Gick med via en inbjudan.',
      });

      return { room, role: invite.role };
    });
  }

  /**
   * Revoking stops a link that has not been redeemed yet.
   *
   * It does *not* remove anyone who already joined — that is `RoomPort.removeMember`.
   * This is the most common misunderstanding in products with invites, and it is
   * dangerous in the wrong direction: you believe you have shut someone out while they go
   * on reading everything.
   */
  async revoke(actor: Actor, inviteId: InviteId): Promise<void> {
    const row = await queryOne<InviteRow>(
      this.pool,
      `SELECT id, room_id, invited_by, channel, destination, role, status, preview_allowed, expires_at, accepted_by
       FROM app.invite WHERE id = $1`,
      [inviteId],
    );
    if (!row) throw new NotFoundError('Inbjudan finns inte.');
    const invite = mapInvite(row);
    await this.assertOwner(actor, invite.roomId);

    await this.pool.query(`UPDATE app.invite SET status = 'revoked' WHERE id = $1`, [inviteId]);
  }

  /** Owner-only, because the list is the room's future audience. */
  async listForRoom(actor: Actor, roomId: RoomId): Promise<Invite[]> {
    await this.assertOwner(actor, roomId);

    const rows = await queryRows<InviteRow>(
      this.pool,
      `SELECT id, room_id, invited_by, channel, destination, role, status, preview_allowed, expires_at, accepted_by
       FROM app.invite WHERE room_id = $1 ORDER BY created_at DESC`,
      [roomId],
    );
    return rows.map(mapInvite);
  }

  /**
   * Writes `expired` on invites whose deadline has passed, from the `expire_invites` job.
   *
   * The enum value existed and nothing ever set it, so expiry was a runtime comparison
   * and `status` did not describe reality — which made any list of open invites a lie.
   */
  async expireOverdue(limit = 500): Promise<number> {
    const result = await this.pool.query(
      `UPDATE app.invite SET status = 'expired'
       WHERE id IN (
         SELECT id FROM app.invite
         WHERE status = 'pending' AND expires_at <= now()
         ORDER BY expires_at
         LIMIT $1
       )`,
      [limit],
    );
    return result.rowCount ?? 0;
  }

  private async assertOwner(actor: Actor, roomId: RoomId): Promise<void> {
    const role = await roleIn(this.pool, actor.personId, roomId);
    if (!role || !canInvite(role)) throw new NotPermittedError();
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
