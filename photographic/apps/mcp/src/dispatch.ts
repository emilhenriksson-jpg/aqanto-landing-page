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

import { TOOL_NAMES, wrapRoomContent, renderContributionGuidance } from '@photographic/agent';
import type { Actor, RoomId, Services, ShortId } from '@photographic/core';
import {
  askMemory,
  contributionMeta,
  containsSecret,
  proposalReviewKey,
  COMPASS_KEY_FIELD,
  COMPASS_PRINCIPLES,
  compassPrincipleLabel,
  isCompassPrincipleKey,
  memoryChanges,
  PhotographicError,
  resolveRoomRef,
  trashHandleOf,
  ValidationError,
} from '@photographic/core';
import { z } from 'zod';

import type { McpLog } from './deps.js';
import { SILENT_LOG } from './deps.js';
import {
  renderAsk,
  renderChanges,
  renderForgotten,
  renderHistory,
  renderProposal,
  renderProvenance,
  renderRestored,
  renderSearch,
  renderTrash,
  renderUpdate,
  renderWrite,
  roomTitleIndex,
} from './render.js';

const COMPASS_PRINCIPLE_KEYS = COMPASS_PRINCIPLES.map((p) => p.key) as [string, ...string[]];

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
  create_room: z.object({ title: z.string().trim().min(1).max(200), description: z.string().trim().max(2000).optional() }).strict(),
  review_proposals: z.object({
    action: z.enum(['list', 'approve', 'reject', 'resume']),
    offset: z.number().int().min(0).max(100000).default(0),
    confirmation: z.string().trim().min(1).max(500).optional(),
    decisions: z.array(z.object({ id: z.string().uuid(), review_key: z.string().regex(/^[a-f0-9]{64}$/), reviewed: z.boolean() }).strict()).min(1).max(100).optional(),
  }).strict().refine(input => !['approve', 'reject'].includes(input.action) || Boolean(input.confirmation && input.decisions), 'Ett svar kräver confirmation och decisions.'),
  prepare_context: z.object({
    action: z.enum(['prepare', 'pause']),
    batch_id: z.string().uuid().optional(),
    candidates: z.array(z.object({
      text: z.string().trim().min(1).max(1900),
      kind: z.enum(['fact', 'preference', 'instruction', 'decision', 'note', 'never']),
      origin: z.enum(['conversation', 'client_memory', 'file', 'mail', 'slack', 'photographic']),
      sourceLabel: z.string().trim().min(1).max(200),
      evidence: z.enum(['reported', 'inferred']), sensitive: z.boolean(), concernsOthers: z.boolean(),
      observedAt: z.string().datetime({ offset: true }).optional(),
      roomTitle: z.string().trim().min(1).max(200).optional(),
      roomDescription: z.string().trim().max(2000).optional(),
    }).strict()).min(1).max(20).optional(),
  }).strict().refine(input => input.action === 'pause' || (input.batch_id && input.candidates), 'prepare kräver batch_id och candidates.'),

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

  update_compass: z
    .object({
      principle: z.enum(COMPASS_PRINCIPLE_KEYS),
      text: z.string().trim().min(1).max(220),
    })
    .strict(),

  search_memory: z
    .object({
      query: z.string().trim().min(1).max(1000).optional(),
      room,
      since: z.coerce.date().optional(),
      until: z.coerce.date().optional(),
      sort: z.enum(['relevance', 'oldest', 'newest']).optional(),
      changes: z.boolean().optional(),
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

      const contribution = await services.ingest.contributionState(actor);
      return services.bundle.render(bundle) + '\n\n' + renderContributionGuidance(bundle, contribution);

    }

    case 'create_room': {
      const input = args as ArgsOf<'create_room'>;
      if (containsSecret([input.title, input.description].join(' '))) throw new ValidationError('Hemligheter ska inte sparas i rumsnamn eller beskrivningar.');
      const created = await services.rooms.create(actor, { ...input, reusePrivate: true });
      return 'Rummet finns nu och är privat. Ingen har bjudits in. Använd detta id när du sparar där.\n'
        + wrapRoomContent(JSON.stringify({ id: created.id, title: created.title }), { label: 'privat rum', notice: true });
    }

    case 'review_proposals': {
      const input = args as ArgsOf<'review_proposals'>;
      if (input.action === 'resume') {
        await services.ingest.pauseContributions(actor, false);
        return 'Erbjudanden återupptagna på personens begäran. Läs get_context innan ett nytt förslag.';
      }
      if (input.action === 'list') {
        const rooms = await services.rooms.listForPerson(actor);
        const own = new Set(rooms.filter(r => r.role === 'owner' && r.memberCount === 1).map(r => r.roomId));
        const proposals = (await services.ingest.listProposals(actor)).filter(p => own.has(p.roomId)
          && (!actor.roomScope.length || actor.roomScope.includes(p.roomId)) && ['remember', 'update'].includes(p.intent));
        const previews = await Promise.all(proposals.slice(input.offset, input.offset + 20).map(async p => ({ id: p.id, review_key: await proposalReviewKey(p),
          text: p.body, reason: p.reason, room: contributionMeta(p)?.roomTitle ?? rooms.find(r => r.roomId === p.roomId)?.title,
          reviewRequired: contributionMeta(p)?.reviewRequired ?? true })));
        return 'Visa förslaget i chatten och invänta personens svar. Ett underlag är inte ett sparat minne.\n'
          + wrapRoomContent(JSON.stringify({ total: proposals.length, next_offset: input.offset + 20 < proposals.length ? input.offset + 20 : null, proposals: previews }), { label: 'privata förslag', notice: true });
      }
      const results = [];
      for (const decision of input.decisions!) {
        try {
          const item = await services.ingest.resolveProposal(actor, decision.id as import('@photographic/core').ProposalId,
            input.action === 'approve', { reviewed: decision.reviewed, privateOnly: true,
              reviewKey: decision.review_key, confirmation: input.confirmation! });
          results.push({ id: decision.id, status: input.action === 'approve' ? (item ? 'saved' : 'already_handled') : 'dismissed',
            ...(item ? { shortId: item.shortId, roomId: item.roomId } : {}) });
        } catch (error) {
          results.push({ id: decision.id, status: 'not_applied', message: error instanceof PhotographicError ? error.message : 'Kunde inte slutföras. Läs aktuellt underlag innan du försöker igen.' });
        }
      }
      return 'Bekräfta bara sparade resultat. Vid not_applied: förklara kort och läs det aktuella förslaget; anta inte att resten lyckades.\n' + JSON.stringify(results);
    }

    case 'prepare_context': {
      const input = args as ArgsOf<'prepare_context'>;
      if (input.action === 'pause') {
        await services.ingest.pauseContributions(actor, true);
        return 'Erbjudanden pausade. Fortsätt samtalet. När personen ber att återuppta: review_proposals action resume.';
      }
      const result = await services.ingest.prepareContributions(actor, { batchId: input.batch_id!, candidates: input.candidates! });
      if (result.paused) return 'Erbjudanden är pausade. För inte över kontext och fråga inte igen.';
      return `Privat granskningsunderlag, inte sparade minnen. Visa ett samlat förslag i chatten, inklusive rum. På personens godkännande: review_proposals. Webbsidan https://photographic.space/godkann är ett frivilligt alternativ. Om alla uppgifter var kända eller redan erbjudna, avbryt utan ny fråga.\n` +
        wrapRoomContent(JSON.stringify({ batchId: result.batchId, proposed: await Promise.all(result.proposals.map(async p => ({ id: p.id, review_key: await proposalReviewKey(p), text: p.body, reason: p.reason, reviewRequired: contributionMeta(p)?.reviewRequired ?? true }))), skipped: result.skipped }), { label: 'granskningsunderlag', notice: true });
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

    case 'update_compass': {
      const input = args as ArgsOf<'update_compass'>;
      // Not resolved via `resolveRoomRef`: the Compass lives in the personal room only,
      // and letting a model name a different room here would be a request to write
      // Compass-kind memory somewhere `remember` already refuses to put it.
      const personalRoom = await services.identity.personalRoomOf(actor.personId);

      if (!isCompassPrincipleKey(input.principle)) {
        // Unreachable while the zod enum and `COMPASS_PRINCIPLES` agree, kept as a
        // typed narrowing rather than an `as` cast.
        throw new ValidationError('Okänd kompassprincip.');
      }

      const proposal = await services.ingest.propose(actor, {
        roomId: personalRoom.id,
        body: input.text,
        kind: 'compass',
        reason: `föreslagen ändring av principen "${compassPrincipleLabel(input.principle)}" i den personliga kompassen`,
        structured: { [COMPASS_KEY_FIELD]: input.principle },
      });

      return renderProposal(proposal);
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

      // "Hur har X ändrats över tid" is a different question from "what is true now",
      // and it cannot be answered by ranking current text: a correction writes a new
      // memory and supersedes the old one, so the previous wording is on a row search
      // deliberately excludes. See `memoryChanges`.
      if (input.changes) {
        const chains = await memoryChanges(services, actor, {
          ...(input.query ? { query: input.query } : {}),
          ...(roomIds ? { roomIds } : {}),
          ...(input.since ? { since: input.since } : {}),
          ...(input.until ? { until: input.until } : {}),
          ...(input.limit ? { limit: input.limit } : {}),
        });

        return renderChanges(chains, {
          ...(input.query ? { query: input.query } : {}),
        });
      }

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

      // The trash holds documents too now, and they are named by uuid rather than by a short
      // id. `trashHandleOf` reads whichever the caller gave — the two shapes cannot collide —
      // so a model restoring what it just listed does not have to know the difference.
      const handle = input.id ? trashHandleOf(input.id) : null;
      if (!handle) throw new ValidationError('Det där ser inte ut som ett id i papperskorgen.');

      const restored = await services.trash.restore(actor, handle, roomId);
      if (restored.type === 'document') {
        return `${restored.document.filename} är tillbaka i rummet.`;
      }
      return renderRestored(restored.item);
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