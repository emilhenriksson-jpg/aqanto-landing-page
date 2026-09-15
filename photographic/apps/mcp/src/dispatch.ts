/**
 * Tool calls, dispatched.
 *
 * Deliberately free of the MCP SDK: in, a tool name and an argument object; out, the text
 * the model will read. That means the interesting half of this server — what each tool
 * does, what it refuses, what it says about it — is testable without a transport, a
 * client handshake or a port, and it is the same dispatch the REST routes drive.
 *
 * Arguments are validated here rather than trusted. The JSON Schema in
 * `@photographic/agent` is a description addressed to the model and has no runtime
 * force: a client that sends `{"id": 42}` gets a type error deep inside a service unless
 * something checks first, and "unknown error" is a terrible thing for a model to have to
 * explain to a person.
 */

import { TOOL_NAMES } from '@photographic/agent';
import type { Actor, RoomId, Services, ShortId } from '@photographic/core';
import { askMemory, PhotographicError, resolveRoomRef } from '@photographic/core';
import { z } from 'zod';

import type { McpLog } from './deps.js';
import { SILENT_LOG } from './deps.js';
import {
  renderAsk,
  renderForgotten,
  renderHistory,
  renderProvenance,
  renderRestored,
  renderSearch,
  renderTrash,
  renderUpdate,
  renderWrite,
  roomTitleIndex,
} from './render.js';

export interface DispatchResult {
  text: string;
  /**
   * True for anything the model should treat as a failed call. Errors come back as tool
   * results rather than protocol errors so the model can say what went wrong and carry
   * on; a JSON-RPC error ends the turn in several clients.
   */
  isError: boolean;
}

const room = z.string().trim().min(1).max(200).optional();
const shortId = z
  .string()
  .trim()
  .regex(/^[a-z]-[a-z0-9]{2,12}$/i, 'Ett id ser ut som "p-7k2m" och kommer från ett tidigare svar.');

/**
 * Runtime guards, one per tool.
 *
 * `strict()` everywhere: an unrecognised argument is a model that has misunderstood the
 * tool, and silently ignoring it means the call does something other than what the model
 * intended without anything saying so. Better to hand back the mistake.
 */
const ARGS = {
  get_context: z.object({ room }).strict(),

  remember: z
    .object({
      text: z.string().trim().min(1).max(2000),
      kind: z
        .enum(['fact', 'preference', 'instruction', 'decision', 'note', 'never'])
        .optional(),
      room,
      explicit: z.boolean().optional(),
      sensitive: z.boolean().optional(),
    })
    .strict(),

  search_memory: z
    .object({
      query: z.string().trim().min(1).max(1000).optional(),
      room,
      since: z.coerce.date().optional(),
      until: z.coerce.date().optional(),
      sort: z.enum(['relevance', 'oldest', 'newest']).optional(),
      limit: z.number().int().min(1).max(50).optional(),
    })
    .strict()
    .refine((value) => Boolean(value.query) || Boolean(value.since) || Boolean(value.until), {
      message: 'Ange antingen en fråga eller since/until att söka inom.',
    }),

  update_memory: z
    .object({ id: shortId, text: z.string().trim().min(1).max(2000), room })
    .strict(),

  forget_memory: z
    .object({ id: shortId, room, reason: z.string().trim().max(200).optional() })
    .strict(),

  restore_memory: z
    .object({ undo_token: z.string().trim().min(1).optional(), id: shortId.optional(), room })
    .strict()
    .refine((value) => value.undo_token !== undefined || value.id !== undefined, {
      message: 'Ange undo_token från en nyss gjord borttagning, eller id från list_trash.',
    }),

  list_trash: z.object({ room, limit: z.number().int().min(1).max(100).optional() }).strict(),

  list_history: z
    .object({ id: shortId.optional(), room, limit: z.number().int().min(1).max(100).optional() })
    .strict(),
} satisfies Record<string, z.ZodTypeAny>;

export type ToolName = keyof typeof ARGS;

/** Guarded at build time by a test: the guards and the descriptions describe one surface. */
export const GUARDED_TOOL_NAMES = Object.keys(ARGS) as ToolName[];

export interface DispatchDeps {
  services: Services;
  log?: McpLog;
}

