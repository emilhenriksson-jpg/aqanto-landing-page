/**
 * Request schemas.
 *
 * Two rules run through all of them. Nothing in a request body may assert who the
 * caller is — identity comes from the token and only from the token. And a room id is
 * always optional: omitting it means the personal room, because the overwhelmingly
 * common call is a model saving a small fact about the person it is talking to, and
 * making it name a room for that would be friction paid on every single write.
 */

import { MIN_HONOURABLE_BUDGET_TOKENS } from '@photographic/agent';
import { ROOM_HEADLINE_TOKEN_BUDGET, isCalendarDate } from '@photographic/core';
import { z } from 'zod';

const ITEM_KINDS = [
  'identity',
  'fact',
  'preference',
  'instruction',
  'decision',
  'note',
  'never',
] as const;

export const uuid = z.string().uuid();

/**
 * `p-7k2m9c`. Short, speakable, and no 0/O or 1/l to mishear.
 *
 * Four to six characters, not exactly six. New ids are six — four gave a 42% chance that
 * a room reaching a thousand memories had lost at least one save to a collision — and the
 * ids already written are four, so both have to address. This regex was `{4}`, which is
 * why widening the generator was not the one-line change it looked like: every new id
 * would have been rejected here, so a person could not update, delete or trace the
 * memories they had just saved.
 */
export const shortId = z
  .string()
  .regex(/^[a-z]-[23456789abcdefghjkmnpqrstuvwxyz]{4,6}$/, 'måste vara ett id som p-7k2m9c');

export const memoryBody = z.string().trim().min(1).max(2000);

/**
 * A motivation is a sentence, not an essay.
 *
 * Capped short because it is read in a list of a day's events, next to seven others. A
 * paragraph here would not be shown in full, and a field that accepts text it will never
 * display is a field that lies to whoever fills it in.
 */
export const motivationText = z.string().trim().min(1).max(200).optional();

/**
 * Accepts either a room id or a room name.
 *
 * People say "lägg det i Buyersclub Ledning" and models pass that through verbatim.
 * Requiring a uuid would mean every write is preceded by a lookup, and a model that
 * has to make two calls to save one fact will sometimes make neither.
 */
export const roomRef = z
  .object({
    roomId: uuid.optional(),
    room: z.string().trim().min(1).max(120).optional(),
  })
  .refine((value) => !(value.roomId && value.room), {
    message: 'ange antingen roomId eller room, inte båda',
  });

export const rememberSchema = roomRef.and(
  z.object({
    body: memoryBody,
    kind: z.enum(ITEM_KINDS).optional(),
    sensitivity: z.enum(['normal', 'sensitive']).optional(),
    /**
     * Set only when the person asked for this in so many words.
     *
     * It bypasses the approval gate, which is why it is the caller's assertion about
     * what a human said rather than something a model may decide for itself to make a
     * write go through. The tool description says exactly that.
     */
    explicit: z.boolean().optional(),
    /**
     * Why this, and why here, in one human sentence.
     *
     * Optional because a caller that says nothing still produces a complete provenance
     * record — the client, the session and the room are already known and the motivation
     * is derived. This is how a model says something better than the default.
     */
    motivation: motivationText,
  }),
);

export const proposeSchema = roomRef.and(
  z.object({
    body: memoryBody,
    kind: z.enum(ITEM_KINDS).optional(),
    reason: z.string().trim().max(200).optional(),
    source: z.string().trim().max(60).optional(),
  }),
);

export const updateSchema = roomRef.and(
  z.object({ body: memoryBody, motivation: motivationText }),
);

/**
 * Sharing or moving a memory into another room.
 *
 * There is deliberately no `confirmed` here. It used to be an optional boolean the caller
 * supplied, and `confirmed: true` placed the memory immediately instead of queueing a
 * proposal — on a route whose only requirement is `memory.write`, which every connected
 * model holds. So a model reading a poisoned document, or anyone with a stolen token,
 * could copy private material into a shared room with nobody approving it.
 *
 * `.strict()` rather than zod's default of dropping unknown keys: a caller still sending
 * `confirmed: true` is asking for something this endpoint will not do, and answering 400
 * says so instead of quietly doing something else. An old client learns; an attacker
 * learns nothing it could not have learned by reading the 202.
 */
export const placementSchema = z
  .object({
    toRoomId: uuid,
    fromRoomId: uuid.optional(),
    motivation: motivationText,
  })
  .strict();

export const resolveDisputeSchema = z.object({
  winnerShortId: shortId,
  loserShortId: shortId,
  roomId: uuid.optional(),
  resolution: z.string().trim().max(200).optional(),
});

export const leaveRoomSchema = z.object({
  /**
   * Takes the person's own memories to the trash before the membership ends.
   *
   * Never defaulted either way: a default here would be a decision we took on someone's
   * behalf about other people's memory.
   */
  removeContributions: z.boolean().optional(),
});

export const calendarDaySchema = z.object({
  date: z.string().refine(isCalendarDate, 'måste vara ett datum som 2026-09-15'),
  tz: z.string().trim().min(1).max(60).optional(),
  room: uuid.optional(),
});

export const seqParam = z.object({
  seq: z.coerce.number().int().positive(),
});

/**
 * `q` is optional so "vad hände igår" — a date with no keyword — is a valid request.
 * At least one of `q`, `since`, `until` is required, or the search has nothing to run.
 */
