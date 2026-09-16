import { describe, expect, it } from 'vitest';

import { buildClients } from './clients.js';
import { detect, orderClients } from './detect.js';

const CONFIG = {
  mcpUrl: 'https://photographic.me/mcp',
  connectPageUrl: 'https://photographic.me/connect',
};
const CLIENTS = buildClients(CONFIG);

const MAC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15';
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15';
const CURSOR = 'Mozilla/5.0 (Macintosh) Cursor/3.15.17 Chrome/128';

describe('detection', () => {
  it('reads the platform', () => {
    expect(detect(MAC).platform).toBe('macos');
    expect(detect(IPHONE).platform).toBe('ios');
    expect(detect('Mozilla/5.0 (Windows NT 10.0; Win64)').platform).toBe('windows');
    expect(detect('Mozilla/5.0 (X11; Linux x86_64)').platform).toBe('linux');
    expect(detect('Mozilla/5.0 (Linux; Android 14)').platform).toBe('android');
  });

  it('recognises iPad requesting desktop pages', () => {
    expect(detect(MAC, 5).platform).toBe('ios');
    expect(detect(MAC, 0).platform).toBe('macos');
  });

  it('flags mobile only for phones', () => {
    expect(detect(IPHONE).mobile).toBe(true);
    expect(detect(MAC).mobile).toBe(false);
  });

  it('survives a missing user agent', () => {
    expect(detect(null)).toEqual({ platform: 'unknown', mobile: false, likelyClient: null });
    expect(detect(undefined).platform).toBe('unknown');
  });

  it('recognises the request coming from an AI client', () => {
    expect(detect(CURSOR).likelyClient).toBe('cursor');
    expect(detect('Claude/1.0 (macOS)').likelyClient).toBe('claude');
  });
});

describe('ordering', () => {
  it('never removes or duplicates a client', () => {
    for (const ua of [MAC, IPHONE, CURSOR, null, '']) {
      const ordered = orderClients(CLIENTS, ua);
      expect(ordered).toHaveLength(CLIENTS.length);
      expect(new Set(ordered.map((c) => c.id)).size).toBe(CLIENTS.length);
      expect([...ordered].map((c) => c.id).sort()).toEqual(CLIENTS.map((c) => c.id).sort());
    }
  });

  it('leads with the detected client', () => {
    expect(orderClients(CLIENTS, CURSOR)[0]?.id).toBe('cursor');
  });

  it('does not lead with a terminal command on a phone', () => {
    expect(orderClients(CLIENTS, IPHONE)[0]?.primary.type).not.toBe('command');
  });

  it('leads with a one-click option on a desktop', () => {
    expect(orderClients(CLIENTS, MAC)[0]?.oneClick).toBe(true);
  });

  it('does not mutate the input array', () => {
    const before = CLIENTS.map((c) => c.id);
    orderClients(CLIENTS, CURSOR);
    expect(CLIENTS.map((c) => c.id)).toEqual(before);
  });
});
