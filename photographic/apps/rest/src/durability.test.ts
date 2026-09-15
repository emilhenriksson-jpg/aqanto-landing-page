/**
 * The HTTP surface of the parts that have to survive a bad day.
 *
 * Three things, each of which was either missing or wrong at the edge rather than in the
 * service underneath — which is exactly why they are tested here as requests:
 *
 *   - The export download. It used to read the whole archive into the process and hand it
 *     to a response, and the link it answered lasted a week and could be replayed. Now the
 *     body is a stream and the link is spent by a *completed* transfer, which is a property
 *     of the route and not of the service: a client that disconnects halfway must leave the
 *     link usable.
 *   - Deleting a single document. There was no route at all, so a file uploaded to the
 *     wrong room was permanent and the person could see it.
 *   - Whether the queue is keeping up, which nothing could answer.
 */

import type { Person, PersonId } from '@photographic/core';
import { createMemoryServices, type MemoryServices } from '@photographic/services-memory';
import { beforeEach, describe, expect, it } from 'vitest';

import { createApp } from './app.js';
import { resolveConfig } from './config.js';
import { silentLogger } from './logger.js';
import { FIRST_PARTY_CLIENT_ID } from './oauth-contract.js';
import type { OAuthProvider, TokenClaims } from './oauth-contract.js';
import type { ExportService } from './routes/account.js';
import type { QueueSource } from './routes/ops.js';

const config = resolveConfig({ publicUrl: 'https://photographic.test' });

function fakeOAuth(tokens: Map<string, TokenClaims>): OAuthProvider {
  const no = async () => ({ status: 501, body: {} });
  return {
    introspect: async (token) => tokens.get(token) ?? null,
    authorize: no,
    token: no,
    register: no,
    revoke: no,
  };
}

/** An archive handed over in pieces, with a record of when it was declared delivered. */
function fakeExports(): ExportService & { completed: number; resolves: number; spent: boolean } {
  const state = {
    completed: 0,
    resolves: 0,
    spent: false,
  };

  return {
    ...state,
    get completed() {
      return state.completed;
    },
    get resolves() {
      return state.resolves;
    },
    get spent() {
      return state.spent;
    },
    request: async () => {
      throw new Error('not used');
    },
    list: async () => [],
    get: async () => null,
    createDownloadToken: async () => null,
    resolveDownload: async (token: string) => {
      if (token !== 'pgm_dl_good' || state.spent) return null;
      state.resolves += 1;

      return {
        filename: 'photographic-export-emil-2026-09-15.zip',
        byteSize: 12,
        checksum: 'a'.repeat(64),
        stream: (async function* () {
          yield new Uint8Array([0x50, 0x4b, 0x03, 0x04]);
          yield new Uint8Array([0x01, 0x02, 0x03, 0x04]);
          yield new Uint8Array([0x05, 0x06, 0x07, 0x08]);
        })(),
        complete: async () => {
          state.completed += 1;
          state.spent = true;
        },
      };
    },
  } as unknown as ExportService & { completed: number; resolves: number; spent: boolean };
}

const fakeQueue: QueueSource = {
  jobStats: async () => ({
    pending: 3,
    due: 1,
    running: 1,
    expiredLeases: 0,
    failed: 0,
    oldestPendingSeconds: 4,
    worstAttempts: 1,
  }),
  failedKinds: async () => [],
  exportStats: async () => ({
    pending: 0,
    running: 0,
    expiredLeases: 0,
    failed: 0,
    ready: 2,
    oldestPendingSeconds: 0,
  }),
};

interface Fixture {
  app: ReturnType<typeof createApp>;
  wired: MemoryServices;
  exports: ReturnType<typeof fakeExports>;
  signIn(person: Person): string;
  signInClient(personId: PersonId): string;
  /** A connected client holding exactly these scopes and no others. */
  signInScoped(personId: PersonId, scopes: string[]): string;
  request(path: string, init?: RequestInit): Promise<Response>;
}

