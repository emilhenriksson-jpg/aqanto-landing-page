/**
 * Which AI a client is, decided once.
 *
 * Provenance is the one thing in this product that cannot be backfilled. A memory says
 * "Claude sparade det här den 14 september", and if the string in that sentence comes
 * from a name the client sends on every request, then a client picks its own label in
 * someone else's memory history — and can pick a different one tomorrow.
 *
 * So the derivation runs exactly once, at registration, and the result is frozen in
 * `app.oauth_client` by a trigger. This module is that derivation. It is a guess about
 * an attacker-controlled string, and the important part is what it does when the guess
 * fails: `unknown`, and the Swedish label `okänd klient`. Never a plausible default.
 * A confidently wrong attribution next to "sparade" is worse than an honest blank,
 * because the person has no way to tell it is wrong.
 *
 * What a person does get is a rename. `client_grant.display_name` is theirs — "Claude på
 * jobbdatorn" — and that is the name the history and "hur vet du det?" show. The frozen
 * label is only the fallback and the audit trail.
 */

import type { AgentClient } from '@photographic/core';

/** Where `clientLabel` came from. `unrecognised` is a real answer, not a missing one. */
export type ClientLabelSource = 'registration' | 'unrecognised' | 'manual';

export interface ClientIdentity {
  /** The `AgentClient` used for provenance. `unknown` when we could not tell. */
  agentClient: AgentClient;
  /** Swedish, shown to the person until they rename it. */
  clientLabel: string;
  labelSource: ClientLabelSource;
}

/** What an unrecognised client is called. Honest rather than plausible. */
export const UNKNOWN_CLIENT_LABEL = 'okänd klient';

/**
 * Patterns we are willing to claim, most specific first.
 *
 * Order is load-bearing: "Claude Code" also contains "claude", so the narrower pattern
 * has to be asked first or every Claude Code install is labelled as the desktop app.
 */
const KNOWN_CLIENTS: ReadonlyArray<{
  agentClient: AgentClient;
  label: string;
  matches: (name: string) => boolean;
}> = [
  {
    agentClient: 'claude-code',
    label: 'Claude Code',
    matches: (name) => name.includes('claude code') || name.includes('claude-code'),
  },
  {
    agentClient: 'claude-mobile',
    label: 'Claude på mobilen',
    matches: (name) => name.includes('claude') && (name.includes('mobile') || name.includes('ios') || name.includes('android')),
  },
  {
    agentClient: 'claude-desktop',
    label: 'Claude',
    matches: (name) => name.includes('claude'),
  },
  {
    agentClient: 'cursor',
    label: 'Cursor',
    matches: (name) => name.includes('cursor'),
  },
  {
    agentClient: 'codex',
    label: 'Codex',
    matches: (name) => name.includes('codex'),
  },
  {
    agentClient: 'chatgpt-web',
    label: 'ChatGPT',
    matches: (name) => name.includes('chatgpt') || name.includes('openai'),
  },
];

/**
 * Derives a client's frozen identity from the name it registered under.
 *
 * Called at registration and nowhere else. Calling it per request is the bug this
 * module exists to remove.
 */
export function deriveClientIdentity(clientName: string): ClientIdentity {
  const name = clientName.toLowerCase();

  for (const candidate of KNOWN_CLIENTS) {
    if (!candidate.matches(name)) continue;
    return {
      agentClient: candidate.agentClient,
      clientLabel: candidate.label,
      labelSource: 'registration',
    };
  }

  return {
    agentClient: 'unknown',
    clientLabel: UNKNOWN_CLIENT_LABEL,
    labelSource: 'unrecognised',
  };
}

/**
 * The name to show a person for a client.
 *
 * Their own rename wins over everything. Nothing here falls back to the raw
 * registration name: that string is what the client chose to call itself, and showing
 * it unlabelled in a history feed is the attribution problem all over again — a client
 * registered as "Photographic Official" would read as us.
 */
export function clientDisplayName(input: {
  displayName?: string | null;
  clientLabel?: string | null;
}): string {
  const renamed = input.displayName?.trim();
  if (renamed) return renamed;

  const label = input.clientLabel?.trim();
  return label && label.length > 0 ? label : UNKNOWN_CLIENT_LABEL;
}
