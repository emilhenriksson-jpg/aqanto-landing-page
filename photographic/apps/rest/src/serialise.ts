/**
 * Domain objects to JSON.
 *
 * Explicit functions rather than returning domain objects directly, for two reasons.
 * Dates have to become ISO strings somewhere, and doing it implicitly means the wire
 * format changes whenever someone adds a field to a type. And more importantly, several
 * domain objects carry things a client has no business seeing — an `Item` knows its
 * internal uuid and who deleted it — so the mapping is the place that decides what
 * leaves the process.
 *
 * Short ids, not uuids, wherever a client might have to say the thing back to us. That
 * is what makes "ta bort p-7k2m" work in a voice session.
 */

import type {
  Brief,
  ContextBundle,
  HistoryEntry,
  Invite,
  Item,
  Person,
  Profile,
  Proposal,
  Room,
  RoomSummary,
  SearchHit,
  TrashEntry,
} from '@photographic/core';

const iso = (date: Date | null): string | null => (date ? date.toISOString() : null);

export function serialiseItem(item: Item) {
  return {
    shortId: item.shortId,
    roomId: item.roomId,
    kind: item.kind,
    body: item.body,
    sensitivity: item.sensitivity,
    status: item.status,
    salience: item.salience,
    createdAt: item.createdAt.toISOString(),
    deletedAt: iso(item.deletedAt),
    purgeAfter: iso(item.purgeAfter),
  };
}

export function serialiseRoom(room: Room) {
  return {
    id: room.id,
    kind: room.kind,
    slug: room.slug,
    title: room.title,
    description: room.description,
    createdAt: room.createdAt.toISOString(),
    archivedAt: iso(room.archivedAt),
  };
}

export function serialiseRoomSummary(summary: RoomSummary) {
  return {
    roomId: summary.roomId,
    slug: summary.slug,
    title: summary.title,
    role: summary.role,
    oneLine: summary.oneLine,
    unseenCount: summary.unseenCount,
  };
}

export function serialiseProposal(proposal: Proposal) {
  return {
    id: proposal.id,
    roomId: proposal.roomId,
    kind: proposal.kind,
    body: proposal.body,
    // The reason is the whole point of showing a proposal rather than just asking. A
    // person deciding yes or no needs to know why it could not simply be saved.
    reason: proposal.reason,
    proposedByClient: proposal.proposedByClient,
    createdAt: proposal.createdAt.toISOString(),
  };
}

export function serialiseProfile(profile: Profile) {
  return {
    rendered: profile.rendered,
    sections: profile.sections,
    tokenCount: profile.tokenCount,
    itemCount: profile.itemCount,
    version: profile.version,
    builtAt: profile.builtAt.toISOString(),
  };
}

export function serialiseBrief(brief: Brief) {
  return {
    roomId: brief.roomId,
    rendered: brief.rendered,
    tokenCount: brief.tokenCount,
    stale: brief.stale,
    builtAt: brief.builtAt.toISOString(),
  };
}

export function serialiseBundle(bundle: ContextBundle, rendered: string) {
  return {
    profile: serialiseProfile(bundle.profile),
    rooms: bundle.rooms.map(serialiseRoomSummary),
    activeRoom: bundle.activeRoom,
    // The string the model is meant to receive, pre-rendered. A client that assembles
    // its own from the sections will drift from the one the MCP server sends, and then
    // the product behaves differently depending on which door you came in through.
    rendered,
    tokenCount: bundle.tokenCount,
    bundleVersion: bundle.bundleVersion,
    builtAt: bundle.builtAt.toISOString(),
  };
}

export function serialiseSearchHit(hit: SearchHit) {
  return {
    kind: hit.kind,
    shortId: hit.shortId,
    roomId: hit.roomId,
    text: hit.text,
    score: Number(hit.score.toFixed(6)),
    documentId: hit.documentId,
  };
}

export function serialiseTrashEntry(entry: TrashEntry) {
  return {
    shortId: entry.shortId,
    roomId: entry.roomId,
    roomTitle: entry.roomTitle,
    kind: entry.kind,
    body: entry.body,
    deletedAt: entry.deletedAt.toISOString(),
    deletedByClient: entry.deletedByClient,
    deleteReason: entry.deleteReason,
    purgeAfter: entry.purgeAfter.toISOString(),
    daysRemaining: entry.daysRemaining,
  };
}

export function serialiseHistoryEntry(entry: HistoryEntry) {
  return {
    seq: entry.seq,
    action: entry.action,
    occurredAt: entry.occurredAt.toISOString(),
    roomId: entry.roomId,
    roomTitle: entry.roomTitle,
    shortId: entry.shortId,
    body: entry.body,
    agentClient: entry.agentClient,
    actorName: entry.actorName,
    wasApproved: entry.wasApproved,
    redacted: entry.redacted,
  };
}

export function serialisePerson(person: Person) {
  return {
    id: person.id,
    displayName: person.displayName,
    locale: person.locale,
    createdAt: person.createdAt.toISOString(),
  };
}

/** The invite, minus the token: that only ever travels in the URL we generated. */
export function serialiseInvite(invite: Invite) {
  return {
    id: invite.id,
    roomId: invite.roomId,
    channel: invite.channel,
    role: invite.role,
    status: invite.status,
    expiresAt: invite.expiresAt.toISOString(),
  };
}
