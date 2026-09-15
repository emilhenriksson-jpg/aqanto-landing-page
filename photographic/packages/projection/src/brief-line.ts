/**
 * The Swedish line a brief renders for one event.
 *
 * One implementation, used by both drivers. There were two — identical down to the
 * wording — in `packages/db/src/services/projection.ts` and
 * `packages/services-memory/src/projection.ts`, and they had the same defect in the same
 * place: `String(payload['filename'] ?? 'ett dokument')` renders `[object Object]` for any
 * payload whose `filename` is not a string, so a person who uploaded a document could read
 * "Emil laddade upp [object Object]" in their own brief. Two copies of a sentence is how
 * one bug becomes two, which is the argument for this file existing rather than a third
 * copy of the fix.
 *
 * The event log is append-only and replayable, so the reader has to hold for payloads it
 * did not write: an old event, an import, or a future writer with a different shape. Every
 * field is therefore checked rather than coerced, and an unreadable one falls back to
 * language that is true either way.
 */

/** Who the sentence is about, already resolved to a name by the caller. */
export const UNKNOWN_ACTOR = 'Någon';

export function briefEventLine(
  eventType: string,
  payload: Record<string, unknown>,
  actorName: string | null,
): string | null {
  const who = actorName?.trim() || UNKNOWN_ACTOR;
  const body = asText(payload['body']);

  switch (eventType) {
    case 'item.created':
      return body ? `- ${who} sparade: ${body}` : null;
    case 'item.updated':
      return body ? `- ${who} ändrade: ${body}` : null;
    case 'item.deleted':
      return `- ${who} tog bort ett minne`;
    case 'document.uploaded':
      return `- ${who} laddade upp ${asText(payload['filename']) ?? 'ett dokument'}`;
    case 'member.joined':
      return `- ${who} gick med i rummet`;
    default:
      return null;
  }
}

/** A string, or nothing. Never a coercion — that is where `[object Object]` came from. */
function asText(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}
