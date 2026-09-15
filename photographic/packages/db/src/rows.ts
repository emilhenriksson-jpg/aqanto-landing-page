/**
 * Row -> domain mapping.
 *
 * `pg` already parses `timestamptz` into `Date`, `jsonb` into a plain object and `uuid`
 * into a string, so most of what happens here is renaming `snake_case` columns into the
 * camelCase the ports promise. The one column type `pg` gets wrong for us is `bigint`
 * (`event.seq`), which comes back as a string to avoid silently losing precision above
 * 2^53 -- safe to coerce with `Number` here because a sequence that large is not a
 * number this product will ever reach.
 */

import type {
  AgentClient,
  ClientSession,
  DeliveryMethod,
  EventSeq,
  Invite,
  InviteId,
  InviteStatus,
  Item,
  ItemId,
  ItemKind,
  ItemStatus,
  MemberRole,
  MemoryEvent,
  Person,
  PersonId,
  Proposal,
  ProposalId,
  ProposalStatus,
  Room,
  RoomId,
  RoomKind,
  Sensitivity,
  SessionId,
  ShortId,
  Transport,
  TrashEntry,
} from '@photographic/core';

export interface PersonRow {
  id: string;
  handle: string | null;
  display_name: string | null;
  email: string | null;
  phone: string | null;
  locale: string;
  created_at: Date;
}

export function mapPerson(row: PersonRow): Person {
  return {
    id: row.id as PersonId,
    handle: row.handle,
    displayName: row.display_name,
    email: row.email,
    phone: row.phone,
    locale: row.locale,
    createdAt: row.created_at,
  };
}

export interface RoomRow {
  id: string;
  kind: RoomKind;
  slug: string;
  title: string;
  description: string | null;
  sensitivity: Sensitivity;
  created_by: string;
  created_at: Date;
  archived_at: Date | null;
}

export function mapRoom(row: RoomRow): Room {
  return {
    id: row.id as RoomId,
    kind: row.kind,
    slug: row.slug,
    title: row.title,
    description: row.description,
    sensitivity: row.sensitivity,
    createdBy: row.created_by as PersonId,
    createdAt: row.created_at,
    archivedAt: row.archived_at,
  };
}

export interface ItemRow {
  id: string;
  short_id: string;
  room_id: string;
  kind: ItemKind;
  body: string;
  structured: Record<string, unknown>;
  sensitivity: Sensitivity;
  status: ItemStatus;
  valid_from: Date;
  valid_to: Date | null;
  superseded_by: string | null;
  salience: number;
  token_estimate: number;
  last_used_at: Date | null;
  use_count: number;
  created_at: Date;
  deleted_at: Date | null;
  deleted_by: string | null;
  deleted_by_client: AgentClient | null;
  purge_after: Date | null;
  delete_reason: string | null;
}

export function mapItem(row: ItemRow): Item {
  return {
    id: row.id as ItemId,
    shortId: row.short_id as ShortId,
    roomId: row.room_id as RoomId,
    kind: row.kind,
    body: row.body,
    structured: row.structured ?? {},
    sensitivity: row.sensitivity,
    status: row.status,
    validFrom: row.valid_from,
    validTo: row.valid_to,
    supersededBy: row.superseded_by as ItemId | null,
    salience: Number(row.salience),
    tokenEstimate: row.token_estimate,
    lastUsedAt: row.last_used_at,
    useCount: row.use_count,
    createdAt: row.created_at,
    deletedAt: row.deleted_at,
    deletedBy: row.deleted_by as PersonId | null,
    deletedByClient: row.deleted_by_client,
    purgeAfter: row.purge_after,
    deleteReason: row.delete_reason,
  };
}

export interface TrashEntryRow extends ItemRow {
  room_title: string;
}

export function mapTrashEntry(row: TrashEntryRow, now: Date): TrashEntry {
  const item = mapItem(row);
  return {
    shortId: item.shortId,
    roomId: item.roomId,
    roomTitle: row.room_title,
    kind: item.kind,
    body: item.body,
    deletedAt: item.deletedAt!,
    deletedBy: item.deletedBy,
    deletedByClient: item.deletedByClient,
    deleteReason: item.deleteReason,
    purgeAfter: item.purgeAfter!,
    daysRemaining: Math.max(
      0,
      Math.ceil((item.purgeAfter!.getTime() - now.getTime()) / (24 * 60 * 60 * 1000)),
    ),
  };
}

export interface InviteRow {
  id: string;
  room_id: string;
  invited_by: string;
  channel: 'email' | 'sms';
  destination: string;
  role: MemberRole;
  status: InviteStatus;
  preview_allowed: boolean;
  expires_at: Date;
  accepted_by: string | null;
}

export function mapInvite(row: InviteRow): Invite {
  return {
    id: row.id as InviteId,
    roomId: row.room_id as RoomId,
    invitedBy: row.invited_by as PersonId,
    channel: row.channel,
    destination: row.destination,
    role: row.role,
    status: row.status,
    previewAllowed: row.preview_allowed,
    expiresAt: row.expires_at,
    acceptedBy: row.accepted_by as PersonId | null,
  };
}

export interface EventRow {
  seq: string | number;
  id: string;
  room_id: string;
  event_type: string;
  payload: Record<string, unknown>;
  actor_person_id: string | null;
  agent_client: AgentClient | null;
  session_ref: string | null;
  approved_by: string | null;
  occurred_at: Date;
}

export function mapEvent(row: EventRow): MemoryEvent {
  return {
    seq: Number(row.seq) as EventSeq,
    id: row.id,
    roomId: row.room_id as RoomId,
    eventType: row.event_type,
    payload: row.payload ?? {},
    actorPersonId: row.actor_person_id as PersonId | null,
    agentClient: row.agent_client,
    sessionRef: row.session_ref,
    approvedBy: row.approved_by as PersonId | null,
    occurredAt: row.occurred_at,
  };
}

export interface ProposalRow {
  id: string;
  room_id: string;
  person_id: string;
  kind: ItemKind;
  body: string;
  reason: string;
  conflicts_with: string | null;
  proposed_by_client: AgentClient | null;
  status: ProposalStatus;
  created_at: Date;
}

export function mapProposal(row: ProposalRow): Proposal {
  return {
    id: row.id as ProposalId,
    roomId: row.room_id as RoomId,
    personId: row.person_id as PersonId,
    kind: row.kind,
    body: row.body,
    reason: row.reason,
    conflictsWith: row.conflicts_with as ItemId | null,
    proposedByClient: row.proposed_by_client,
    status: row.status,
    createdAt: row.created_at,
  };
}

export interface ClientSessionRow {
  id: string;
  person_id: string;
  agent_client: AgentClient;
  transport: Transport;
  started_at: Date;
  profile_delivered: boolean;
  profile_version: number | null;
  delivery_method: DeliveryMethod | null;
}

export function mapSession(row: ClientSessionRow): ClientSession {
  return {
    id: row.id as SessionId,
    personId: row.person_id as PersonId,
    agentClient: row.agent_client,
    transport: row.transport,
    startedAt: row.started_at,
    profileDelivered: row.profile_delivered,
    profileVersion: row.profile_version,
    deliveryMethod: row.delivery_method,
  };
}
