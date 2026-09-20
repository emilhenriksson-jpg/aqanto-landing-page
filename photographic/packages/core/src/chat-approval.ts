import type { Proposal } from './domain.js';

/** A chat client attests to the user's answer; this is not proof of human presence. */
export interface ProposalConsent {
  reason?: string;
  reviewed: boolean;
  privateOnly?: boolean;
  reviewKey?: string;
  confirmation?: string;
}

/** Binds an answer to the exact preview, including destination and source metadata. */
export async function proposalReviewKey(proposal: Proposal): Promise<string> {
  function stable(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(stable);
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
        .map(([key, entry]) => [key, stable(entry)]));
    }
    return value;
  }
  const bytes = new TextEncoder().encode(JSON.stringify(stable({
    id: proposal.id, roomId: proposal.roomId, personId: proposal.personId,
    intent: proposal.intent, kind: proposal.kind, body: proposal.body, reason: proposal.reason,
    conflictsWith: proposal.conflictsWith, sourceItemId: proposal.sourceItemId,
    structured: proposal.structured, motivation: proposal.motivation,
  })));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

export function privateRoomTitle(title: string): string {
  return title.trim().normalize('NFKC').replace(/\s+/g, ' ');
}
