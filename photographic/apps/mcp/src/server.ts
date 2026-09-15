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

import { FALLBACK_INSTRUCTIONS, renderInstructions, TOOLS } from '@photographic/agent';
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
    const bundle = await deps.services.bundle.build(deps.actor);

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

  server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: TOOLS.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
      annotations: tool.annotations,
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
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
