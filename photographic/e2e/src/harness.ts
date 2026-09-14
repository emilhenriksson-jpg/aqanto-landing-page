/**
 * The wiring the acceptance test runs against.
 *
 * `journey.test.ts` was written before anything implemented the ports, and it reports
 * skipped rather than passed until this module exists. It now exists, backed by
 * `@photographic/services-memory` — the reference implementation of every port.
 *
 * Being precise about what that does and does not prove, because a green acceptance
 * suite is exactly the kind of thing that gets read as more than it is:
 *
 *  - It does prove the product's behaviour end to end. The tiering, the permission
 *    resolution, the trash and its purge, the invite loop, the profile ceiling and the
 *    data boundary are all real code here, and the seams between packages are real.
 *  - It does not prove the SQL. Row-level security, the append-only trigger and the
 *    hybrid search query are separately verified against a local Postgres, and the
 *    `postgres` driver below is where they join this suite once `@photographic/db`
 *    implements the ports.
 *
 * Both drivers run the same test file on purpose. That is the whole reason the
 * reference implementation was worth writing: it turns "does Postgres behave correctly"
 * into a diff against something that already does.
 */

import type {
  Actor,
  AgentClient,
  Person,
  PersonId,
  Room,
  RoomId,
  Services,
  ShortId,
} from '@photographic/core';
import { BUNDLE_TOKEN_BUDGET } from '@photographic/core';
import {
  MemoryCodeSender,
  MemoryCodeStore,
  MemorySessionIssuer,
} from '@photographic/connect/testing';
import {
  buildClients,
  pollVerification,
  previewImport,
  requestCode,
  startVerification,
  type ConnectDeps,
  type ImportPreview,
  type ClientId,
  type VerificationHandle,
} from '@photographic/connect';
import { verifyCode } from '@photographic/connect';
import { createMemoryServices, type MemoryStore } from '@photographic/services-memory';

export const MCP_URL = 'https://photographic.me/mcp';
export const CONNECT_PAGE_URL = 'https://photographic.me/connect';

export type DriverName = 'memory' | 'postgres';

export interface HarnessOptions {
  databaseUrl?: string;
  /** `HARNESS=postgres` runs the same suite against the real schema. */
  driver?: DriverName;
}

export interface Harness {
  services: Services;
  store: MemoryStore;
  mcpUrl: string;
  connect: ConnectSurface;

  actorFor(person: Person, agentClient?: AgentClient): Actor;
  actorForEmail(email: string, agentClient?: AgentClient): Promise<Actor>;
  registerPerson(email: string, displayName?: string): Promise<{ person: Person; personalRoom: Room }>;
  personByEmail(email: string): Promise<Person>;
  roomByTitle(actor: Actor, title: string): Promise<Room>;

  tokenFor(email: string): Promise<string>;
  connectMcpClient(token: string, agentClient?: AgentClient): Promise<{ instructions: string }>;

  tokenFromUrl(url: string): string;
  lastInvite(): { url: string };

  runJobsToCompletion(): Promise<number>;
  expireTrash(shortId: ShortId): Promise<void>;
  textExistsAnywhere(text: string): Promise<boolean>;
  commitImport(actor: Actor, preview: ImportPreview): Promise<void>;

  teardown(): Promise<void>;
}

interface ConnectSurface {
  requestCode(input: { email?: string; phone?: string; inviteToken?: string }): Promise<{
    requestId: string;
    destinationHint: string;
  }>;
  verifyCode(input: { requestId: string; code: string }): Promise<{
    person: Person;
    personalRoom: Room;
    created: boolean;
    joinedRoom: Room | null;
    next: 'connect';
  }>;
  lastCode(): string;
  connectPayload(): Promise<{ mcpUrl: string; clients: unknown[] }>;
  startVerification(actor: Actor, clientId: ClientId): Promise<VerificationHandle>;
  pollVerification(actor: Actor, handle: VerificationHandle): Promise<unknown>;
  previewImport(text: string): ImportPreview;
}

