import type { AgentClient, Item, ItemKind, Proposal } from './domain.js';
import type { LlmPort } from './ports.js';
import { dedupeHash } from './policy.js';

export interface ContextCandidate {
  text: string;
  kind: Exclude<ItemKind, 'compass' | 'name' | 'identity'>;
  origin: 'conversation' | 'client_memory' | 'file' | 'mail' | 'slack' | 'photographic';
  sourceLabel: string;
  evidence: 'reported' | 'inferred';
  sensitive: boolean;
  concernsOthers: boolean;
  observedAt?: string;
}
export interface ContributionMeta extends ContextCandidate {
  batchId: string;
  agentClient: AgentClient;
  clientId: string | null;
  sessionId: string | null;
  preparedAt: string;
  reviewRequired: boolean;
  conflictBody: string | null;
}
export interface ContributionState { paused: boolean; pending: number }
export interface ContributionPreview {
  batchId: string;
  paused: boolean;
  proposals: Proposal[];
  skipped: Array<{ index: number; reason: 'known' | 'already_offered' | 'photographic' | 'secret' }>;
}
export interface ContributionResolution {
  id: string;
  status: 'saved' | 'dismissed' | 'already_handled' | 'needs_review' | 'failed';
  shortId?: string;
}
export function contributionMeta(proposal: Pick<Proposal, 'structured'>): ContributionMeta | null {
  const value = proposal.structured['contribution'];
  return value && typeof value === 'object' && typeof (value as ContributionMeta).batchId === 'string'
    ? value as ContributionMeta : null;
}
export function containsSecret(text: string): boolean {
  return /\b(?:sk-[a-z0-9_-]{8,}|gh[pousr]_[a-z0-9]{8,}|xox[baprs]-)|\b(?:password|lösenord|passphrase|api[ -]?key|secret[ -]?key|token|cvv|personnummer)\s*[:=]|\b\d{4}[ -]?\d{4}[ -]?\d{4}[ -]?\d{4}\b/i.test(text);
}

/** Full stored items, not the budgeted profile. Semantic shortlist across languages. */
export async function compareContribution(
  body: string, items: Item[], previous: Proposal[], llm: LlmPort, cache = new Map<string, number[]>(),
): Promise<{ known: boolean; knownItem?: Item; previous: Proposal | null; conflict: Item | null }> {
  const key = dedupeHash(body);
  const known = items.find(item => dedupeHash(item.body) === key);
  if (known) return { known: true, knownItem: known, previous: null, conflict: null };
  const offered = previous.find(item => dedupeHash(item.body) === key || dedupeHash(contributionMeta(item)?.text ?? '') === key);
  if (offered) return { known: false, previous: offered, conflict: null };
  const choices = [...items.map(item => ({ body: item.body, item, proposal: null as Proposal | null })),
    ...previous.map(proposal => ({ body: contributionMeta(proposal)?.text ?? proposal.body, item: null as Item | null, proposal }))];
  if (!choices.length) return { known: false, previous: null, conflict: null };
  const texts = [body, ...choices.map(item => item.body)];
  const missing = [...new Set(texts)].filter(text => !cache.has(text));
  for (let start = 0; start < missing.length; start += 128) {
    const chunk = missing.slice(start, start + 128);
    const embedded = await llm.embed(chunk);
    if (embedded.length !== chunk.length || embedded.some(vector => !vector.length || vector.some(x => !Number.isFinite(x)))) {
      throw new Error('Jämförelsen kunde inte slutföras. Försök igen.');
    }
    chunk.forEach((text, index) => cache.set(text, embedded[index]!));
  }
  const vectors = texts.map(text => cache.get(text) ?? []);
  const vector = vectors[0] ?? [];
  const norm = (v: number[]) => Math.sqrt(v.reduce((sum, x) => sum + x * x, 0)) || 1;
  const neighbours = choices.map((entry, index) => {
    const other = vectors[index + 1] ?? [];
    return { ...entry, score: vector.reduce((sum, x, i) => sum + x * (other[i] ?? 0), 0) / (norm(vector) * norm(other)) };
  }).sort((a, b) => b.score - a.score).slice(0, 8);
  let conflict: Item | null = null;
  const verdicts = await Promise.all(neighbours.map(entry => llm.compare(body, entry.body)));
  for (const [index, entry] of neighbours.entries()) {
    const verdict = verdicts[index];
    if (verdict === 'same') return { known: entry.item !== null, ...(entry.item ? { knownItem: entry.item } : {}), previous: entry.proposal, conflict: null };
    if (verdict === 'contradicts' && entry.item && !conflict) conflict = entry.item;
  }
  return { known: false, previous: null, conflict };
}

export function contributionReason(meta: ContributionMeta): string {
  return [
    `Kontext från ${meta.sourceLabel}. Sparas privat efter ditt godkännande.`,
    meta.evidence === 'inferred' ? 'Obekräftad tolkning, inte ett fastställt faktum.' : '',
    meta.sensitive ? 'Innehåller känsliga uppgifter.' : '',
    meta.concernsOthers ? 'Innehåller uppgifter om andra.' : '',
    meta.conflictBody ? `Skiljer sig från ett befintligt minne: ”${meta.conflictBody}”. Granska vad som gäller.` : '',
    meta.observedAt ? `Uppgiften avser ${meta.observedAt}.` : '',
  ].filter(Boolean).join(' ');
}

export function candidateBody(candidate: ContextCandidate): string {
  const text = candidate.text.trim().replace(/\s+/g, ' ');
  return candidate.evidence === 'inferred' ? `Obekräftad tolkning: ${text}` : text;
}
export function needsSeparateReview(candidate: ContextCandidate): boolean {
  return candidate.sensitive || candidate.concernsOthers || candidate.evidence === 'inferred'
    || candidate.kind === 'instruction' || candidate.kind === 'never';
}

export function contributionItemMetadata(meta: ContributionMeta): Record<string, unknown> {
  const { text: _text, conflictBody: _conflictBody, ...source } = meta;
  return { contribution: source };
}
