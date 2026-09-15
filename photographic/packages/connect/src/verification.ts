/**
 * Proving the connection actually works.
 *
 * The rule: never report success because configuration was written. Report it when
 * context provably reached the model. Writing a config file is something we can
 * observe locally and tells us almost nothing; a delivered profile is the only
 * evidence that matters, and it is the thing the person actually came for.
 *
 * So after connecting, the screen asks them to say one sentence to their AI, and then
 * waits for the delivery to show up. That moment is what makes the memory trustworthy
 * instead of merely configured.
 */

import type { Actor, AgentClient, DeliveryMethod, SessionPort } from '@photographic/core';

import type { ClientDescriptor } from './clients.js';

export const VERIFICATION_TIMEOUT_MS = 90 * 1000;

/** Plain and JSON-safe: it round-trips to the browser between polls. */
export interface VerificationHandle {
  clientId: ClientDescriptor['id'];
  expected: AgentClient[];
  startedAtMs: number;
  timeoutMs: number;
  /** Last-seen timestamps at start, so an earlier session cannot be mistaken for this one. */
  baseline: Record<string, number>;
}

export type VerificationState =
  | { status: 'waiting'; prompt: string; elapsedMs: number; remainingMs: number }
  | {
      status: 'connected';
      agentClient: AgentClient;
      deliveryMethod: DeliveryMethod | null;
      at: Date;
      /** True when the profile arrived by a weaker route than this client should manage. */
      degraded: boolean;
    }
  | { status: 'timed_out'; remedy: string; elapsedMs: number };

export interface VerificationDeps {
  sessions: SessionPort;
  clock: () => Date;
}

export async function startVerification(
  deps: VerificationDeps,
  actor: Actor,
  client: ClientDescriptor,
  options: { timeoutMs?: number } = {},
): Promise<VerificationHandle> {
  const health = await deps.sessions.health(actor);
  const baseline: Record<string, number> = {};
  for (const entry of health) {
    baseline[entry.agentClient] = entry.lastSeenAt.getTime();
  }

  return {
    clientId: client.id,
    expected: client.agentClients,
    startedAtMs: deps.clock().getTime(),
    timeoutMs: options.timeoutMs ?? VERIFICATION_TIMEOUT_MS,
    baseline,
  };
}

export async function pollVerification(
  deps: VerificationDeps,
  actor: Actor,
  handle: VerificationHandle,
  client: ClientDescriptor,
): Promise<VerificationState> {
  const nowMs = deps.clock().getTime();
  const elapsedMs = nowMs - handle.startedAtMs;
  const expected = new Set<string>(handle.expected);

  const health = await deps.sessions.health(actor);

  for (const entry of health) {
    if (!expected.has(entry.agentClient)) continue;
    if (!entry.profileDelivered) continue;

    const seenMs = entry.lastSeenAt.getTime();
    const before = handle.baseline[entry.agentClient];
    // A delivery counts only if it is newer than what we had already seen, otherwise
    // reconnecting a client that worked last week would light up green immediately.
    if (before !== undefined && seenMs <= before) continue;
    if (seenMs < handle.startedAtMs) continue;

    return {
      status: 'connected',
      agentClient: entry.agentClient,
      deliveryMethod: entry.deliveryMethod,
      at: entry.lastSeenAt,
      degraded: isDegraded(client.expectedDelivery, entry.deliveryMethod),
    };
  }

  if (elapsedMs >= handle.timeoutMs) {
    return { status: 'timed_out', remedy: client.remedy, elapsedMs };
  }

  return {
    status: 'waiting',
    prompt: client.verifyPrompt,
    elapsedMs,
    remainingMs: handle.timeoutMs - elapsedMs,
  };
}

const DELIVERY_RANK: Record<DeliveryMethod, number> = {
  tool_call: 0,
  mcp_instructions: 1,
  hook: 2,
  system_prompt: 3,
};

/** True when context arrived, but by a less reliable route than this client supports. */
export function isDegraded(
  expected: DeliveryMethod,
  actual: DeliveryMethod | null,
): boolean {
  if (actual === null) return true;
  return DELIVERY_RANK[actual] < DELIVERY_RANK[expected];
}
