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
  AskHit,
  HistoryEntry,
  Item,
  MemoryChange,
  Proposal,
  Provenance,
  RoomId,
  RoomSummary,
  SearchHit,
  TrashEntry,
  UpdateDecision,
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
      return [
        `Sparat i ${roomTitle} (${decision.item.shortId}).`,
        // When Photographic chose the room rather than the model, say so and say why —
        // the person will see this reason in their calendar, and a model that can repeat
        // it is the difference between a placement and a black box.
        ...(decision.routing ? [decision.routing.motivation] : []),
      ].join(' ');

    case 'needs_approval':
      return [
        `Inte sparat än — det här kräver personens godkännande: ${decision.proposal.reason}`,
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

/**
 * An edit now goes through the same approval gate as every other write, so it has two
 * outcomes rather than one. In a shared room it queues — which the model has to report as
 * a question asked rather than a change made.
 */
export function renderUpdate(decision: UpdateDecision): string {
  if (decision.outcome === 'updated') return renderUpdated(decision.item);

  return [
    `Inte ändrat än — det här kräver personens godkännande: ${decision.proposal.reason}.`,
    `Förslaget ligger och väntar (${decision.proposal.id}).`,
    '',
    'Säg att du har frågat, och vad du frågade om. Säg inte att det är ändrat.',
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

/**
 * "Fråga mitt minne": the same grouped-by-room shape as `renderSearch`, plus a third
 * kind of line — a calendar entry has no short id and nothing to search inside, it has
 * a date and something that happened.
 *
 * A separate function rather than teaching `renderSearch` a third `SearchHit` variant.
 * `search_memory` without a time window is the tool's overwhelmingly common call and
 * already exercised by every existing test that expects exactly that wording; this only
 * runs when the model asked a date-scoped question, which `renderSearch` never has.
 */
export function renderAsk(hits: AskHit[], input: { since?: Date; until?: Date }): string {
  if (hits.length === 0) {
    const window = dateWindow(input.since, input.until);
    return [
      `Inga träffar${window ? ` ${window}` : ''}. Det betyder att inget sparades eller hände då,`,
      'inte att frågan var fel.',
      '',
      'Sök inte igen med omformulerad fråga mer än en gång. Säg till personen att du inte',
      'hittar något från den perioden.',
    ].join('\n');
  }

  const { kept, dropped } = withinBudget(hits, (hit) => hit.text);
  const byRoom = new Map<RoomId, AskHit[]>();
  for (const hit of kept) {
    const list = byRoom.get(hit.roomId);
    if (list) list.push(hit);
    else byRoom.set(hit.roomId, [hit]);
  }

  const blocks = [...byRoom].map(([, group]) => {
    const title = group[0]!.roomTitle || 'okänt rum';
    const lines = group.map(askLine);
    return wrapRoomContent(lines.join('\n\n'), { label: title });
  });

  const tail =
    dropped > 0
      ? [
          '',
          `${dropped} fler träffar fick inte plats. Snäva in frågan, ett rum, eller en kortare`,
          'tidsperiod om personen behöver en fullständig lista.',
        ].join('\n')
      : '';

  const window = dateWindow(input.since, input.until);
  return `${kept.length} träffar${window ? ` ${window}` : ''}:\n\n${blocks.join('\n\n')}${tail}`;
}

function askLine(hit: AskHit): string {
  if (hit.kind === 'event') {
    const when = hit.occurredAt ? date(hit.occurredAt) : 'okänt datum';
    const action = hit.action ? (ACTION_TEXT[hit.action] ?? hit.action) : 'hände';
    const id = hit.shortId ? ` ${hit.shortId}` : '';
    return hit.text ? `${when} · ${action}${id}: ${hit.text}` : `${when} · ${action}${id}`;
  }

  const handle = hit.shortId ?? (hit.documentId ? 'ur ett dokument' : 'utan id');
  return `[${handle}] ${hit.text}`;
}

function dateWindow(since?: Date, until?: Date): string {
  if (!since && !until) return '';
  if (since && until) return `mellan ${date(since).slice(0, 10)} och ${date(until).slice(0, 10)}`;
  if (since) return `sedan ${date(since).slice(0, 10)}`;
  return `fram till ${date(until!).slice(0, 10)}`;
}

/**
 * "Hur har X ändrats över tid": one block per memory, one line per value it has held.
 *
 * Read forwards, oldest first — unlike every other render in this file. A chain is a
 * story and a story told backwards does not answer "how did this change": the person is
 * asking what it used to be and what it became, in that order.
 *
 * Each line carries where that value came from, because "hur vet du det?" and "hur har
 * det ändrats?" are the same question asked at two distances, and a correction with no
 * source attached is the one a person cannot check.
 *
 * Wrapped in `wrapRoomContent` for the same reason search results are: a chain in a
 * shared room is text other people wrote.
 */
export function renderChanges(chains: MemoryChange[], input: { query?: string }): string {
  if (chains.length === 0) {
    const about = input.query ? ` om "${input.query}"` : '';
    return [
      `Hittar inget${about} som har ändrats.`,
      '',
      'Det kan betyda att uppgiften aldrig har korrigerats, eller att den är borttagen —',
      'ett borttaget minne har ingen historik att visa. Sök inte igen med omformulerad',
      'fråga mer än en gång.',
    ].join('\n');
  }

  const { kept, dropped } = withinBudget(chains, (chain) =>
    chain.steps.map((step) => step.body ?? '').join(' '),
  );

  const blocks = kept.map((chain) => {
    const header =
      chain.changeCount === 0
        ? `[${chain.shortId}] ${chain.currentBody}\n  Oförändrad sedan ${date(chain.firstSavedAt).slice(0, 10)}.`
        : `[${chain.shortId}] ${chain.currentBody}\n  ${changeCountText(chain.changeCount)}:`;

    const lines = chain.changeCount === 0 ? [] : chain.steps.map(changeStepLine);

    return wrapRoomContent([header, ...lines].join('\n'), {
      label: chain.roomTitle || 'okänt rum',
    });
  });

  const tail =
    dropped > 0
      ? `\n\n${dropped} fler minnen har också ändrats. Snäva in frågan om personen vill se dem.`
      : '';

  return `${kept.length} ${kept.length === 1 ? 'minne' : 'minnen'}:\n\n${blocks.join('\n\n')}${tail}`;
}

function changeCountText(count: number): string {
  return count === 1 ? 'Ändrad en gång' : `Ändrad ${count} gånger`;
}

function changeStepLine(step: MemoryChange['steps'][number]): string {
  const when = date(step.at).slice(0, 10);
  const value = step.body ?? '(texten är permanent raderad)';
  const from = step.previousBody ? ` (ersatte "${step.previousBody}")` : '';
  const where = step.source?.label ? ` · ${step.source.label}` : '';
  const id = step.shortId ? ` · ${step.shortId}` : '';

  return `  - ${when}: ${value}${from}${where}${id}`;
}

export function renderTrash(entries: TrashEntry[]): string {
  if (entries.length === 0) {
    return 'Papperskorgen är tom. Inget är borttaget som går att få tillbaka.';
  }

  // A document is named by its filename and a memory by its text, so the budget counts
  // whichever one this entry actually has rather than assuming a body.
  const describe = (entry: TrashEntry): string =>
    entry.type === 'document' ? entry.filename : entry.body;

  const { kept, dropped } = withinBudget(entries, describe);

  const lines = kept.map((entry) => {
    const reason = entry.deleteReason ? ` — "${entry.deleteReason}"` : '';
    const by = entry.deletedByClient ? `, borttaget av ${entry.deletedByClient}` : '';
    const days =
      entry.daysRemaining <= 1
        ? 'raderas permanent inom ett dygn'
        : `${entry.daysRemaining} dagar kvar`;

    // The handle a person would use to get it back, and the word for what it is. A file and
    // a memory look different in the list on purpose: "återställ kontrakt.md" and "återställ
    // p-7k2m" are different sentences, and rendering both as an id would make the model
    // guess which.
    const handle = entry.type === 'document' ? `dokument ${entry.documentId}` : entry.shortId;

    return `[${handle}] ${entry.roomTitle}: ${describe(entry)}${reason}${by} (${days})`;
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

  return [...head, '', body, ...timeline, ...embeddingLines(provenance)].join('\n');
}

/**
 * "Did my text go to a model?", answered plainly because it is part of the same question.
 *
 * Only stated when a vector exists, and only as a fact about that memory — not as a
 * policy paragraph. A model relaying this to the person should be able to read it out as
 * a sentence.
 */
function embeddingLines(provenance: Provenance): string[] {
  const embedding = provenance.embedding;
  if (!embedding) return [];

  const when = date(embedding.at).slice(0, 10);

  return embedding.external
    ? [
        '',
        `Texten skickades ${when} till ${embedding.provider} (${embedding.model}) för att göras sökbar på betydelse.`,
        'Det är så "hitta det jag menade" fungerar. Modellen tränas inte på den.',
      ]
    : ['', `Sökindexet räknades ut lokalt (${embedding.model}). Texten har inte skickats någonstans.`];
}

export function roomTitleIndex(rooms: RoomSummary[]): Map<RoomId, string> {
  return new Map(rooms.map((room) => [room.roomId, room.title]));
}

const ACTION_TEXT: Record<HistoryEntry['action'], string> = {
  saved: 'sparade',
  updated: 'ändrade',
  superseded: 'ersatte',
  shared: 'delade',
  moved: 'flyttade',
  deleted: 'tog bort',
  restored: 'tog tillbaka',
  purged: 'raderade permanent',
  disputed: 'bestred',
  dispute_resolved: 'avgjorde tvisten om',
  proposed: 'föreslog',
  approved: 'godkände',
  rejected: 'avslog',
  document_added: 'lade till ett dokument',
  room_created: 'skapade rummet',
  member_joined: 'gick med',
  member_left: 'lämnade',
  break_glass_minted: 'nödinloggning skapad på servern',
  break_glass_used: 'nödinloggning använd för att logga in',
};

/**
 * Actions that are a statement rather than something somebody did.
 *
 * The two emergency sign-in events have no actor a person would recognise — the mint is a
 * script on the machine — so prefixing `who` would render "api nödinloggning skapad".
 * Mirrors the same distinction in `apps/web`'s history mapping; the wording is deliberately
 * identical, because a person may read the same event in both places.
 */
const STANDALONE_ACTIONS: ReadonlySet<HistoryEntry['action']> = new Set([
  'break_glass_minted',
  'break_glass_used',
]);

function historyLine(entry: HistoryEntry): string {
  const who = entry.agentClient ?? entry.actorName ?? 'okänd';
  const id = entry.shortId ? ` ${entry.shortId}` : '';
  const approved = entry.wasApproved ? ', godkänt' : '';
  const what = STANDALONE_ACTIONS.has(entry.action)
    ? ACTION_TEXT[entry.action]
    : `${who} ${ACTION_TEXT[entry.action]}`;
  const head = `${date(entry.occurredAt)} · ${what}${id}${approved}`;

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
