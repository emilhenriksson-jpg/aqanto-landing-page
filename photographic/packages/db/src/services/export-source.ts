/**
 * Reading the log for an export, and running the job that writes the archive.
 *
 * Every read here is paged and ordered by something stable — `seq` for events, the
 * primary key order for items and documents — because an export streams and a cursor
 * over an unstable ordering silently skips or repeats rows.
 *
 * Permission is resolved the same way every other read path in this package resolves it:
 * through `app.accessible_room_ids`, inside the query. An export is the largest single
 * read a person ever makes, which makes it the worst possible place to post-filter.
 */

import type { ExportRoom, ExportSource, Page } from '@photographic/export';
import type {
  ExportDocument,
  ExportEvent,
  ExportItem,
  ExportPerson,
} from '@photographic/export';
import type { Pool } from 'pg';

import { queryOne, queryRows } from '../pool.js';

export class PgExportSource implements ExportSource {
  constructor(private readonly pool: Pool) {}

  async person(personId: string): Promise<ExportPerson> {
    const row = await queryOne<{
      id: string;
      handle: string | null;
      display_name: string | null;
      email: string | null;
    }>(
      this.pool,
      `SELECT id, handle, display_name, email FROM app.person WHERE id = $1`,
      [personId],
    );
    if (!row) throw new Error(`no person ${personId}`);
    return {
      id: row.id,
      handle: row.handle,
      displayName: row.display_name,
      email: row.email,
    };
  }

  /**
   * Rooms the person can reach right now.
   *
   * Deliberately re-read when the job runs rather than trusted from the request. An
   * export is queued and may run minutes or hours later; a room the person left in
   * between must not end up in the archive.
   */
  async rooms(personId: string): Promise<ExportRoom[]> {
    const rows = await queryRows<{
      id: string;
      slug: string;
      kind: 'personal' | 'shared';
      title: string;
      description: string | null;
      created_at: Date;
      role: string;
    }>(
      this.pool,
      `SELECT r.id, r.slug, r.kind, r.title, r.description, r.created_at, a.role
       FROM app.accessible_room_ids($1) a
       JOIN app.room r ON r.id = a.room_id
       ORDER BY r.kind, r.created_at`,
      [personId],
    );

    const members = await queryRows<{
      room_id: string;
      person_id: string;
      display_name: string | null;
      role: string;
    }>(
      this.pool,
      `SELECT m.room_id, m.person_id, p.display_name, m.role
       FROM app.membership m
       JOIN app.person p ON p.id = m.person_id
       WHERE m.room_id IN (SELECT room_id FROM app.accessible_room_ids($1))
         AND m.left_at IS NULL`,
      [personId],
    );

    return rows.map((room) => ({
      id: room.id,
      slug: room.slug,
      kind: room.kind,
      title: room.title,
      description: room.description,
      createdAt: room.created_at,
      role: room.role,
      members: members
        .filter((member) => member.room_id === room.id)
        .map((member) => ({
          personId: member.person_id,
          displayName: member.display_name,
          role: member.role,
        })),
    }));
  }

  async latestSeq(): Promise<number> {
    const row = await queryOne<{ seq: string | null }>(
      this.pool,
      `SELECT max(seq) AS seq FROM app.event`,
    );
    return Number(row?.seq ?? 0);
  }

  async events(input: {
    roomIds: string[];
    actorPersonId: string;
    actorOnlyRoomIds: string[];
    throughSeq: number;
    afterSeq: number;
    limit: number;
  }): Promise<Page<ExportEvent>> {
    const rows = await queryRows<{
      seq: string;
      id: string;
      room_id: string;
      event_type: string;
      payload: Record<string, unknown>;
      actor_person_id: string | null;
      agent_client: string | null;
      session_ref: string | null;
      approved_by: string | null;
      occurred_at: Date;
    }>(
      this.pool,
      `SELECT seq, id, room_id, event_type, payload, actor_person_id, agent_client,
              session_ref, approved_by, occurred_at
       FROM app.event
       WHERE room_id = ANY($1::uuid[])
         AND seq > $2
         AND seq <= $3
         -- A room included only as "own" contributes only this person's own events.
         AND (NOT (room_id = ANY($4::uuid[])) OR actor_person_id = $5)
       ORDER BY seq ASC
       LIMIT $6`,
      [
        input.roomIds,
        input.afterSeq,
        input.throughSeq,
        input.actorOnlyRoomIds,
        input.actorPersonId,
        input.limit,
      ],
    );

    return {
      rows: rows.map((row) => ({
        seq: Number(row.seq),
        id: row.id,
        roomId: row.room_id,
        eventType: row.event_type,
        payload: row.payload,
        actorPersonId: row.actor_person_id,
        agentClient: row.agent_client,
        sessionRef: row.session_ref,
        approvedBy: row.approved_by,
        occurredAt: row.occurred_at,
      })),
      cursor: rows.length < input.limit ? null : Number(rows.at(-1)!.seq),
    };
  }

