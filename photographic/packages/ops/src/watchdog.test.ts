import { describe, expect, it, vi } from 'vitest';

import type { Alert, AlertSink, Check } from './alert.js';
import { failing, ok } from './alert.js';
import { AlertRouter } from './router.js';
import { createWatchdog, heartbeatFromEnv } from './watchdog.js';

function sink(): AlertSink & { sent: Alert[] } {
  const sent: Alert[] = [];
  return { kind: 'test', sent, send: async (alert) => void sent.push(alert) };
}

function silent() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

const healthy: Check = {
  key: 'job_queue',
  run: async () => ok({ key: 'job_queue', severity: 'critical', title: 'Jobbkön töms' }),
};

const broken: Check = {
  key: 'persistence_fallback',
  run: async () =>
    failing({ key: 'persistence_fallback', severity: 'critical', title: 'Ingen databas' }),
};

const annoying: Check = {
  key: 'exports',
  run: async () => failing({ key: 'exports', severity: 'warning', title: 'En export har hängt' }),
};

describe('createWatchdog', () => {
  it('pings the dead-man switch on a healthy pass', async () => {
    const fetch = vi.fn(async () => new Response('', { status: 200 }));
    const watchdog = createWatchdog({
      checks: [healthy],
      router: new AlertRouter({ sink: sink() }),
      logger: silent(),
      heartbeat: { url: 'https://hc.test/ping', fetch },
    });

    const pass = await watchdog.runOnce();

    expect(pass.heartbeat).toBe('sent');
    expect(fetch).toHaveBeenCalledWith('https://hc.test/ping', expect.objectContaining({ method: 'POST' }));
  });

  it('withholds the ping when a critical check fails, so the external monitor also fires', async () => {
    const fetch = vi.fn(async () => new Response('', { status: 200 }));
    const watchdog = createWatchdog({
      checks: [healthy, broken],
      router: new AlertRouter({ sink: sink() }),
      logger: silent(),
      heartbeat: { url: 'https://hc.test/ping', fetch },
    });

    const pass = await watchdog.runOnce();

    expect(pass.heartbeat).toBe('withheld');
    expect(fetch).not.toHaveBeenCalled();
    expect(pass.criticalFailing).toEqual(['persistence_fallback']);
  });

  it('keeps pinging when only a warning is failing', async () => {
    const fetch = vi.fn(async () => new Response('', { status: 200 }));
    const watchdog = createWatchdog({
      checks: [annoying],
      router: new AlertRouter({ sink: sink() }),
      logger: silent(),
      heartbeat: { url: 'https://hc.test/ping', fetch },
    });

    const pass = await watchdog.runOnce();

    expect(pass.heartbeat).toBe('sent');
    expect(pass.failing).toEqual(['exports']);
  });

  it('survives a heartbeat that cannot be reached', async () => {
    const logger = silent();
    const watchdog = createWatchdog({
      checks: [healthy],
      router: new AlertRouter({ sink: sink() }),
      logger,
      heartbeat: {
        url: 'https://hc.test/ping',
        fetch: async () => {
          throw new Error('EAI_AGAIN');
        },
      },
    });

    const pass = await watchdog.runOnce();

    expect(pass.heartbeat).toBe('failed');
    expect(logger.warn).toHaveBeenCalledWith('heartbeat_failed', expect.anything());
  });

  it('routes what the checks found', async () => {
    const target = sink();
    const watchdog = createWatchdog({
      checks: [broken],
      router: new AlertRouter({ sink: target }),
      logger: silent(),
    });

    const pass = await watchdog.runOnce();

    expect(pass.sent).toHaveLength(1);
    expect(target.sent[0]?.key).toBe('persistence_fallback');
    expect(pass.heartbeat).toBe('off');
  });
});

describe('heartbeatFromEnv', () => {
  it('is off unless a URL is given', () => {
    expect(heartbeatFromEnv({})).toBeNull();
    expect(heartbeatFromEnv({ HEARTBEAT_URL: '  ' })).toBeNull();
    expect(heartbeatFromEnv({ HEARTBEAT_URL: 'https://hc.test/x' })).toEqual({
      url: 'https://hc.test/x',
    });
  });
});
