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

import { formatBytes } from '@photographic/documents';
import type {
  AskHit,
  Brief,
  CalendarDay,
  CalendarEntry,
  ContextBundle,
  Dispute,
  DocumentSummary,
  HistoryEntry,
  Invite,
  Item,
  MemoryChange,
  MemoryEventDetail,
  Person,
  Profile,
  Proposal,
  Room,
  RoomSummary,
  RoutingDecision,
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
    kind: summary.kind,
    role: summary.role,
    oneLine: summary.oneLine,
    // The app draws the same distinction the instructions do: a room other people write
    // in does not look like a room only you have ever opened.
    memberCount: summary.memberCount,
    unseenCount: summary.unseenCount,
  };
}

export function serialiseProposal(proposal: Proposal) {
  return {
    id: proposal.id,
    roomId: proposal.roomId,
    // What accepting it will do. A queue that renders "spara" over a request to share
    // something with four people is a queue that gets cleared without being read.
    intent: proposal.intent,
    kind: proposal.kind,
    body: proposal.body,
    // The reason is the whole point of showing a proposal rather than just asking. A
    // person deciding yes or no needs to know why it could not simply be saved.
    reason: proposal.reason,
    proposedByClient: proposal.proposedByClient,
    createdAt: proposal.createdAt.toISOString(),
  };
}

/**
 * Where Photographic decided a memory belonged, and why.
 *
 * `considered` is included on purpose: a person who disagrees with a placement should be
 * able to see that it was a ranking rather than a shrug, and a placement that cannot be
 * argued with is one nobody trusts.
 */
export function serialiseRouting(routing: RoutingDecision) {
  return {
    placement: routing.placement,
    roomId: routing.roomId,
    roomTitle: routing.roomTitle,
    motivation: routing.motivation,
    uncertainty: routing.uncertainty,
    reachesOtherPeople: routing.reachesOtherPeople,
    considered: routing.considered,
  };
}

export function serialiseDispute(dispute: Dispute) {
  return {
    roomId: dispute.roomId,
    roomTitle: dispute.roomTitle,
    reason: dispute.reason,
    raisedAt: dispute.raisedAt.toISOString(),
    // Both sides, in the order they were written, and neither marked as the default
    // winner. Whoever wrote last is not whoever is right.
    sides: dispute.sides.map((side) => ({
      shortId: side.shortId,
      body: side.body,
      authorName: side.authorName,
      writtenAt: side.writtenAt.toISOString(),
    })),
  };
}

/**
 * One memory event, as a day shows it.
 *
 * `previousBody` travels with the entry rather than being looked up, because the whole
 * point of the log is that a correction does not erase the original: 15 oktober is still
 * in the day it was written after it became 1 november.
 */
export function serialiseCalendarEntry(entry: CalendarEntry) {
  return {
    seq: entry.seq,
    kind: entry.kind,
    occurredAt: entry.occurredAt.toISOString(),
    body: entry.body,
    previousBody: entry.previousBody,
    shortId: entry.shortId,
    itemKind: entry.itemKind,
    fromRoomTitle: entry.fromRoomTitle,
    toRoomTitle: entry.toRoomTitle,
    sharedWith: entry.sharedWith?.map((who) => ({ name: who.name, role: who.role })) ?? null,
    disputes: entry.disputes,
    byOtherMember: entry.byOtherMember,
    redacted: entry.redacted,
    provenance: {
      learnedAt: entry.provenance.learnedAt.toISOString(),
      agentClient: entry.provenance.agentClient,
      actorName: entry.provenance.actorName,
      source: entry.provenance.source,
      roomId: entry.provenance.roomId,
      roomTitle: entry.provenance.roomTitle,
      roomKind: entry.provenance.roomKind,
      motivation: entry.provenance.motivation,
      explicit: entry.provenance.explicit,
      wasApproved: entry.provenance.wasApproved,
      changed: entry.provenance.changed,
    },
  };
}

export function serialiseCalendarDay(day: CalendarDay) {
  return {
    date: day.date,
    timeZone: day.timeZone,
    roomId: day.roomId,
    roomTitle: day.roomTitle,
    entries: day.entries.map(serialiseCalendarEntry),
    counts: day.counts,
    byOthersCount: day.byOthersCount,
    previousDate: day.previousDate,
    nextDate: day.nextDate,
  };
}

