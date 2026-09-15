/**
 * Domain objects, rendered as the text a model reads.
 *
 * Tool results are prose rather than JSON on purpose. A model given `{"outcome":"auto",
 * "item":{"shortId":"p-7k2m",…}}` has to decide what to say about it, and what it decides
 * varies by client and by mood; a model given "Sparat i ditt personliga rum (p-7k2m)" says
 * roughly that. Since the whole product is judged on whether the confirmation line is one
 * calm sentence or a paragraph about a memory system, the wording belongs here, where it
 * is written once and reviewed.
 *
 * Two rules hold everywhere in this file. Anything a person wrote goes through
 * `wrapRoomContent`, including the person's own memories, because their own notes still
 * travel through the same models. And every result names the short id, because that is
 * what makes "ta bort det" resolve to one memory instead of a guess.
 */

import { wrapRoomContent } from '@photographic/agent';
import type {
  HistoryEntry,
  Item,
  Proposal,
  Provenance,
  RoomId,
  RoomSummary,
  SearchHit,
  TrashEntry,
  WriteDecision,
} from '@photographic/core';
import { estimateTokens, TRASH_RETENTION_DAYS } from '@photographic/core';

/**
 * Ceiling on one tool result.
 *
 * Not a safety limit, a usability one: a search that returns forty long hits pushes the
 * profile out of a smaller context window, and the model then forgets the person in the
 * course of looking something up about them. Results are dropped whole and the count is
 * reported, so the model can narrow the query rather than silently work from half a list.
 */
export const RESULT_TOKEN_BUDGET = 3000;

export function renderWrite(decision: WriteDecision, roomTitle: string): string {
  switch (decision.outcome) {
    case 'auto':
      return `Sparat i ${roomTitle} (${decision.item.shortId}).`;

    case 'needs_approval':
      return [
        `Inte sparat än — det här kräver personens godkännande: ${decision.proposal.reason}.`,
        `Förslaget ligger och väntar (${decision.proposal.id}).`,
        '',
        'Berätta för personen att du har frågat, och vad du frågade om. Säg inte att det',
        'är sparat, och fråga inte igen — förslaget finns kvar tills de svarar.',
      ].join('\n');

    case 'duplicate':
      return [
        `Redan känt sedan tidigare (${decision.existing.shortId}). Inget nytt sparat.`,
        'Säg ingenting om det här till personen; det är inte värt en mening.',
      ].join('\n');
  }
}

export function renderProposal(proposal: Proposal): string {
  return [
    `Förslag skapat (${proposal.id}), väntar på godkännande: ${proposal.reason}.`,
    wrapRoomContent(proposal.body),
  ].join('\n');
}

export function renderUpdated(item: Item): string {
  return [
    `Uppdaterat (${item.shortId}). Den tidigare versionen finns kvar i historiken, så`,
    'personen kan se vad som gällde förut.',
  ].join('\n');
}

export function renderForgotten(item: Item, undoToken: string): string {
  return [
    `Borttaget (${item.shortId}). Ligger i papperskorgen i ${TRASH_RETENTION_DAYS} dagar och`,
    'används inte längre av någon modell.',
    '',
    `Ångra med restore_memory och undo_token "${undoToken}" om personen ändrar sig.`,
    'Nämn en gång, kort, att det går att få tillbaka. Upprepa det inte.',
  ].join('\n');
}

export function renderRestored(item: Item): string {
  return [
    `Tillbaka (${item.shortId}). Används igen från och med nu:`,
    wrapRoomContent(item.body),
  ].join('\n');
}

/**
 * Search results, grouped by room.
 *
 * Grouping is not cosmetic. The fence carries the room it came from, so the model can
 * attribute what it says — "enligt Buyersclub Ledning" — and a hit from a shared room is
 * visibly not a fact about the person. One flat block would make those indistinguishable.
 */
export function renderSearch(hits: SearchHit[], roomTitles: Map<RoomId, string>): string {
  if (hits.length === 0) {
    return [
      'Inga träffar. Det betyder att det inte finns sparat, inte att det är fel fråga.',
      '',
      'Sök inte igen med omformulerad fråga mer än en gång. Säg till personen att du inte',
      'hittar något om det, och fråga om de vill att du sparar det de just berättade.',
    ].join('\n');
  }

  const { kept, dropped } = withinBudget(hits, (hit) => hit.text);
  const byRoom = new Map<RoomId, SearchHit[]>();
  for (const hit of kept) {
    const list = byRoom.get(hit.roomId);
    if (list) list.push(hit);
    else byRoom.set(hit.roomId, [hit]);
  }

  const blocks = [...byRoom].map(([roomId, group]) => {
    const title = roomTitles.get(roomId) ?? 'okänt rum';
    const lines = group.map((hit) => {
      const handle = hit.shortId ?? (hit.documentId ? 'ur ett dokument' : 'utan id');
      return `[${handle}] ${hit.text}`;
    });
    return wrapRoomContent(lines.join('\n\n'), { label: title });
  });

  const tail =
    dropped > 0
      ? [
          '',
          `${dropped} fler träffar fick inte plats. Snäva in frågan eller sök i ett rum om`,
          'personen behöver en fullständig lista.',
        ].join('\n')
      : '';

  return `${kept.length} träffar:\n\n${blocks.join('\n\n')}${tail}`;
}

