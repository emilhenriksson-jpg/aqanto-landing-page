/**
 * An in-memory `ExportSource`, with real paging.
 *
 * Paging is honoured rather than stubbed out, because the streaming behaviour is the
 * point of the format and a fake that returned everything in one page would let a
 * paging bug through. `pageSize` in the tests is deliberately tiny so every cursor is
 * exercised.
 */

import { NotFoundError } from '@photographic/core';

import type {
  ExportDocument,
  ExportEvent,
  ExportItem,
  ExportPerson,
  ExportRoom,
  ExportSource,
  Page,
} from '../deps.js';

export interface SeedData {
  people: ExportPerson[];
  rooms: ExportRoom[];
  events: ExportEvent[];
  items: ExportItem[];
  documents: ExportDocument[];
}

function page<T>(rows: T[], cursorOf: (row: T) => number, after: number, limit: number): Page<T> {
  const selected = rows.filter((row) => cursorOf(row) > after).slice(0, limit);
  const last = selected.at(-1);
  // `null` only when this page did not fill, so a caller that keeps going until null
  // cannot stop one page early.
  return {
    rows: selected,
    cursor: selected.length < limit || !last ? null : cursorOf(last),
  };
}

export class MemoryExportSource implements ExportSource {
  constructor(private readonly data: SeedData) {}

  async person(personId: string): Promise<ExportPerson> {
    const found = this.data.people.find((p) => p.id === personId);
    if (!found) throw new NotFoundError(`no person ${personId}`);
    return found;
  }

  async rooms(personId: string): Promise<ExportRoom[]> {
    return this.data.rooms.filter(
      (room) =>
        room.kind === 'personal'
          ? room.members.some((m) => m.personId === personId)
          : room.members.some((m) => m.personId === personId),
    );
  }

  async latestSeq(): Promise<number> {
    return this.data.events.reduce((max, event) => Math.max(max, event.seq), 0);
  }

  async events(input: {
    roomIds: string[];
    actorPersonId: string;
    actorOnlyRoomIds: string[];
    throughSeq: number;
    afterSeq: number;
    limit: number;
  }): Promise<Page<ExportEvent>> {
    const reachable = new Set(input.roomIds);
    const ownOnly = new Set(input.actorOnlyRoomIds);

    const matching = this.data.events
      .filter((event) => reachable.has(event.roomId))
      .filter((event) => event.seq <= input.throughSeq)
      // The scope rule, mirrored: a room included only as "own" contributes only the
      // events this person is the actor of.
      .filter((event) => !ownOnly.has(event.roomId) || event.actorPersonId === input.actorPersonId)
      .sort((a, b) => a.seq - b.seq);

    return page(matching, (event) => event.seq, input.afterSeq, input.limit);
  }

  async items(input: {
    roomIds: string[];
    actorOnlyRoomIds: string[];
    itemIds: string[];
    afterRowId: number;
    limit: number;
  }): Promise<Page<ExportItem>> {
    const reachable = new Set(input.roomIds);
    const ownOnly = new Set(input.actorOnlyRoomIds);
    const allowed = new Set(input.itemIds);

    const matching = this.data.items
      .filter((item) => reachable.has(item.roomId))
      .filter((item) => !ownOnly.has(item.roomId) || allowed.has(item.id));

    const indexed = matching.map((item, index) => ({ item, row: index + 1 }));
    const paged = page(indexed, (entry) => entry.row, input.afterRowId, input.limit);
    return { rows: paged.rows.map((entry) => entry.item), cursor: paged.cursor };
  }

  async documents(input: {
    roomIds: string[];
    actorOnlyRoomIds: string[];
    uploadedBy: string;
    afterRowId: number;
    limit: number;
  }): Promise<Page<ExportDocument>> {
    const reachable = new Set(input.roomIds);
    const ownOnly = new Set(input.actorOnlyRoomIds);

    const matching = this.data.documents
      .filter((doc) => reachable.has(doc.roomId))
      // `app.document.uploaded_by` exists, so unlike items this needs no derivation.
      .filter((doc) => !ownOnly.has(doc.roomId) || doc.uploadedBy === input.uploadedBy);

    const indexed = matching.map((doc, index) => ({ doc, row: index + 1 }));
    const paged = page(indexed, (entry) => entry.row, input.afterRowId, input.limit);
    return { rows: paged.rows.map((entry) => entry.doc), cursor: paged.cursor };
  }

  async people(personIds: string[]): Promise<ExportPerson[]> {
    const wanted = new Set(personIds);
    return this.data.people.filter((person) => wanted.has(person.id));
  }
}