function fixture(options: { queue?: QueueSource | null } = {}): Fixture {
  const wired = createMemoryServices({ baseUrl: 'https://photographic.test' });
  const tokens = new Map<string, TokenClaims>();
  const exports = fakeExports();
  let seq = 0;

  const app = createApp({
    services: wired.services,
    config,
    logger: silentLogger(),
    oauth: fakeOAuth(tokens),
    exports,
    queue: options.queue === undefined ? fakeQueue : options.queue,
  });

  const claim = (personId: PersonId, clientId: string): TokenClaims => ({
    personId,
    sessionId: null,
    agentClient: clientId === FIRST_PARTY_CLIENT_ID ? 'web' : 'claude-desktop',
    clientId,
    scopes: [
      'profile.read',
      'memory.read',
      'memory.write',
      'rooms.read',
    ],
    roomScope: [],
    expiresAt: null,
  });

  return {
    app,
    wired,
    exports,
    signIn: (person) => {
      const token = `first-party-${(seq += 1)}`;
      tokens.set(token, claim(person.id, FIRST_PARTY_CLIENT_ID));
      return token;
    },
    signInClient: (personId) => {
      const token = `client-${(seq += 1)}`;
      tokens.set(token, claim(personId, 'claude-desktop'));
      return token;
    },
    signInScoped: (personId, scopes) => {
      const token = `scoped-${(seq += 1)}`;
      tokens.set(token, { ...claim(personId, 'claude-desktop'), scopes });
      return token;
    },
    request: async (path, init) => app.request(`https://photographic.test${path}`, init),
  };
}

const authed = (token: string, init: RequestInit = {}): RequestInit => ({
  ...init,
  headers: { ...(init.headers ?? {}), authorization: `Bearer ${token}` },
});

let f: Fixture;

beforeEach(() => {
  f = fixture();
});

async function register(name = 'emil@example.com'): Promise<{ person: Person; token: string }> {
  const registered = await f.wired.services.identity.register({ email: name, displayName: 'Emil' });
  return { person: registered.person, token: f.signIn(registered.person) };
}

async function uploadDocument(token: string, filename = 'avtal.md'): Promise<string> {
  const body = new FormData();
  body.set('file', new File(['# Avtal\n\nUppsägningstiden är tre månader.'], filename, {
    type: 'text/markdown',
  }));

  const res = await f.request('/v1/documents', authed(token, { method: 'POST', body }));
  expect(res.status).toBe(201);
  return (await res.json() as { document: { id: string } }).document.id;
}

describe('downloading an export', () => {
  it('streams the archive rather than answering with it in one piece', async () => {
    // The route hands back a body that arrives in chunks. Assembling it here would defeat
    // the point of asserting it — so what is checked is that the stream exists and that the
    // length and digest the person can verify against are on the response.
    const res = await f.request('/v1/export/download/pgm_dl_good');

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/zip');
    expect(res.headers.get('content-length')).toBe('12');
    expect(res.headers.get('x-photographic-sha256')).toBe('a'.repeat(64));
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('content-disposition')).toContain('photographic-export-emil');
    expect(res.body).not.toBeNull();

    const bytes = new Uint8Array(await res.arrayBuffer());
    expect(bytes).toHaveLength(12);
    expect(Buffer.from(bytes.subarray(0, 2)).toString()).toBe('PK');
  });

  it('spends the link only once the bytes have actually gone out', async () => {
    const res = await f.request('/v1/export/download/pgm_dl_good');
    // Before the body is read, nothing has been delivered and the link is still good.
    expect(f.exports.completed).toBe(0);

    await res.arrayBuffer();
    expect(f.exports.completed).toBe(1);

    // And now it is spent, and answers exactly as a link that never existed.
    const again = await f.request('/v1/export/download/pgm_dl_good');
    expect(again.status).toBe(404);
    const unknown = await f.request('/v1/export/download/pgm_dl_nonsense');
    expect(unknown.status).toBe(404);
    expect(await again.json()).toEqual(await unknown.json());
  });

  it('needs no session, because the link is the authority', async () => {
    // The archive is delivered by email and the browser opening it may never have had one.
    const res = await f.request('/v1/export/download/pgm_dl_good');
    expect(res.status).not.toBe(401);
  });
});

