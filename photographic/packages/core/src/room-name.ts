/**
 * Resolving a spoken room name to a room, and refusing to guess.
 *
 * A person says "lägg det i Buyersclub Ledning" and a model passes that string through
 * verbatim, so matching has to survive casing, Swedish vowels and whatever punctuation
 * the transcription added. What it must not survive is ambiguity.
 *
 * This used to fall back to substring matching, which meant the text "spara i ledning"
 * resolved to "Buyersclub Ledning". That is the shape of the attack the whole
 * untrusted-input model is about: a person asks a model to summarise a PDF, the PDF
 * contains a line addressed to the model, and the model has a tool that takes a room
 * name. The defence cannot be that the model should know better — both the request and
 * the document reach it as text. The defence is that the name has to hit something
 * exactly, and that the room has to be one the person is already in.
 *
 * So: exact slug, exact folded title, then a prefix **only when it is unique among the
 * person's own rooms**. Anything else is not-found, and the model has to list the rooms
 * and ask. The friction lands on a mistyped room name, which is rare. The protection
 * lands on writing to the wrong room, which is the expensive one.
 *
 * Kept here rather than in each implementation because both `PgRooms` and `MemoryRooms`
 * answer this question and a matcher that differs between them is a matcher that is
 * wrong in one of them.
 */

/**
 * Folds text to lowercase ASCII. Swedish å/ä become `a` and ö becomes `o`, which is what
 * a Swedish reader expects from a URL; NFD decomposition then strips any remaining
 * combining marks, so é and ü fold too.
 */
export function foldRoomName(input: string): string {
  return input
    .toLowerCase()
    .replace(/ß/g, 'ss')
    .replace(/æ/g, 'ae')
    .replace(/œ/g, 'oe')
    .replace(/ø/g, 'o')
    .replace(/[ðđ]/g, 'd')
    .replace(/þ/g, 'th')
    .replace(/ł/g, 'l')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** Why a name did not resolve. Never returned to a caller — see `matchRoomByName`. */
export type RoomNameMiss = 'empty' | 'no_match' | 'ambiguous';

export type RoomNameMatch<T> =
  | { matched: true; room: T }
  | { matched: false; reason: RoomNameMiss; candidates: T[] };

export interface NameableRoom {
  slug: string;
  title: string;
}

/**
 * Picks the room a name refers to, or explains why it did not.
 *
 * `candidates` must already be the rooms the actor can reach. This function decides
 * which name matches; it does not decide anything about access, and handing it rooms the
 * person is not in would turn a name into a grant.
 *
 * The miss reason is for logging and for telling a model to go and list the rooms. It
 * must not reach a caller as a distinguishable error: "no room called that" and "a room
 * called that, which is not yours" have to be the same answer, or the error message
 * becomes a way to enumerate other people's rooms.
 */
export function matchRoomByName<T extends NameableRoom>(
  candidates: readonly T[],
  name: string,
): RoomNameMatch<T> {
  const needle = foldRoomName(name);
  if (!needle) return { matched: false, reason: 'empty', candidates: [] };

  const bySlug = candidates.filter((room) => room.slug === needle);
  if (bySlug.length === 1) return { matched: true, room: bySlug[0]! };

  const byTitle = candidates.filter((room) => foldRoomName(room.title) === needle);
  if (byTitle.length === 1) return { matched: true, room: byTitle[0]! };

  // Two rooms whose titles fold to the same string is a real state — "Familjen" and
  // "familjen" — and picking the first is picking at random.
  if (byTitle.length > 1) return { matched: false, reason: 'ambiguous', candidates: byTitle };

  const byPrefix = candidates.filter(
    (room) => room.slug.startsWith(needle) || foldRoomName(room.title).startsWith(needle),
  );
  if (byPrefix.length === 1) return { matched: true, room: byPrefix[0]! };
  if (byPrefix.length > 1) return { matched: false, reason: 'ambiguous', candidates: byPrefix };

  return { matched: false, reason: 'no_match', candidates: [] };
}