  /**
   * Items, paged by a synthetic row number.
   *
   * `app.item` has no monotonic key to page on — the primary key is a random uuid — so
   * this orders by `created_at, id` and pages with `row_number()`. Stable because the
   * ordering is total: two items created in the same microsecond are still separated by
   * their ids.
   */
  async items(input: {
    roomIds: string[];
    actorOnlyRoomIds: string[];
    itemIds: string[];
    afterRowId: number;
    limit: number;
  }): Promise<Page<ExportItem>> {
    const rows = await queryRows<{
      row_id: string;
      id: string;
      short_id: string;
      room_id: string;
      kind: string;
      body: string;
      status: string;
      sensitivity: string;
      valid_from: Date;
      valid_to: Date | null;
      superseded_by: string | null;
      created_at: Date;
      updated_at: Date;
    }>(
      this.pool,
      `WITH ordered AS (
         SELECT i.*, row_number() OVER (ORDER BY i.created_at, i.id) AS row_id
         FROM app.item i
         WHERE i.room_id = ANY($1::uuid[])
           AND (NOT (i.room_id = ANY($2::uuid[])) OR i.id = ANY($3::uuid[]))
       )
       SELECT row_id, id, short_id, room_id, kind, body, status, sensitivity,
              valid_from, valid_to, superseded_by, created_at, updated_at
       FROM ordered
       WHERE row_id > $4
       ORDER BY row_id
       LIMIT $5`,
      [input.roomIds, input.actorOnlyRoomIds, input.itemIds, input.afterRowId, input.limit],
    );

    return {
      rows: rows.map((row) => ({
        id: row.id,
        shortId: row.short_id,
        roomId: row.room_id,
        kind: row.kind,
        body: row.body,
        status: row.status,
        sensitivity: row.sensitivity,
        validFrom: row.valid_from,
        validTo: row.valid_to,
        supersededBy: row.superseded_by,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      })),
      cursor: rows.length < input.limit ? null : Number(rows.at(-1)!.row_id),
    };
  }

  async documents(input: {
    roomIds: string[];
    actorOnlyRoomIds: string[];
    uploadedBy: string;
    afterRowId: number;
    limit: number;
  }): Promise<Page<ExportDocument>> {
    const rows = await queryRows<{
      row_id: string;
      id: string;
      room_id: string;
      filename: string;
      mime_type: string;
      byte_size: string;
      checksum: string;
      storage_key: string;
      uploaded_by: string;
      created_at: Date;
      extraction_status: string;
      text: string | null;
      summary: string | null;
    }>(
      this.pool,
      `WITH ordered AS (
         SELECT d.*, row_number() OVER (ORDER BY d.created_at, d.id) AS row_id
         FROM app.document d
         WHERE d.room_id = ANY($1::uuid[])
           -- Unlike items, documents carry their uploader, so no derivation is needed.
           AND (NOT (d.room_id = ANY($2::uuid[])) OR d.uploaded_by = $3)
       )
       SELECT row_id, id, room_id, filename, mime_type, byte_size, checksum, storage_key,
              uploaded_by, created_at, extraction_status, text, summary
       FROM ordered
       WHERE row_id > $4
       ORDER BY row_id
       LIMIT $5`,
      [input.roomIds, input.actorOnlyRoomIds, input.uploadedBy, input.afterRowId, input.limit],
    );

    return {
      rows: rows.map((row) => ({
        id: row.id,
        roomId: row.room_id,
        filename: row.filename,
        mimeType: row.mime_type,
        byteSize: Number(row.byte_size),
        checksum: row.checksum,
        storageKey: row.storage_key,
        uploadedBy: row.uploaded_by,
        createdAt: row.created_at,
        extraction: row.extraction_status,
        text: row.text,
        summary: row.summary,
      })),
      cursor: rows.length < input.limit ? null : Number(rows.at(-1)!.row_id),
    };
  }

  async people(personIds: string[]): Promise<ExportPerson[]> {
    if (personIds.length === 0) return [];

    const rows = await queryRows<{
      id: string;
      handle: string | null;
      display_name: string | null;
      email: string | null;
    }>(
      this.pool,
      `SELECT id, handle, display_name, email FROM app.person WHERE id = ANY($1::uuid[])`,
      [personIds],
    );

    return rows.map((row) => ({
      id: row.id,
      handle: row.handle,
      displayName: row.display_name,
      email: row.email,
    }));
  }
}