describe('deleting a document', () => {
  it('moves it to the trash, hides it, and takes it back', async () => {
    const emil = await register();
    const documentId = await uploadDocument(emil.token);

    const deleted = await f.request(`/v1/documents/${documentId}`, authed(emil.token, {
      method: 'DELETE',
    }));
    expect(deleted.status).toBe(200);
    const deletedBody = await deleted.json() as { purgeAfter: string; notice: string };
    expect(Date.parse(deletedBody.purgeAfter)).toBeGreaterThan(Date.now());
    // Said out loud, because "I deleted it and my storage did not change" is otherwise a
    // bug report rather than the trash working.
    expect(deletedBody.notice).toContain('papperskorgen');

    expect((await f.request(`/v1/documents/${documentId}`, authed(emil.token))).status).toBe(404);

    const trash = await f.request('/v1/documents/trash', authed(emil.token));
    expect(trash.status).toBe(200);
    const trashBody = await trash.json() as { documents: Array<{ id: string; daysRemaining: number }> };
    expect(trashBody.documents.map((doc) => doc.id)).toContain(documentId);
    expect(trashBody.documents[0]?.daysRemaining).toBeGreaterThan(0);

    const restored = await f.request(`/v1/documents/${documentId}/restore`, authed(emil.token, {
      method: 'POST',
    }));
    expect(restored.status).toBe(200);
    expect((await f.request(`/v1/documents/${documentId}`, authed(emil.token))).status).toBe(200);
  });

  it('answers 404 for someone else’s document, rather than confirming it exists', async () => {
    const emil = await register();
    const documentId = await uploadDocument(emil.token);
    const jacob = await register('jacob@example.com');

    const res = await f.request(`/v1/documents/${documentId}`, authed(jacob.token, {
      method: 'DELETE',
    }));
    expect(res.status).toBe(404);

    // And it is still there for the person it belongs to.
    expect((await f.request(`/v1/documents/${documentId}`, authed(emil.token))).status).toBe(200);
  });

  it('does not show one person the other’s trash', async () => {
    const emil = await register();
    const documentId = await uploadDocument(emil.token);
    await f.request(`/v1/documents/${documentId}`, authed(emil.token, { method: 'DELETE' }));

    const jacob = await register('jacob@example.com');
    const trash = await f.request('/v1/documents/trash', authed(jacob.token));
    const body = await trash.json() as { documents: Array<{ id: string }> };
    expect(body.documents.map((doc) => doc.id)).not.toContain(documentId);
  });

  it('is a write, so a read-only connection cannot do it', async () => {
    // A document is memory, so deleting one needs the same scope as deleting a memory. A
    // connection someone granted read access to must not be able to empty a room.
    const emil = await register();
    const documentId = await uploadDocument(emil.token);
    const readOnly = f.signInScoped(emil.person.id, ['memory.read', 'profile.read']);

    const res = await f.request(`/v1/documents/${documentId}`, authed(readOnly, {
      method: 'DELETE',
    }));
    expect(res.status).toBe(403);

    // Reading it is still fine, which is what makes this about scope rather than access.
    expect((await f.request(`/v1/documents/${documentId}`, authed(readOnly))).status).toBe(200);
  });
});

describe('whether the background work is keeping up', () => {
  it('answers with depth, the oldest job and the failure count', async () => {
    const emil = await register();
    const res = await f.request('/v1/ops/queue', authed(emil.token));

    expect(res.status).toBe(200);
    const body = await res.json() as {
      queue: {
        healthy: boolean;
        jobs: { due: number; oldestPendingSeconds: number; failed: number; expiredLeases: number };
        exports: { ready: number };
      };
    };
    expect(body.queue.healthy).toBe(true);
    expect(body.queue.jobs.due).toBe(1);
    expect(body.queue.jobs.oldestPendingSeconds).toBe(4);
    expect(body.queue.exports.ready).toBe(2);
  });

  it('is not something a connected AI can ask', async () => {
    // No client has any business asking how deep our queue is, and the answer is about the
    // deployment rather than about the person.
    const registered = await f.wired.services.identity.register({ email: 'klient@example.com' });
    const clientToken = f.signInClient(registered.person.id);

    const res = await f.request('/v1/ops/queue', authed(clientToken));
    expect(res.status).toBe(403);
  });

  it('says so rather than lying when there is no database', async () => {
    const noQueue = fixture({ queue: null });
    const registered = await noQueue.wired.services.identity.register({ email: 'utan-db@example.com' });
    const token = noQueue.signIn(registered.person);

    const res = await noQueue.request('/v1/ops/queue', authed(token));
    expect(res.status).toBe(503);
  });
});
