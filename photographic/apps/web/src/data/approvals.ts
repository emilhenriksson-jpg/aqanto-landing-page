/**
 * How a pending decision is described, in one place.
 *
 * The rail badge, the notice on the screens a person already visits, and the card on
 * `Godkänn` all say the same thing about the same proposal, because they are three
 * sightings of one event and reading three different descriptions of it is how a person
 * concludes the app is guessing.
 *
 * Everything here is deliberately literal. "Claude vill spara" over a request to put
 * something in front of three colleagues is not a simplification, it is a false
 * statement, and a queue that makes false statements gets cleared without being read.
 */

import type { ApprovalItem } from './demo.js';

/** "Anna", "Anna och Jacob", "Anna, Jacob och Sara". */
export function swedishList(names: string[]): string {
  if (names.length === 0) return '';
  if (names.length === 1) return names[0]!;
  return `${names.slice(0, -1).join(', ')} och ${names[names.length - 1]}`;
}

/** What accepting will do, naming the room whenever the answer depends on it. */
export function approvalLead(item: ApprovalItem): string {
  const room = item.roomTitle;

  if (item.intent === 'share') {
    return room ? `${item.clientLabel} vill dela i ${room}:` : `${item.clientLabel} vill dela:`;
  }
  if (item.intent === 'update') {
    return `${item.clientLabel} vill ändra:`;
  }
  // A write into a shared room is a sharing decision whatever the intent field calls it:
  // the consequence is other people reading it, and that is what the lead has to say.
  if (item.roomKind === 'shared' && room) {
    return `${item.clientLabel} vill spara i ${room}:`;
  }
  return `${item.clientLabel} vill spara:`;
}

/**
 * Who would be able to read it. Null when the answer is "only you", which needs no line.
 *
 * Everyone in the room is named, the person included, because the app cannot tell which
 * name is theirs and a list quietly missing one member would be worse than a longer one.
 * Where the members have no names — nothing in sign-up asks for one — it falls back to
 * how many they are, which is less useful and still true.
 */
export function approvalAudience(item: ApprovalItem): string | null {
  if (item.roomKind !== 'shared') return null;
  if (item.audience.length > 0) return `Kan läsas av ${swedishList(item.audience)}.`;

  const room = item.roomTitle ?? 'rummet';
  if (item.audienceCount > 1) {
    return `Kan läsas av alla ${item.audienceCount} i ${room}.`;
  }
  return `Kan läsas av alla i ${room}.`;
}

/** "3 beslut väntar på dig" — the heading of the notice and nothing else. */
export function waitingHeading(count: number): string {
  return count === 1 ? 'Ett beslut väntar på dig' : `${count} beslut väntar på dig`;
}

/**
 * The consequence, said plainly.
 *
 * This is the sentence the product was missing. A person whose AI "forgot" what they
 * told it concludes the product does not work; the truth is that it is waiting for them,
 * and nothing anywhere said so.
 */
export function waitingConsequence(count: number): string {
  return count === 1
    ? 'Tills du svarar är det inte sparat, och ingen modell kan läsa det.'
    : 'Tills du svarar är de inte sparade, och ingen modell kan läsa dem.';
}

/** "och 2 till" under the one example the notice shows. Null when there is no rest. */
export function remainingLabel(count: number): string | null {
  const rest = count - 1;
  if (rest <= 0) return null;
  return rest === 1 ? 'Och ett till.' : `Och ${rest} till.`;
}
