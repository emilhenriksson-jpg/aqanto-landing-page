/**
 * The MCP server.
 *
 * One thing here matters more than everything else: `instructions`. It is the only place
 * in any protocol we can reach where our text lands in system-prompt position *before*
 * the person types. That is what "full context immediately" means concretely — not that
 * a model can look the person up, but that it already knows them by the time they say
 * hello. If a session starts and the model asks who it is talking to, the product has not
 * worked, however well the eight tools behave.
 *
 * Which is why a server is constructed per connection rather than once per process: the
 * instructions string is one person's profile, and a shared server would either serve one
 * person's memory to everyone or serve nobody's. The cost is building a context bundle on
 * each initialize, and that is exactly what `BundlePort` is cached for.
 *
 * The low-level `Server` is used rather than `McpServer` because the tool definitions in
 * `@photographic/agent` are JSON Schema written for the model to read, and the high-level
 * API would require restating them as zod and losing the descriptions that are the
 * product.
 */

import {
  FALLBACK_INSTRUCTIONS,
  INSTRUCTIONS_TOKEN_BUDGET,
  renderInstructions,
  TOOLS,
  toolWireFormat,
} from '@photographic/agent';
import type { ToolDefinition } from '@photographic/agent';
import type { Actor, Services } from '@photographic/core';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

import type { McpConfig, McpLog } from './deps.js';
import { SILENT_LOG } from './deps.js';
import { dispatchTool } from './dispatch.js';

export interface McpServerDeps {
  services: Services;
  actor: Actor;
  /** Capabilities the connection's token carries. See `toolsFor`. */
  scopes: string[];
  config: McpConfig;
  log?: McpLog;
}

/**
 * Builds the instructions for one person.
 *
 * Failure here is deliberately not fatal. A projection that cannot be built is a reason
 * to connect with a smaller promise, not a reason to refuse the connection: a person
 * whose client says "could not connect" has no way to tell that from a bug in the client,
 * and will conclude the product is broken. A session with tools and no profile still
 * works, it just works less well, and the health screen will show it as amber.
 */
export async function buildInstructions(deps: {
  services: Services;
  actor: Actor;
  log?: McpLog;
}): Promise<string> {
  const log = deps.log ?? SILENT_LOG;

  try {
    // Built against the ceiling it will be rendered against. `InitializeResult.instructions`
    // has a tighter one than the REST bundle — some clients truncate a long instruction
    // string without saying so — and building against 2000 only to render against 1400
    // meant the assembly's own retention order (headlines, then the active room, then
    // profile items) was solved for a package nobody received.
    const bundle = await deps.services.bundle.build(deps.actor, {
      budgetTokens: INSTRUCTIONS_TOKEN_BUDGET,
    });

    if (deps.actor.sessionId) {
      await deps.services.sessions.recordDelivery(
        deps.actor.sessionId,
        'mcp_instructions',
        bundle.profile.version,
      );
    }

    return renderInstructions(bundle);
  } catch (error) {
    log.error('instructions_failed', {
      personId: deps.actor.personId,
      error: error instanceof Error ? error.message : String(error),
    });

    return FALLBACK_INSTRUCTIONS;
  }
}

export function createMcpServer(deps: McpServerDeps, instructions: string): Server {
  const log = deps.log ?? SILENT_LOG;

  const server = new Server(
    { name: deps.config.serverName, version: deps.config.serverVersion },
    {
      capabilities: { tools: {}, logging: {} },
      instructions,
    },
  );

  const allowed = toolsFor(deps.scopes);

  server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: allowed.map(toolWireFormat),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    // Checked again rather than relying on the filtered list. `tools/list` is advice a
    // client may ignore, cache from a previous connection, or never call at all — and a
    // model that has seen `remember` in an earlier session will try it.
    const denial = denyForScope(request.params.name, deps.scopes);
    if (denial) {
      log.warn('tool_scope_denied', {
        tool: request.params.name,
        personId: deps.actor.personId,
      });
      return { content: [{ type: 'text' as const, text: denial }], isError: true };
    }

    const result = await dispatchTool(
      { services: deps.services, log },
      deps.actor,
      request.params.name,
      request.params.arguments,
    );

    return {
      content: [{ type: 'text' as const, text: result.text }],
      isError: result.isError,
    };
  });

  return server;
}

/**
 * The tools a connection may actually call.
 *
 * Filtered rather than listed-and-refused, for two reasons. A tool definition sits in
 * the context window for the whole session, so advertising ones that cannot work is
 * paying tokens for a guaranteed failure. And a model that can see `remember` will use
 * it and then tell the person their memory was saved when it was not — whereas a model
 * that cannot see it says it is unable to save, which is true.
 */
export function toolsFor(scopes: readonly string[]): ToolDefinition[] {
  return TOOLS.filter((tool) => tool.scopes.every((scope) => scopes.includes(scope)));
}

/**
 * The refusal text, addressed to the model.
 *
 * English, like the rest of what the model is told, and explicit that this is a
 * permission the person can grant rather than a malfunction — otherwise the model
 * reports "something went wrong", and the person has no idea their connection is
 * read-only.
 */
function denyForScope(name: string, scopes: readonly string[]): string | null {
  const tool = TOOLS.find((candidate) => candidate.name === name);
  if (!tool) return null;

  const missing = tool.scopes.filter((scope) => !scopes.includes(scope));
  if (missing.length === 0) return null;

  return (
    `Not permitted: this connection was granted ${scopes.join(', ') || 'no scopes'} and ` +
    `${name} requires ${missing.join(', ')}. This is a read-only connection, not an ` +
    'error. Tell the person they can reconnect granting write access if they want you ' +
    'to be able to do this.'
  );
}
