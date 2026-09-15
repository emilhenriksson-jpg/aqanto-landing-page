/**
 * Request schemas.
 *
 * Two rules run through all of them. Nothing in a request body may assert who the
 * caller is — identity comes from the token and only from the token. And a room id is
 * always optional: omitting it means the personal room, because the overwhelmingly
 * common call is a model saving a small fact about the person it is talking to, and
 * making it name a room for that would be friction paid on every single write.
 */

import { ROOM_HEADLINE_TOKEN_BUDGET } from '@photographic/core';
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

/** `p-7k2m`. Short, speakable, and no 0/O or 1/l to mishear. */
export const shortId = z
  .string()
  .regex(/^[a-z]-[23456789abcdefghjkmnpqrstuvwxyz]{4}$/, 'måste vara ett id som p-7k2m');

export const memoryBody = z.string().trim().min(1).max(2000);

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

export const updateSchema = roomRef.and(z.object({ body: memoryBody }));

export const searchSchema = z.object({
  q: z.string().trim().min(1).max(500),
  room: z.union([uuid, z.array(uuid)]).optional(),
  limit: z.coerce.number().int().min(1).max(50).optional(),
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

export const contextQuerySchema = z.object({
  room: uuid.optional(),
  budget: z.coerce.number().int().min(100).max(8000).optional(),
});

export const signupRequestSchema = z
  .object({
    email: z.string().trim().email().optional(),
    phone: z.string().trim().min(6).max(20).optional(),
    inviteToken: z.string().trim().min(8).max(200).optional(),
  })
  .refine((value) => Boolean(value.email) !== Boolean(value.phone), {
    message: 'ange antingen e-post eller telefonnummer',
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
