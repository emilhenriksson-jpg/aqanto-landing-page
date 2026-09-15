/**
 * The access log.
 *
 * Separate from the event log, and the distinction matters. The event log is what
 * happened to someone's memory and is shown to them as history. This is who looked, and
 * it exists for the question "did anything read my personal room that should not have".
 *
 * Reads are not shown in the history feed. A feed that logged every retrieval would be
 * unreadable, and the two questions have different audiences anyway.
 */

import type { Actor, AuditPort, ItemId, RoomId } from '@photographic/core';

export interface AuditRecord {
  personId: string;
  agentClient: string;
  roomId: RoomId | null;
  action: 'read' | 'search' | 'write' | 'delete' | 'bundle';
  itemIds: ItemId[];
  detail: Record<string, unknown>;
  at: Date;
}

export class MemoryAudit implements AuditPort {
  readonly records: AuditRecord[] = [];

  constructor(private readonly now: () => Date = () => new Date()) {}

  async record(input: {
    actor: Actor;
    roomId?: RoomId;
    action: 'read' | 'search' | 'write' | 'delete' | 'bundle';
    itemIds?: ItemId[];
    detail?: Record<string, unknown>;
  }): Promise<void> {
    this.records.push({
      personId: input.actor.personId,
      agentClient: input.actor.agentClient,
      roomId: input.roomId ?? null,
      action: input.action,
      itemIds: input.itemIds ?? [],
      detail: input.detail ?? {},
      at: this.now(),
    });
  }

  forPerson(personId: string): AuditRecord[] {
    return this.records.filter((r) => r.personId === personId);
  }
}