export function serialiseMemoryEventDetail(detail: MemoryEventDetail) {
  return {
    entry: serialiseCalendarEntry(detail.entry),
    timeline: detail.timeline.map(serialiseCalendarEntry),
    revisions: detail.revisions.map((revision) => ({
      seq: revision.seq,
      at: revision.at.toISOString(),
      body: revision.body,
      previousBody: revision.previousBody,
      agentClient: revision.agentClient,
      motivation: revision.motivation,
    })),
    source: detail.source
      ? {
          kind: detail.source.kind,
          label: detail.source.label,
          ref: detail.source.ref,
          uri: detail.source.uri,
          at: iso(detail.source.at),
          agentClient: detail.source.agentClient,
          transport: detail.source.transport,
          alsoFromHere: detail.source.alsoFromHere,
        }
      : null,
    currentBody: detail.currentBody,
    trash: detail.trash
      ? {
          purgeAfter: detail.trash.purgeAfter.toISOString(),
          daysRemaining: detail.trash.daysRemaining,
        }
      : null,
  };
}

export function serialiseProfile(profile: Profile) {
  return {
    rendered: profile.rendered,
    sections: profile.sections,
    // Always six entries, default or personal — see `compassEntriesFrom` in
    // @photographic/core. The web client's Compass screen reads this directly rather
    // than parsing it back out of `rendered`.
    compass: profile.compass,
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
    recent: bundle.recent.map(serialiseHistoryEntry),
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

/**
 * A memory's chain of values, oldest step first.
 *
 * `currentBody` is always present: a chain is only ever returned for a memory that
 * still exists, so there is no "deleted" case to represent here. `previousBody` is null
 * on the first step and `body` is null only for a step whose text has been purged.
 */
export function serialiseMemoryChange(change: MemoryChange) {
  return {
    shortId: change.shortId,
    roomId: change.roomId,
    roomTitle: change.roomTitle,
    kind: change.itemKind,
    currentBody: change.currentBody,
    changeCount: change.changeCount,
    firstSavedAt: change.firstSavedAt.toISOString(),
    lastChangedAt: change.lastChangedAt.toISOString(),
    steps: change.steps.map((step) => ({
      seq: step.seq,
      at: step.at.toISOString(),
      body: step.body,
      previousBody: step.previousBody,
      shortId: step.shortId,
      action: step.action,
      agentClient: step.agentClient,
      actorName: step.actorName,
      motivation: step.motivation,
      source: step.source,
    })),
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
    // A model handed one of two contradictory statements answers confidently and wrongly.
    // Both always come back; this is what says which ones to present as a disagreement.
    disputed: hit.disputed,
    createdAt: hit.createdAt ? hit.createdAt.toISOString() : null,
  };
}

/** "Fråga mitt minne" — one shape for a memory, a document chunk or a calendar entry. */
export function serialiseAskHit(hit: AskHit) {
  return {
    kind: hit.kind,
    roomId: hit.roomId,
    roomTitle: hit.roomTitle,
    text: hit.text,
    score: Number(hit.score.toFixed(6)),
    occurredAt: hit.occurredAt ? hit.occurredAt.toISOString() : null,
    shortId: hit.shortId,
    documentId: hit.documentId,
    seq: hit.seq,
    action: hit.action,
  };
}

/**
 * A document as a card.
 *
 * `summary` and the extracted text are not both here, and that is the point. The summary
 * is a sentence a model wrote and belongs on a card; the extraction is the source and can
 * be a megabyte, so it has its own endpoint. A list that sometimes carried one would be a
 * list that sometimes times out.
 *
 * `byteSizeLabel` is formatted here rather than in each client, so "1,5 MB" reads the
 * same wherever it appears.
 */
export function serialiseDocument(doc: DocumentSummary) {
  return {
    id: doc.id,
    roomId: doc.roomId,
    filename: doc.filename,
    mimeType: doc.mimeType,
    byteSize: doc.byteSize,
    byteSizeLabel: formatBytes(doc.byteSize),
    checksum: doc.checksum,
    uploadedBy: doc.uploadedBy,
    createdAt: doc.createdAt.toISOString(),
    extraction: doc.extraction,
    // Swedish, and shown: truncation, skipped pages and "this is a scan" are the
    // uploader's business rather than ours to hide.
    extractionError: doc.extractionError,
    warnings: doc.warnings,
    pageCount: doc.pageCount,
    chunkCount: doc.chunkCount,
    searchable: doc.chunkCount > 0,
    summary: doc.summary,
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