export function renderTrash(entries: TrashEntry[]): string {
  if (entries.length === 0) {
    return 'Papperskorgen är tom. Inget är borttaget som går att få tillbaka.';
  }

  const { kept, dropped } = withinBudget(entries, (entry) => entry.body);

  const lines = kept.map((entry) => {
    const reason = entry.deleteReason ? ` — "${entry.deleteReason}"` : '';
    const by = entry.deletedByClient ? `, borttaget av ${entry.deletedByClient}` : '';
    const days =
      entry.daysRemaining <= 1
        ? 'raderas permanent inom ett dygn'
        : `${entry.daysRemaining} dagar kvar`;

    return `[${entry.shortId}] ${entry.roomTitle}: ${entry.body}${reason}${by} (${days})`;
  });

  return [
    `${kept.length} i papperskorgen${dropped > 0 ? `, ${dropped} fler visas inte` : ''}:`,
    '',
    wrapRoomContent(lines.join('\n')),
    '',
    'Inget här påverkar någon modell. Använd det inte för att besvara frågor — det är',
    `borttaget med avsikt. Ta tillbaka med restore_memory om personen vill det.`,
  ].join('\n');
}

export function renderHistory(entries: HistoryEntry[]): string {
  if (entries.length === 0) {
    return 'Inget har hänt i minnet än.';
  }

  const { kept, dropped } = withinBudget(entries, (entry) => entry.body ?? '');
  const lines = kept.map(historyLine);

  return [
    `${kept.length} händelser, senast först${dropped > 0 ? `, ${dropped} fler finns` : ''}:`,
    '',
    wrapRoomContent(lines.join('\n')),
  ].join('\n');
}

/**
 * The answer to "how do you know that about me?".
 *
 * Worth the separate shape. The common complaint about AI memory is not that it forgets
 * but that it knows something unaccountable, and an answer a person can check — this
 * client, that day, approved or not — is the difference between a memory they trust and
 * one they tolerate.
 */
export function renderProvenance(provenance: Provenance): string {
  const approved = provenance.approvedByName
    ? `godkänt av ${provenance.approvedByName}`
    : 'sparat utan att du blev tillfrågad';

  const head = [
    `${provenance.shortId}, i ${provenance.roomTitle}.`,
    `Sparat ${date(provenance.savedAt)} av ${provenance.savedByClient ?? 'okänd klient'}, ${approved}.`,
  ];

  const body = provenance.body
    ? wrapRoomContent(provenance.body)
    : 'Texten är permanent raderad och finns inte kvar någonstans.';

  const timeline =
    provenance.timeline.length > 1
      ? ['', 'Hela förloppet:', ...provenance.timeline.map((entry) => `  ${historyLine(entry)}`)]
      : [];

  return [...head, '', body, ...timeline].join('\n');
}

export function roomTitleIndex(rooms: RoomSummary[]): Map<RoomId, string> {
  return new Map(rooms.map((room) => [room.roomId, room.title]));
}

const ACTION_TEXT: Record<HistoryEntry['action'], string> = {
  saved: 'sparade',
  updated: 'ändrade',
  superseded: 'ersatte',
  deleted: 'tog bort',
  restored: 'tog tillbaka',
  purged: 'raderade permanent',
  proposed: 'föreslog',
  approved: 'godkände',
  rejected: 'avslog',
  document_added: 'lade till ett dokument',
  room_created: 'skapade rummet',
  member_joined: 'gick med',
  member_left: 'lämnade',
};

function historyLine(entry: HistoryEntry): string {
  const who = entry.agentClient ?? entry.actorName ?? 'okänd';
  const id = entry.shortId ? ` ${entry.shortId}` : '';
  const approved = entry.wasApproved ? ', godkänt' : '';
  const head = `${date(entry.occurredAt)} · ${who} ${ACTION_TEXT[entry.action]}${id}${approved}`;

  // Not every action has a text. `room_created` and `member_joined` are the whole event,
  // and a trailing colon with nothing after it reads as a memory whose contents failed to
  // load — which is the one thing a history feed must never look like.
  if (entry.redacted) return `${head}: (texten är permanent raderad)`;

  const body = (entry.body ?? '').replace(/\s+/g, ' ').trim();
  return body ? `${head}: ${body.slice(0, 160)}` : head;
}

function date(value: Date): string {
  return value.toISOString().slice(0, 16).replace('T', ' ');
}

/**
 * Keeps whole entries until the budget runs out.
 *
 * Whole entries, never a truncated one: a half-rendered memory is something the model
 * will complete from context, and a fact it completed itself is indistinguishable from
 * one the person saved.
 */
function withinBudget<T>(entries: T[], textOf: (entry: T) => string): { kept: T[]; dropped: number } {
  const kept: T[] = [];
  let used = 0;

  for (const entry of entries) {
    const cost = estimateTokens(textOf(entry)) + 12;
    if (kept.length > 0 && used + cost > RESULT_TOKEN_BUDGET) break;
    kept.push(entry);
    used += cost;
  }

  return { kept, dropped: entries.length - kept.length };
}
