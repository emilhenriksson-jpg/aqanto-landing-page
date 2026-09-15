/**
 * The boundary, re-exported.
 *
 * The implementation lives in `@photographic/agent` because the same fence has to appear
 * in the session instructions, in tool results, and in the REST responses, and because
 * `DATA_BOUNDARY` — the sentence that tells the model what the fence means — is written
 * next to it. An earlier version of this file defined a second, stronger-looking fence of
 * its own. That was worse than having none: the model was told in instruction position to
 * distrust `<room-content>`, then handed tool results wrapped in markers it had never
 * been told anything about, and had no reason to treat them as anything but system text.
 *
 * Kept as a file rather than deleted so the import path in this app still reads as what
 * it is at the call sites.
 */

export {
  neutralise,
  occursOnlyInsideRoomContent,
  ROOM_CONTENT_CLOSE,
  ROOM_CONTENT_NOTICE,
  ROOM_CONTENT_OPEN,
  roomContentSpans,
  wrapRoomContent,
} from '@photographic/agent';
