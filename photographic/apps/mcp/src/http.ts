/**
 * The HTTP surface: one URL, everybody's memory behind it.
 *
 * Deliberately one shared endpoint rather than an address per person. A per-person URL
 * looks friendlier in an onboarding screen and is a secret in a config file that gets
 * pasted into a chat, committed to a repo, and never rotated. Identity comes from the
 * OAuth token on every request; the URL is public and carries nothing.
 *
 * Two things here are load-bearing beyond plumbing.
 *
 * The 401 carries `WWW-Authenticate` with a `resource_metadata` pointer (RFC 9728). That
 * single header is what turns connecting from "read the docs, register a client, paste a
 * token" into "click allow": a client that gets it discovers the authorisation server,
 * registers itself, and runs the whole flow unattended. Without it, every client needs a
 * person to configure it by hand, and most of them will not.
 *
 * Sessions are real rather than stateless. The tempting design is a fresh server per
 * request — no shared state, scales sideways for free. It also means every request looks
 * like a new client, and the health screen that tells a person whether Claude actually
 * received their profile would flip to amber one request after saying green. The session
 * is the unit the person thinks in, so it is the unit we keep.
 */

import type { AgentClient, PersonId } from '@photographic/core';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';

import type { McpDeps } from './deps.js';
import { SILENT_LOG } from './deps.js';
import { buildInstructions, createMcpServer } from './server.js';

interface Connection {
  personId: PersonId;
  server: Server;
  transport: WebStandardStreamableHTTPServerTransport;
  lastSeenAt: number;
}

export interface McpApp {
  /** Mountable by any fetch-based host; the API process serves it at `/mcp`. */
  fetch(request: Request): Promise<Response>;
  /** Closes every open connection. Called on shutdown so clients see a clean end. */
  close(): Promise<void>;
  /** Open connection count. Exported for tests and for a health endpoint to report. */
  size(): number;
}

/**
 * No router, and no hardcoded mount path.
 *
 * This endpoint is mounted under a prefix it does not get to choose — `/mcp` here, maybe
 * something else behind someone's proxy — and a router would have to be told its own base
 * path. Getting that wrong produces a 404 indistinguishable from a broken client. So the
 * prefix is read off the request instead, which also means the metadata document names
 * the resource the client actually called rather than one we assumed.
 */
const METADATA_PATH = '/.well-known/oauth-protected-resource';

export function createMcpApp(deps: McpDeps): McpApp {
  const log = deps.log ?? SILENT_LOG;
  const now = deps.now ?? (() => Date.now());
  const connections = new Map<string, Connection>();

  /**
   * Closes connections nobody is using.
   *
   * Swept on each request rather than on a timer, so nothing keeps the process alive and
   * nothing has to be torn down in a test. An idle map of servers is a slow leak, and this
   * is the cheapest place to notice it.
   */
  function reapIdle(): void {
    const cutoff = now() - deps.config.idleTimeoutMs;

    for (const [id, connection] of connections) {
      if (connection.lastSeenAt > cutoff) continue;
      connections.delete(id);
      void connection.server.close().catch(() => {});
      log.info('session_reaped', { personId: connection.personId });
    }
  }

  async function handle(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;

    /**
     * Answered at both spellings, because clients disagree about which one to fetch.
     *
     * RFC 9728 says a resource at `/mcp` publishes this at
     * `/.well-known/oauth-protected-resource/mcp`, and that is what the challenge points
     * at. Several clients instead append `.well-known` to the endpoint they were given.
     * Which one a client tries is not something we get to decide, and answering only the
     * correct one produces a class of "works in Cursor, not in Claude" that is invisible
     * from the outside.
     */
    if (path.includes(METADATA_PATH)) {
      if (request.method !== 'GET') return methodNotAllowed();

      return Response.json({
        resource: `${deps.config.publicUrl}${resourcePathOf(path)}`,
        authorization_servers: [deps.config.issuerUrl],
        scopes_supported: ['memory.read', 'memory.write'],
        bearer_methods_supported: ['header'],
      });
    }

    const token = bearerToken(request);

    if (!token) return challenge(deps, path, 'Ingen åtkomsttoken skickades med.');

    const actor = await deps.authenticate(token);
    if (!actor) {
      log.warn('token_rejected');
      return challenge(deps, path, 'Tokenen gäller inte längre. Anslut Photographic igen.');
    }

    reapIdle();

    const sessionId = request.headers.get('mcp-session-id');
    const existing = sessionId ? connections.get(sessionId) : undefined;

    if (existing) {
      // A session id is a capability, so it is checked against the token rather than
      // trusted. Without this, anyone who learns a session id inherits that person's
      // memory for as long as the session lives.
      if (existing.personId !== actor.personId) {
        log.warn('session_person_mismatch', { personId: actor.personId });
        return notFound('Sessionen finns inte.');
      }

      existing.lastSeenAt = now();
      return existing.transport.handleRequest(request);
    }

    if (request.method !== 'POST') {
      // GET opens the server-to-client notification stream and DELETE ends a session;
      // both are meaningless without one. A 404 is the spec's answer and makes a client
      // that lost its session re-initialize rather than sit in a retry loop.
      return notFound('Sessionen finns inte. Initiera anslutningen igen.');
    }

    const body: unknown = await request.json().catch(() => undefined);

    if (!isInitializeRequest(body)) {
      if (sessionId) return notFound('Sessionen har upphört. Initiera anslutningen igen.');
      return badRequest('Anslutningen måste börja med initialize.');
    }

    const agentClient = identifyClient(body, actor.agentClient);

    // Started before the instructions are built, because building them is the delivery we
    // are recording: the session has to exist for `recordDelivery` to have somewhere to
    // write, and a session that exists with nothing delivered is the honest state of a
    // connection whose profile failed to render.
    const session = await deps.services.sessions.start({
      personId: actor.personId,
      agentClient,
      transport: 'mcp',
    });

    const sessionActor = { ...actor, agentClient, sessionId: session.id };
    const instructions = await buildInstructions({
      services: deps.services,
      actor: sessionActor,
      log,
    });

    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: () => crypto.randomUUID(),
      onsessioninitialized: (id) => {
        connections.set(id, { personId: actor.personId, server, transport, lastSeenAt: now() });
        log.info('session_opened', { agentClient, personId: actor.personId });
      },
      onsessionclosed: (id) => {
        connections.delete(id);
        log.info('session_closed', { agentClient });
      },
    });

    const server = createMcpServer(
      { services: deps.services, actor: sessionActor, config: deps.config, log },
      instructions,
    );

    transport.onclose = () => {
      if (transport.sessionId) connections.delete(transport.sessionId);
    };

    await server.connect(transport);
    return transport.handleRequest(request, { parsedBody: body });
  }

  return {
    fetch: handle,
    close: async () => {
      await Promise.all([...connections.values()].map((c) => c.server.close().catch(() => {})));
      connections.clear();
    },
    size: () => connections.size,
  };
}

