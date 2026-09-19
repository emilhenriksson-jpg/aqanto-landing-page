import type { ClientId } from '@photographic/connect';

// A device preference, not a connection receipt. Never store names, prompts or context.
const KEY = 'photographic.chat-choice.v1';
export const CHAT_CLIENTS: ClientId[] = ['chatgpt', 'codex', 'cursor', 'claude'];

export function lastChatChoice(): ClientId | null {
  try {
    const value = localStorage.getItem(KEY);
    return CHAT_CLIENTS.find(id => id === value) ?? null;
  } catch { return null; }
}

export function rememberChatChoice(id: ClientId): void {
  if (!CHAT_CLIENTS.includes(id)) return;
  try { localStorage.setItem(KEY, id); } catch { /* The app link still works without storage. */ }
}