export async function createHarness(options: HarnessOptions = {}): Promise<Harness> {
  const driver = options.driver ?? (process.env.HARNESS as DriverName | undefined) ?? 'memory';

  if (driver === 'postgres') {
    // Deliberately a hard failure rather than a silent fall back to memory. Being told
    // the Postgres suite is unavailable is useful; being told it passed when it ran
    // against something else is not.
    throw new Error(
      'HARNESS=postgres kräver att @photographic/db implementerar portarna. Kör utan HARNESS för referensimplementationen.',
    );
  }

  const wired = createMemoryServices({ baseUrl: 'https://photographic.me' });
  const { services, store } = wired;

  const clients = buildClients({ mcpUrl: MCP_URL, connectPageUrl: CONNECT_PAGE_URL });
  const clientById = (id: ClientId) => {
    const found = clients.find((c) => c.id === id);
    if (!found) throw new Error(`Okänd klient: ${id}`);
    return found;
  };

  // Sign-up needs a code store and a sender; everything else it touches is the real
  // service, so the flow under test is the real flow rather than a rehearsal of it.
  const codes = new MemoryCodeStore();
  const sender = new MemoryCodeSender();
  const issuer = new MemorySessionIssuer();
  let codeSeq = 0;
  let idSeq = 0;

  const deps: ConnectDeps = {
    identity: services.identity,
    invites: services.invites,
    sessions: services.sessions,
    codes,
    sender,
    issuer,
    codeSecret: 'e2e-secret',
    clock: () => new Date(),
    randomCode: () => String(100000 + (codeSeq += 1)),
    randomId: () => `req-${(idSeq += 1)}`,
  };

  /** Stands in for the OAuth access token an MCP client would present. */
  const tokens = new Map<string, PersonId>();

  const personByEmail = async (email: string): Promise<Person> => {
    const person = await services.identity.findByEmail(email);
    if (!person) throw new Error(`Ingen person med adressen ${email}`);
    return person;
  };

  const connect: ConnectSurface = {
    requestCode: async (input) => {
      const result = await requestCode(deps, input);
      return { requestId: result.requestId, destinationHint: result.destinationHint };
    },

    verifyCode: async (input) => {
      const result = await verifyCode(deps, input);
      tokens.set(result.session.token, result.person.id);

      return {
        person: result.person,
        personalRoom: result.personalRoom,
        created: result.created,
        joinedRoom: result.joinedRoom?.room ?? null,
        // Creating an account and connecting an AI are one flow. A person who signs up
        // and lands on an empty dashboard has been given a database, not a product.
        next: 'connect',
      };
    },

    lastCode: () => {
      const code = sender.lastCode;
      if (!code) throw new Error('Ingen kod har skickats.');
      return code;
    },

    connectPayload: async () => ({ mcpUrl: MCP_URL, clients }),

    startVerification: (actor, clientId) =>
      startVerification({ sessions: services.sessions, clock: () => new Date() }, actor, clientById(clientId)),

    pollVerification: (actor, handle) =>
      pollVerification(
        { sessions: services.sessions, clock: () => new Date() },
        actor,
        handle,
        clientById(handle.clientId),
      ),

    previewImport,
  };

  return {
    services,
    store,
    mcpUrl: MCP_URL,
    connect,

    actorFor: (person, agentClient = 'claude-desktop') =>
      wired.actorFor(person.id, agentClient),

    actorForEmail: async (email, agentClient = 'claude-desktop') =>
      wired.actorFor((await personByEmail(email)).id, agentClient),

    registerPerson: (email, displayName) =>
      services.identity.register({ email, ...(displayName ? { displayName } : {}) }),

    personByEmail,

    roomByTitle: async (actor, title) => {
      const room = await services.rooms.resolveByName(actor, title);
      if (!room) throw new Error(`Inget rum som heter ${title}`);
      return room;
    },

    tokenFor: async (email) => {
      const person = await personByEmail(email);
      for (const [token, personId] of tokens) {
        if (personId === person.id) return token;
      }
      const token = `token-${person.id}`;
      tokens.set(token, person.id);
      return token;
    },

    /**
     * An MCP handshake, as far as this suite is concerned.
     *
     * The three steps that matter are all here: resolve the person from the token,
     * build the bundle, and record that the profile was delivered and by which route.
     * The last one is what the health screen and the connect verification both read,
     * and it is the only evidence that the connection did anything.
     */
    connectMcpClient: async (token, agentClient = 'claude-desktop') => {
      const personId = tokens.get(token);
      if (!personId) throw new Error('Ogiltig token.');

      const session = await services.sessions.start({ personId, agentClient, transport: 'mcp' });
      const actor: Actor = { personId, agentClient, sessionId: session.id, roomScope: [] };

      const bundle = await services.bundle.build(actor, { budgetTokens: BUNDLE_TOKEN_BUDGET });
      const instructions = services.bundle.render(bundle);

      await services.sessions.recordDelivery(
        session.id,
        'mcp_instructions',
        bundle.profile.version,
      );

      return { instructions };
    },

    tokenFromUrl: (url) => {
      const token = url.split('/').filter(Boolean).at(-1);
      if (!token) throw new Error(`Ingen token i ${url}`);
      return token;
    },

    lastInvite: () => {
      const row = [...store.invites.values()].at(-1);
      if (!row) throw new Error('Ingen inbjudan har skapats.');
      return { url: row.url };
    },

    runJobsToCompletion: wired.runJobsToCompletion,

    /**
     * Moves a deadline into the past instead of waiting thirty days for it.
     *
     * The equivalent of an `UPDATE app.item SET purge_after = ...`, which is what the
     * Postgres driver will do. Testing retention any other way means either a suite
     * that takes a month or a purge function that trusts an argument about what time it
     * is — and the second is how a bug deletes everything.
     */
    expireTrash: async (shortId) => {
      for (const item of store.items.values()) {
        if (item.shortId !== shortId) continue;
        if (item.status !== 'deleted') throw new Error(`${shortId} ligger inte i papperskorgen.`);
        item.purgeAfter = new Date(Date.now() - 1000);
        return;
      }
      throw new Error(`Hittade inget minne med id ${shortId}`);
    },

    /**
     * Looks for the text everywhere it could possibly still be.
     *
     * Deliberately includes the append-only event log and the cached projections, not
     * just the item table. "Deleted" that leaves the sentence sitting in an event
     * payload or a rendered profile is not deletion, and the trash promised deletion.
     */
    textExistsAnywhere: async (text) => {
      const needle = text.toLowerCase();
      const hit = (value: string | null | undefined) =>
        typeof value === 'string' && value.toLowerCase().includes(needle);

      for (const item of store.items.values()) if (hit(item.body)) return true;
      for (const proposal of store.proposals.values()) if (hit(proposal.body)) return true;
      for (const chunk of store.chunks.values()) if (hit(chunk.text)) return true;
      for (const doc of store.documents.values()) if (hit(doc.text) || hit(doc.summary)) return true;
      for (const profile of store.profiles.values()) if (hit(profile.rendered)) return true;
      for (const brief of store.briefs.values()) if (hit(brief.rendered)) return true;
      for (const event of store.allEvents()) {
        if (hit(JSON.stringify(event.payload))) return true;
      }

      return false;
    },

    commitImport: async (actor, preview) => {
      const room = await services.identity.personalRoomOf(actor.personId);
      for (const candidate of preview.candidates) {
        await services.ingest.propose(actor, {
          roomId: room.id,
          body: candidate.text,
          kind: candidate.kind,
          source: preview.source,
        });
      }
    },

    teardown: async () => {
      // Nothing to release: the reference implementation holds no handles. The Postgres
      // driver closes its pool here.
    },
  };
}