function bearerToken(request: Request): string | null {
  const header = request.headers.get('authorization');
  const match = header?.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || null;
}

/**
 * Which resource a metadata request is asking about.
 *
 * Two spellings reach here. `/.well-known/oauth-protected-resource/mcp` is RFC 9728's
 * path insertion, so what follows the well-known segment is the resource path;
 * `/mcp/.well-known/oauth-protected-resource` is the appended form some clients use, so
 * what precedes it is. Either way the answer names the endpoint the client called, which
 * is the point — a document declaring a `resource` the client did not request is one a
 * strict client is right to reject.
 */
function resourcePathOf(path: string): string {
  const at = path.indexOf(METADATA_PATH);
  const before = path.slice(0, at);
  const after = path.slice(at + METADATA_PATH.length);
  return (before || after).replace(/\/+$/, '');
}

/**
 * The 401 that starts the OAuth flow.
 *
 * `resource_metadata` is the whole point; the rest is courtesy. A client that ignores the
 * header shows the person an error, and the person has no way to know the fix was three
 * redirects it could have done itself.
 */
function challenge(deps: McpDeps, path: string, detail: string): Response {
  const metadata = `${deps.config.publicUrl}${METADATA_PATH}${path.replace(/\/+$/, '')}`;

  return new Response(
    JSON.stringify({
      jsonrpc: '2.0',
      error: { code: -32001, message: detail },
      id: null,
    }),
    {
      status: 401,
      headers: {
        'content-type': 'application/json',
        'www-authenticate': `Bearer realm="photographic", resource_metadata="${metadata}"`,
      },
    },
  );
}

function notFound(message: string): Response {
  return jsonRpcError(404, -32001, message);
}

function badRequest(message: string): Response {
  return jsonRpcError(400, -32600, message);
}

function methodNotAllowed(): Response {
  return jsonRpcError(405, -32600, 'Fel metod.');
}

function jsonRpcError(status: number, code: number, message: string): Response {
  return new Response(JSON.stringify({ jsonrpc: '2.0', error: { code, message }, id: null }), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/**
 * Which AI is on the other end.
 *
 * The token knows what it was issued to, which is not the same thing — one token can
 * serve a desktop app and a CLI. `clientInfo.name` is what the client says about itself
 * at initialize, and it is the only signal precise enough for the health screen to say
 * "Claude fick din profil" rather than "någon klient fick din profil".
 *
 * Unrecognised names fall back to the token's client rather than to `unknown`, so a
 * client we have never seen still lands somewhere sensible.
 */
export function identifyClient(initialize: unknown, fallback: AgentClient): AgentClient {
  const name = clientName(initialize);
  if (!name) return fallback;

  const lower = name.toLowerCase();

  if (lower.includes('claude-code') || lower.includes('claude code')) return 'claude-code';
  if (lower.includes('claude') && lower.includes('mobile')) return 'claude-mobile';
  if (lower.includes('claude')) return 'claude-desktop';
  if (lower.includes('cursor')) return 'cursor';
  if (lower.includes('codex')) return 'codex';
  if (lower.includes('chatgpt') || lower.includes('openai')) return 'chatgpt-web';

  return fallback === 'unknown' ? 'api' : fallback;
}

function clientName(initialize: unknown): string | null {
  if (typeof initialize !== 'object' || initialize === null) return null;
  const params = (initialize as { params?: unknown }).params;
  if (typeof params !== 'object' || params === null) return null;
  const info = (params as { clientInfo?: unknown }).clientInfo;
  if (typeof info !== 'object' || info === null) return null;
  const name = (info as { name?: unknown }).name;
  return typeof name === 'string' ? name : null;
}