export async function dispatchTool(
  deps: DispatchDeps,
  actor: Actor,
  name: string,
  rawArgs: unknown,
): Promise<DispatchResult> {
  const log = deps.log ?? SILENT_LOG;

  if (!isToolName(name)) {
    return {
      text: `Det finns inget verktyg som heter "${name}". Tillgängliga: ${TOOL_NAMES.join(', ')}.`,
      isError: true,
    };
  }

  const parsed = ARGS[name].safeParse(rawArgs ?? {});
  if (!parsed.success) {
    return { text: argumentError(parsed.error), isError: true };
  }

  try {
    const text = await run(deps.services, actor, name, parsed.data as never);
    log.info('tool_call', { tool: name, personId: actor.personId });
    return { text, isError: false };
  } catch (error) {
    // Domain errors are the model's to explain: a not-found room, a memory already in the
    // trash. Anything else is ours, and its message never reaches the model — a driver
    // error string in a tool result is internal detail sitting in a context window that
    // may be logged by someone else's client.
    if (error instanceof PhotographicError) {
      log.info('tool_refused', { tool: name, code: error.code });
      return { text: error.message, isError: true };
    }

    log.error('tool_failed', {
      tool: name,
      error: error instanceof Error ? error.message : String(error),
    });
    return { text: 'Något gick fel i Photographic. Försök igen.', isError: true };
  }
}

type ArgsOf<N extends ToolName> = z.infer<(typeof ARGS)[N]>;

