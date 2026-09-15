/**
 * The wiring the acceptance test runs against.
 *
 * `journey.test.ts` runs unmodified against two backends, picked by `HARNESS`:
 *
 *  - `memory` (the default) — `@photographic/services-memory`, the reference
 *    implementation. This is the one that proves the product's behaviour: the tiering,
 *    the permission resolution, the trash and its purge, the invite loop, the profile
 *    ceiling and the data boundary are all real code here, and the seams between
 *    packages are real.
 *  - `postgres` — `@photographic/db`'s `createPostgresServices`, behind the same
 *    `Services` shape, against the real schema in `packages/db/migrations`. This is
 *    where the SQL — row-level security, the append-only trigger, the hybrid search
 *    query — joins the same suite.
 *
 * Both drivers running the same test file is the whole reason the reference
 * implementation was worth writing: it turns "does Postgres behave correctly" into a
 * diff against something that already does.
 */

import type {
  Actor,
  AgentClient,
  ItemKind,
  Person,
  PersonId,
  Room,
  RoomId,
  Services,
  ShortId,
} from '@photographic/core';
import { BUNDLE_TOKEN_BUDGET } from '@photographic/core';
import { createPool, createPostgresServices, reset } from '@photographic/db';
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
import { createMemoryServices } from '@photographic/services-memory';
import type { Pool } from 'pg';

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
  mcpUrl: string;
  connect: ConnectSurface;

  actorFor(person: Person, agentClient?: AgentClient): Actor;
  actorForEmail(email: string, agentClient?: AgentClient): Promise<Actor>;
  /** Signing up is by mobile number, so the person a journey creates is found by one. */
  actorForPhone(phone: string, agentClient?: AgentClient): Promise<Actor>;
  registerPerson(email: string, displayName?: string): Promise<{ person: Person; personalRoom: Room }>;
  personByEmail(email: string): Promise<Person>;
  personByPhone(phone: string): Promise<Person>;
  roomByTitle(actor: Actor, title: string): Promise<Room>;

  tokenFor(email: string): Promise<string>;
  tokenForPhone(phone: string): Promise<string>;
  connectMcpClient(token: string, agentClient?: AgentClient): Promise<{ instructions: string }>;

  tokenFromUrl(url: string): string;
  /** The invite sent to one address. Invites are single-use, so which one matters. */
  inviteFor(destination: string): { url: string };
  /** Saves into a shared room the only way there is: through the approval queue. */
  saveIntoRoom(
    actor: Actor,
    input: { roomId: RoomId; body: string; kind?: ItemKind },
  ): Promise<void>;

  runJobsToCompletion(): Promise<number>;
  expireTrash(shortId: ShortId): Promise<void>;
  textExistsAnywhere(text: string): Promise<boolean>;
  commitImport(actor: Actor, preview: ImportPreview): Promise<void>;

  teardown(): Promise<void>;
}