export const searchSchema = z
  .object({
    q: z.string().trim().min(1).max(500).optional(),
    room: z.union([uuid, z.array(uuid)]).optional(),
    since: z.coerce.date().optional(),
    until: z.coerce.date().optional(),
    sort: z.enum(['relevance', 'oldest', 'newest']).optional(),
    /**
     * "Hur har X ändrats över tid": the supersede chain rather than ranked hits. Takes
     * `1`/`true` from a query string, since there are no booleans in a URL.
     */
    changes: z
      .union([z.literal('1'), z.literal('true'), z.literal('0'), z.literal('false')])
      .transform((value) => value === '1' || value === 'true')
      .optional(),
    limit: z.coerce.number().int().min(1).max(50).optional(),
  })
  .refine((value) => Boolean(value.q) || Boolean(value.since) || Boolean(value.until), {
    message: 'ange antingen q eller since/until',
  });

export const shortIdParam = z.object({ shortId });

export const roomIdParam = z.object({ roomId: uuid });

export const undoSchema = z.object({ undoToken: z.string().min(8).max(200) });

/**
 * A room's description is capped shorter than it looks like it should be, because it is
 * not documentation: it is the line every model reads about this room at the start of
 * every session, alongside every other room. A sentence or two is the whole of it.
 *
 * Derived from the headline budget rather than picked, because the overview clamps at
 * that length regardless — and a field that accepts text it will never show is a field
 * that lies to whoever fills it in.
 */
const ROOM_DESCRIPTION_MAX = ROOM_HEADLINE_TOKEN_BUDGET * 4;

export const createRoomSchema = z.object({
  title: z.string().trim().min(1).max(120),
  description: z.string().trim().max(ROOM_DESCRIPTION_MAX).optional(),
});

export const describeRoomSchema = z.object({
  /** Empty or absent hands the sentence back to the summariser. */
  description: z.string().trim().max(ROOM_DESCRIPTION_MAX).nullable().optional(),
});

export const inviteSchema = z.object({
  channel: z.enum(['email', 'sms']),
  destination: z.string().trim().min(3).max(320),
  role: z.enum(['owner', 'editor', 'viewer']).optional(),
});

export const resolveProposalSchema = z.object({ accept: z.boolean() });

export const trashQuerySchema = z.object({
  room: uuid.optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

export const historyQuerySchema = z.object({
  room: uuid.optional(),
  since: z.coerce.date().optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

/**
 * `budget` is refused below the floor rather than accepted and missed.
 *
 * The minimum used to be 100, which the renderer cannot honour for anybody: the
 * preamble, the Compass, the confirmation style and the data boundary are reserved and
 * never given up, and they cost roughly ten times that on their own. So
 * `?budget=500` was validated, documented, and answered with a string well over the
 * budget it named — a small lie, and the kind that is only discovered by measuring the
 * response.
 *
 * Refused rather than silently clamped, because a caller asking for a small package
 * usually has a reason (a client with a hard prompt limit), and handing them a larger one
 * while reporting success is the outcome they can least afford. The message names the
 * minimum so the next request can be right.
 *
 * `MIN_HONOURABLE_BUDGET_TOKENS` is measured from the reserved text, so this cannot
 * drift when a rule or a default Compass principle is edited.
 */
export const contextQuerySchema = z.object({
  room: uuid.optional(),
  budget: z.coerce
    .number()
    .int()
    .min(
      MIN_HONOURABLE_BUDGET_TOKENS,
      `budget måste vara minst ${MIN_HONOURABLE_BUDGET_TOKENS}: reglerna, kompassen och datagränsen kan inte tas bort och kostar så mycket`,
    )
    .max(8000)
    .optional(),
});

/**
 * An export request.
 *
 * `own` by default and `rooms` only when asked for by name, because a full transcript of
 * a shared room includes other people's writing and is a materially different act. See
 * `EXPORT.md`.
 */
export const exportRequestSchema = z.object({
  scope: z.enum(['own', 'rooms']).optional(),
  rooms: z.array(uuid).max(50).optional(),
});

/**
 * A deletion request.
 *
 * `contributions` is required and has no default. The consent copy says the choice about
 * what happens to a person's contributions in shared rooms is never preselected, and a
 * schema default would be this endpoint making it for them.
 */
export const deletionRequestSchema = z.object({
  contributions: z.enum(['keep', 'remove']),
  immediate: z.boolean().optional(),
  /** Required on the immediate path. See `IMMEDIATE_CONFIRMATION`. */
  confirm: z.string().trim().max(40).optional(),
});

/**
 * The room a multipart upload names, as text fields beside the file.
 *
 * Both optional and both accepted, matching `RoomRef`: a client that has an id sends
 * `roomId`, and a model relaying "lägg den i Buyersclub Ledning" sends `room`. Neither
 * means the personal room.
 */
export const uploadFieldsSchema = z.object({
  room: z.string().trim().min(1).max(120).optional(),
  roomId: uuid.optional(),
});

/**
 * The person's own name for a connected client.
 *
 * `null` is meaningful and distinct from omitted: it clears the rename and hands the
 * name back to the label frozen at registration. Capped because it is rendered in the
 * history feed next to every memory the client wrote.
 */
export const renameClientSchema = z.object({
  displayName: z.string().trim().min(1).max(60).nullable(),
});

/**
 * A mobile number, and only a mobile number.
 *
 * The shape is deliberately loose — `checkSwedishMobile` in `@photographic/connect` is
 * what decides whether the digits are a number we can text, and it is the same function
 * the sign-up field runs, so a second rule here would be a second answer.
 */
export const signupRequestSchema = z.object({
  phone: z.string().trim().min(6).max(24),
  inviteToken: z.string().trim().min(8).max(200).optional(),
});

export const signupVerifySchema = z.object({
  requestId: z.string().trim().min(1).max(100),
  code: z.string().trim().regex(/^\d{6}$/, 'koden är sex siffror'),
});

export const importPreviewSchema = z.object({
  text: z.string().min(1).max(100_000),
});

export const importCommitSchema = z.object({
  text: z.string().min(1).max(100_000),
});