async function run<N extends ToolName>(
  services: Services,
  actor: Actor,
  name: N,
  args: ArgsOf<N>,
): Promise<string> {
  switch (name) {
    case 'get_context': {
      const { room: roomRef } = args as ArgsOf<'get_context'>;
      const activeRoomId = roomRef
        ? await resolveRoomRef(services, actor, { room: roomRef })
        : undefined;

      const bundle = await services.bundle.build(actor, {
        ...(activeRoomId ? { activeRoomId } : {}),
      });

      // Recorded as a delivery, which is what turns the client health screen from a guess
      // into an observation. `tool_call` rather than `mcp_instructions`: the model had to
      // ask, so this client is amber, not green, and saying otherwise would be the
      // dishonest kind of green light.
      if (actor.sessionId) {
        await services.sessions.recordDelivery(actor.sessionId, 'tool_call', bundle.profile.version);
      }
      await services.audit.record({ actor, action: 'bundle' });

      return services.bundle.render(bundle);
    }

    case 'remember': {
      const input = args as ArgsOf<'remember'>;

      // A model that names no room is not asking for the personal room, it is declining
      // to decide — so Photographic decides, and tells it where the memory went.
      const roomId = input.room
        ? await resolveRoomRef(services, actor, { room: input.room })
        : undefined;

      const decision = await services.ingest.remember(actor, {
        ...(roomId ? { roomId } : {}),
        body: input.text,
        ...(input.kind ? { kind: input.kind } : {}),
        ...(input.sensitive ? { sensitivity: 'sensitive' as const } : {}),
        ...(input.explicit === undefined ? {} : { explicit: input.explicit }),
      });

      const landedIn =
        decision.outcome === 'auto'
          ? decision.item.roomId
          : decision.outcome === 'duplicate'
            ? decision.existing.roomId
            : decision.proposal.roomId;

      return renderWrite(decision, await titleOf(services, actor, landedIn));
    }

    case 'search_memory': {
      const input = args as ArgsOf<'search_memory'>;
      const roomIds = input.room
        ? [await resolveRoomRef(services, actor, { room: input.room })]
        : undefined;

      await services.audit.record({
        actor,
        action: 'search',
        detail: { query: input.query ?? null, since: input.since, until: input.until },
      });

      // A date-scoped or "when did this start" question needs the calendar as well as
      // the current state of a memory — see `askMemory`. Everything else keeps the
      // exact path search_memory has always taken, unchanged.
      if (input.since || input.until || input.sort === 'oldest') {
        const hits = await askMemory(services, actor, {
          ...(input.query ? { query: input.query } : {}),
          ...(roomIds ? { roomIds } : {}),
          ...(input.since ? { since: input.since } : {}),
          ...(input.until ? { until: input.until } : {}),
          ...(input.sort ? { sort: input.sort } : {}),
          ...(input.limit ? { limit: input.limit } : {}),
        });

        return renderAsk(hits, {
          ...(input.since ? { since: input.since } : {}),
          ...(input.until ? { until: input.until } : {}),
        });
      }

      const hits = await services.retrieval.search(actor, {
        query: input.query!,
        ...(roomIds ? { roomIds } : {}),
        ...(input.limit ? { limit: input.limit } : {}),
      });

      return renderSearch(hits, roomTitleIndex(await services.rooms.listForPerson(actor)));
    }

    case 'update_memory': {
      const input = args as ArgsOf<'update_memory'>;
      const roomId = await resolveRoomRef(services, actor, { room: input.room });
      const decision = await services.ingest.update(actor, input.id as ShortId, roomId, input.text);
      return renderUpdate(decision);
    }

    case 'forget_memory': {
      const input = args as ArgsOf<'forget_memory'>;
      const roomId = await resolveRoomRef(services, actor, { room: input.room });
      const { item, undoToken } = await services.ingest.forget(
        actor,
        input.id as ShortId,
        roomId,
        input.reason,
      );
      return renderForgotten(item, undoToken);
    }

    case 'restore_memory': {
      const input = args as ArgsOf<'restore_memory'>;

      // Undo token first when both are given: it names exactly what was removed, with no
      // ambiguity about which id, and it is the path taken when the person says "nej
      // vänta" one turn after the delete.
      if (input.undo_token) {
        return renderRestored(await services.ingest.undo(actor, input.undo_token));
      }

      const roomId = input.room
        ? await resolveRoomRef(services, actor, { room: input.room })
        : undefined;

      const item = await services.trash.restore(actor, input.id as ShortId, roomId);
      return renderRestored(item);
    }

    case 'list_trash': {
      const input = args as ArgsOf<'list_trash'>;
      const roomId = input.room
        ? await resolveRoomRef(services, actor, { room: input.room })
        : undefined;

      const entries = await services.trash.list(actor, {
        ...(roomId ? { roomId } : {}),
        ...(input.limit ? { limit: input.limit } : {}),
      });

      return renderTrash(entries);
    }

    case 'list_history': {
      const input = args as ArgsOf<'list_history'>;
      const roomId = input.room
        ? await resolveRoomRef(services, actor, { room: input.room })
        : undefined;

      if (input.id) {
        const provenance = await services.history.provenance(actor, input.id as ShortId, roomId);
        if (!provenance) {
          return `Det finns inget minne med id ${input.id}. Ids kommer från tidigare svar — gissa inte.`;
        }
        return renderProvenance(provenance);
      }

      const entries = await services.history.list(actor, {
        ...(roomId ? { roomId } : {}),
        ...(input.limit ? { limit: input.limit } : {}),
      });

      return renderHistory(entries);
    }
  }

  // Unreachable: `isToolName` narrowed `name` to the keys of `ARGS`, and every key has a
  // case above. Present so adding a tool without a case is a compile error.
  throw new Error(`unhandled tool: ${String(name)}`);
}

async function titleOf(services: Services, actor: Actor, roomId: RoomId): Promise<string> {
  const personal = await services.identity.personalRoomOf(actor.personId);
  if (personal.id === roomId) return 'ditt personliga rum';

  const room = await services.rooms.get(actor, roomId);
  return room?.title ?? 'rummet';
}

function isToolName(name: string): name is ToolName {
  return Object.prototype.hasOwnProperty.call(ARGS, name);
}

/**
 * A validation failure, written for the model that has to recover from it.
 *
 * Zod's own message is addressed to a developer reading a stack trace. What helps here is
 * the field, what was wrong, and — crucially — that the fix is not to retry the same call
 * with different phrasing.
 */
function argumentError(error: z.ZodError): string {
  const issues = error.issues.map((issue) => {
    const path = issue.path.join('.') || '(argument)';
    return `- ${path}: ${issue.message}`;
  });

  return [
    'Anropet gick inte igenom:',
    ...issues,
    '',
    'Rätta argumenten och försök en gång. Upprepa inte samma anrop.',
  ].join('\n');
}