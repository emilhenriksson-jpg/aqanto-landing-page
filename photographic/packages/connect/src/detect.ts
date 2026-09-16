/**
 * Guess what the person is most likely to connect, to decide what goes at the top.
 *
 * Detection only ever reorders. Nothing is hidden, because a wrong guess that also
 * removes the right answer is much worse than no guess at all.
 */

import type { ClientDescriptor, ClientId } from './clients.js';
import { CAPABILITY_RANK } from './clients.js';

export type Platform = 'macos' | 'windows' | 'linux' | 'ios' | 'android' | 'unknown';

export interface Detection {
  platform: Platform;
  mobile: boolean;
  /** The client the request came *from*, when it is itself an AI client. */
  likelyClient: ClientId | null;
}

export function detect(userAgent: string | null | undefined, maxTouchPoints = 0): Detection {
  const ua = (userAgent ?? '').toLowerCase();

  const platform: Platform = ua.includes('iphone') || ua.includes('ipad') || (ua.includes('macintosh') && maxTouchPoints > 1)
    ? 'ios'
    : ua.includes('android')
      ? 'android'
      : ua.includes('mac os') || ua.includes('macintosh')
        ? 'macos'
        : ua.includes('windows')
          ? 'windows'
          : ua.includes('linux') || ua.includes('x11')
            ? 'linux'
            : 'unknown';

  const mobile = platform === 'ios' || platform === 'android';

  const likelyClient: ClientId | null = ua.includes('cursor')
    ? 'cursor'
    : ua.includes('claude')
      ? 'claude'
      : ua.includes('code-insiders') || ua.includes('vscode') || ua.includes('visual studio code')
        ? 'vscode'
        : ua.includes('chatgpt') || ua.includes('openai')
          ? 'chatgpt'
          : null;

  return { platform, mobile, likelyClient };
}

/**
 * Order for display: the detected client first, then one-click options, then by how
 * reliably context actually arrives. Length is always preserved.
 */
export function orderClients(
  clients: ClientDescriptor[],
  userAgent?: string | null,
): ClientDescriptor[] {
  const { likelyClient, mobile } = detect(userAgent);

  return [...clients].sort((a, b) => {
    if (a.id === likelyClient !== (b.id === likelyClient)) return a.id === likelyClient ? -1 : 1;

    // On a phone nothing installs locally, so lead with what can be finished there.
    const aLocal = a.primary.type === 'command';
    const bLocal = b.primary.type === 'command';
    if (mobile && aLocal !== bLocal) return aLocal ? 1 : -1;

    if (!mobile && a.oneClick !== b.oneClick) return a.oneClick ? -1 : 1;

    const rank = CAPABILITY_RANK[b.capability] - CAPABILITY_RANK[a.capability];
    if (rank !== 0) return rank;

    return a.displayName.localeCompare(b.displayName);
  });
}