interface ConnectSurface {
  requestCode(input: { phone: string; inviteToken?: string }): Promise<{
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

/**
 * What differs between the two drivers, isolated to three things: how the backend is
 * built, how it is torn down, and how a test reaches into it for state no port exposes
 * (a purge deadline in the past, "does this text exist anywhere at all"). Everything
 * else in this file is driver-agnostic.
 */
interface Backend {
  services: Services;
  actorFor(personId: PersonId, agentClient?: AgentClient, roomScope?: RoomId[]): Actor;
  runJobsToCompletion(): Promise<number>;
  expireTrash(shortId: ShortId): Promise<void>;
  textExistsAnywhere(text: string): Promise<boolean>;
  teardown(): Promise<void>;
}

async function createMemoryBackend(baseUrl: string): Promise<Backend> {
  const wired = createMemoryServices({ baseUrl });
  const { store } = wired;

  return {
    services: wired.services,
    actorFor: wired.actorFor,
    runJobsToCompletion: wired.runJobsToCompletion,

    expireTrash: async (shortId) => {
      for (const item of store.items.values()) {
        if (item.shortId !== shortId) continue;
        if (item.status !== 'deleted') throw new Error(`${shortId} ligger inte i papperskorgen.`);
        item.purgeAfter = new Date(Date.now() - 1000);
        return;
      }
      throw new Error(`Hittade inget minne med id ${shortId}`);
    },

    // Deliberately includes the append-only event log and the cached projections, not
    // just the item table: "deleted" that leaves the sentence sitting in an event
    // payload or a rendered profile is not deletion, and the trash promised deletion.
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

    teardown: async () => {
      // Nothing to release: the reference implementation holds no handles.
    },
  };
}

/**
 * A database of this suite's own, created on demand.
 *
 * The harness drops and re-migrates the schema on every run, which is what stops a
 * leftover row from making a test pass for the wrong reason. Doing that to the database
 * the other packages read — and the one `pnpm db:seed` fills for the morning demo — means
 * a smoke test three packages away fails with `relation "app.person" does not exist` and
 * the seeded demo data disappears without anyone touching it.
 *
 * Falls back to the URL it was given when the database cannot be created, because
 * "cannot CREATE DATABASE here" should not turn into "the suite does not run".
 */
async function isolatedDatabaseUrl(databaseUrl: string): Promise<string> {
  let url: URL;
  try {
    url = new URL(databaseUrl);
  } catch {
    return databaseUrl;
  }

  const name = url.pathname.replace(/^\//, '');
  if (!name || name.endsWith('_e2e')) return databaseUrl;

  const target = `${name}_e2e`;
  const admin = new URL(databaseUrl);
  admin.pathname = `/${name}`;

  const pool = createPool({ connectionString: admin.toString(), max: 1 });
  try {
    const exists = await pool.query('SELECT 1 FROM pg_database WHERE datname = $1', [target]);
    if (exists.rowCount === 0) {
      // Not parameterisable: CREATE DATABASE takes an identifier, not a value. The name
      // is derived from our own connection string, never from input.
      await pool.query(`CREATE DATABASE "${target}"`);
    }
  } catch {
    return databaseUrl;
  } finally {
    await pool.end();
  }

  url.pathname = `/${target}`;
  return url.toString();
}

async function createPostgresBackend(baseUrl: string, databaseUrl: string): Promise<Backend> {
  const pool: Pool = createPool({ connectionString: await isolatedDatabaseUrl(databaseUrl) });
  // Wipe and re-migrate so a leftover row from a previous run cannot make a test pass
  // for the wrong reason — or fail because an email is already taken.
  await reset(pool);
  const wired = await createPostgresServices({ pool, baseUrl });

  return {
    services: wired.services,
    actorFor: wired.actorFor,
    runJobsToCompletion: wired.runJobsToCompletion,

    expireTrash: async (shortId) => {
      const result = await pool.query(
        `UPDATE app.item SET purge_after = now() - interval '1 second'
         WHERE short_id = $1 AND status = 'deleted'`,
        [shortId],
      );
      if (result.rowCount === 0) {
        throw new Error(`Hittade inget minne i papperskorgen med id ${shortId}.`);
      }
    },

    // Same intent as the memory driver: check every place the text could still be,
    // including the append-only log, cast to text so a redacted payload (which drops
    // the `body` key entirely) does not accidentally still match.
    textExistsAnywhere: async (text) => {
      const needle = `%${text}%`;
      const row = await pool.query<{ found: boolean }>(
        `SELECT
           EXISTS (SELECT 1 FROM app.item WHERE body ILIKE $1) OR
           EXISTS (SELECT 1 FROM app.proposal WHERE body ILIKE $1) OR
           EXISTS (SELECT 1 FROM app.chunk WHERE text ILIKE $1) OR
           EXISTS (SELECT 1 FROM app.document WHERE summary ILIKE $1) OR
           EXISTS (SELECT 1 FROM app.profile WHERE rendered ILIKE $1) OR
           EXISTS (SELECT 1 FROM app.brief WHERE rendered ILIKE $1) OR
           EXISTS (SELECT 1 FROM app.event WHERE payload::text ILIKE $1)
           AS found`,
        [needle],
      );
      return row.rows[0]?.found ?? false;
    },

    teardown: () => wired.close(),
  };
}

export async function createHarness(options: HarnessOptions = {}): Promise<Harness> {
  // `databaseUrl` alone selects Postgres: the journey always passes one because its
  // comment promises a real schema, and requiring a second env var on top of that is how
  // a suite ends up green against memory while everyone thinks it ran against SQL.
  const driver =
    options.driver ??
    (process.env.HARNESS as DriverName | undefined) ??
    (options.databaseUrl || process.env.DATABASE_URL ? 'postgres' : 'memory');
  const baseUrl = 'https://photographic.me';

  const backend =
    driver === 'postgres'
      ? await createPostgresBackend(
          baseUrl,
          options.databaseUrl ??
            process.env.DATABASE_URL ??
            'postgres://photographic:photographic@127.0.0.1:5432/photographic',
        )
      : await createMemoryBackend(baseUrl);

  const { services } = backend;

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

  const personByPhone = async (phone: string): Promise<Person> => {
    const person = await services.identity.findByPhone(phone);
    if (!person) throw new Error(`Ingen person med numret ${phone}`);
    return person;
  };

  const tokenForPerson = async (person: Person): Promise<string> => {
    for (const [token, personId] of tokens) {
      if (personId === person.id) return token;
    }
    const token = `token-${person.id}`;
    tokens.set(token, person.id);
    return token;
  };

  /**
   * The last invite URL created through `services.invites.create`, tracked by
   * wrapping the method rather than reaching into either backend's storage. Neither
   * driver's real store can answer "what was the raw token" after the fact --
   * Postgres only ever holds `token_hash`, on purpose, because the raw token must only
   * ever exist in the sent link. This is that link, kept exactly as long as the test
   * that sent it needs it.
   */
  const inviteUrls = new Map<string, string>();
  const originalCreateInvite = services.invites.create.bind(services.invites);
  services.invites.create = async (actor, input) => {
    const result = await originalCreateInvite(actor, input);
    inviteUrls.set(input.destination.trim().toLowerCase(), result.url);
    return result;
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
    mcpUrl: MCP_URL,
    connect,

    actorFor: (person, agentClient = 'claude-desktop') => backend.actorFor(person.id, agentClient),

    actorForEmail: async (email, agentClient = 'claude-desktop') =>
      backend.actorFor((await personByEmail(email)).id, agentClient),

    actorForPhone: async (phone, agentClient = 'claude-desktop') =>
      backend.actorFor((await personByPhone(phone)).id, agentClient),

    registerPerson: (email, displayName) =>
      services.identity.register({ email, ...(displayName ? { displayName } : {}) }),

    personByEmail,
    personByPhone,

    roomByTitle: async (actor, title) => {
      const room = await services.rooms.resolveByName(actor, title);
      if (!room) throw new Error(`Inget rum som heter ${title}`);
      return room;
    },

    tokenFor: async (email) => tokenForPerson(await personByEmail(email)),

    tokenForPhone: async (phone) => tokenForPerson(await personByPhone(phone)),

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

    /**
     * Looked up by recipient rather than "the most recent one".
     *
     * An invite is single-use and bound to whoever redeems it, so a test that reaches for
     * whichever invite happened to be created last is a test that passes by reusing a
     * spent link — which is the thing that must no longer work.
     */
    inviteFor: (destination) => {
      const url = inviteUrls.get(destination.trim().toLowerCase());
      if (!url) throw new Error(`Ingen inbjudan skickad till ${destination}.`);
      return { url };
    },

    /**
     * Saves into a shared room, which means going through the approval queue.
     *
     * Every write to a shared room does, including one the person asked for out loud:
     * `explicit` is a flag a model sets from what it read, and a document can say
     * anything. See `requiresApproval`.
     */
    saveIntoRoom: async (actor, input) => {
      const decision = await services.ingest.remember(actor, {
        roomId: input.roomId,
        body: input.body,
        ...(input.kind ? { kind: input.kind } : {}),
        explicit: true,
      });
      if (decision.outcome !== 'needs_approval') {
        throw new Error('Ett delat rum ska aldrig skrivas utan godkännande.');
      }
      await services.ingest.resolveProposal(actor, decision.proposal.id, true);
    },

    runJobsToCompletion: backend.runJobsToCompletion,

    /**
     * Moves a deadline into the past instead of waiting thirty days for it.
     *
     * The equivalent of `UPDATE app.item SET purge_after = ...`, which is exactly what
     * the Postgres driver does. Testing retention any other way means either a suite
     * that takes a month or a purge function that trusts an argument about what time it
     * is — and the second is how a bug deletes everything.
     */
    expireTrash: backend.expireTrash,

    textExistsAnywhere: backend.textExistsAnywhere,

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

    teardown: backend.teardown,
  };
}
