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
  MemorySource,
  Person,
  PersonId,
  Proposal,
  ProposalId,
  ProposalIntent,
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
  author_person_id: string;
  author_client_id: string | null;
  disputed_by: string[] | null;
  deleted_at: Date | null;
  deleted_by: string | null;
  deleted_by_client: AgentClient | null;
  purge_after: Date | null;
  delete_reason: string | null;
}

/**
 * Every column a caller needs to build an `Item`, named once.
 *
 * Inline column lists in nine query strings is how a new column ends up present in three
 * of them: the row maps fine, the object is missing a field, and the type error lands in
 * whichever file was touched last.
 */
export const ITEM_COLUMNS = `id, short_id, room_id, kind, body, structured, sensitivity, status,
  valid_from, valid_to, superseded_by, salience, token_estimate, last_used_at, use_count,
  created_at, author_person_id, author_client_id, disputed_by, deleted_at, deleted_by,
  deleted_by_client, purge_after, delete_reason`;

/** The same list, qualified, for queries that join the room in. */
export const ITEM_COLUMNS_PREFIXED = `i.id, i.short_id, i.room_id, i.kind, i.body, i.structured,
  i.sensitivity, i.status, i.valid_from, i.valid_to, i.superseded_by, i.salience,
  i.token_estimate, i.last_used_at, i.use_count, i.created_at, i.author_person_id,
  i.author_client_id, i.disputed_by, i.deleted_at, i.deleted_by, i.deleted_by_client,
  i.purge_after, i.delete_reason`;

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
    authorPersonId: row.author_person_id as PersonId,
    authorClientId: row.author_client_id,
    disputedBy: (row.disputed_by ?? []) as ItemId[],
    deletedAt: row.deleted_at,
    deletedBy: row.deleted_by as PersonId | null,
    deletedByClient: row.deleted_by_client,
    purgeAfter: row.purge_after,
    deleteReason: row.delete_reason,
  };
}

/**
 * One row of `app.trash`, which is a view over the log rather than a table.
 *
 * Who deleted it, from which client and why come from the deleting *event*, where
 * nothing can overwrite them. The text and the deadline come from the item, because the
 * item is the memory's current value and the deadline is a decision taken at the moment
 * of deletion rather than something derivable.
 */
export interface TrashEntryRow {
  short_id: string;
  room_id: string;
  room_title: string;
  kind: ItemKind;
  body: string;
  deleted_at: Date;
  deleted_by: string | null;
  deleted_by_client: AgentClient | null;
  delete_reason: string | null;
  purge_after: Date;
}

export function mapTrashEntry(row: TrashEntryRow, now: Date): TrashEntry {
  return {
    shortId: row.short_id as ShortId,
    roomId: row.room_id as RoomId,
    roomTitle: row.room_title,
    kind: row.kind,
    body: row.body,
    deletedAt: row.deleted_at,
    deletedBy: row.deleted_by as PersonId | null,
    deletedByClient: row.deleted_by_client,
    deleteReason: row.delete_reason,
    purgeAfter: row.purge_after,
    daysRemaining: Math.max(
      0,
      Math.ceil((row.purge_after.getTime() - now.getTime()) / (24 * 60 * 60 * 1000)),
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
  client_id: string | null;
  session_ref: string | null;
  approved_by: string | null;
  occurred_at: Date;
  motivation: string | null;
  explicit: boolean;
  source_kind: MemorySource['kind'] | null;
  source_label: string | null;
  source_ref: string | null;
  source_uri: string | null;
  from_room_id: string | null;
  to_room_id: string | null;
}

/** Named once, for the same reason as `ITEM_COLUMNS`. */
export const EVENT_COLUMNS = `seq, id, room_id, event_type, payload, actor_person_id, agent_client,
  client_id, session_ref, approved_by, occurred_at, motivation, explicit, source_kind,
  source_label, source_ref, source_uri, from_room_id, to_room_id`;

export const EVENT_COLUMNS_PREFIXED = `e.seq, e.id, e.room_id, e.event_type, e.payload,
  e.actor_person_id, e.agent_client, e.client_id, e.session_ref, e.approved_by, e.occurred_at,
  e.motivation, e.explicit, e.source_kind, e.source_label, e.source_ref, e.source_uri,
  e.from_room_id, e.to_room_id`;

export function mapEvent(row: EventRow): MemoryEvent {
  return {
    seq: Number(row.seq) as EventSeq,
    id: row.id,
    roomId: row.room_id as RoomId,
    eventType: row.event_type,
    payload: row.payload ?? {},
    actorPersonId: row.actor_person_id as PersonId | null,
    agentClient: row.agent_client,
    clientId: row.client_id,
    sessionRef: row.session_ref,
    approvedBy: row.approved_by as PersonId | null,
    occurredAt: row.occurred_at,
    motivation: row.motivation,
    explicit: row.explicit ?? false,
    source: mapSource(row),
    fromRoomId: row.from_room_id as RoomId | null,
    toRoomId: row.to_room_id as RoomId | null,
  };
}

/**
 * Four columns to one object, and null when there is nothing to say.
 *
 * Not defaulted to `unknown`: an event written before the log carried provenance has no
 * source, and saying so lets the caller derive one from the client and the session rather
 * than rendering a confident "okänd källa" over information we could have worked out.
 */
export function mapSource(row: Pick<EventRow, 'source_kind' | 'source_label' | 'source_ref' | 'source_uri'>): MemorySource | null {
  if (!row.source_kind) return null;
  return {
    kind: row.source_kind,
    label: row.source_label ?? '',
    ref: row.source_ref,
    uri: row.source_uri,
  };
}

export interface ProposalRow {
  id: string;
  room_id: string;
  person_id: string;
  intent: ProposalIntent;
  kind: ItemKind;
  body: string;
  reason: string;
  motivation: string | null;
  conflicts_with: string | null;
  source_item: string | null;
  proposed_by_client: AgentClient | null;
  status: ProposalStatus;
  created_at: Date;
}

export const PROPOSAL_COLUMNS = `id, room_id, person_id, intent, kind, body, reason, motivation,
  conflicts_with, source_item, proposed_by_client, status, created_at`;

export function mapProposal(row: ProposalRow): Proposal {
  return {
    id: row.id as ProposalId,
    roomId: row.room_id as RoomId,
    personId: row.person_id as PersonId,
    intent: row.intent ?? 'remember',
    kind: row.kind,
    body: row.body,
    reason: row.reason,
    motivation: row.motivation,
    conflictsWith: row.conflicts_with as ItemId | null,
    sourceItemId: row.source_item as ItemId | null,
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
