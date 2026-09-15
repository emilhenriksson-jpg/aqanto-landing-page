import { describe, expect, it, vi } from 'vitest';

import type { Alert } from './alert.js';
import { formatAlert } from './alert.js';
import { createAlertSinkFromEnv, FanOutAlertSink, SmsAlertSink, WebhookAlertSink } from './sinks.js';

const alert: Alert = {
  key: 'persistence_fallback',
  status: 'failing',
  severity: 'critical',
  title: 'Produktionen kör utan databasen — minnet försvinner vid omstart',
  detail: 'Processen föll tillbaka på reservimplementationen.',
  fields: { persistence: 'memory', storage: 'local' },
  resolved: false,
  at: new Date('2026-09-15T18:00:00.000Z'),
};

function silent() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function response(status = 200): Response {
  return new Response('', { status });
}

describe('formatAlert', () => {
  it('leads with the severity, in Swedish, and ends with the key to grep for', () => {
    const line = formatAlert(alert);
    expect(line.startsWith('[KRITISKT] Photografic:')).toBe(true);
    expect(line).toContain('persistence=memory');
    expect(line.endsWith('[persistence_fallback]')).toBe(true);
  });

  it('says ÅTERSTÄLLT for a recovery', () => {
    expect(formatAlert({ ...alert, resolved: true })).toContain('[ÅTERSTÄLLT]');
  });

  it('fits one SMS segment when asked to', () => {
    expect(formatAlert(alert, { maxLength: 160 })).toHaveLength(160);
  });
});

describe('WebhookAlertSink', () => {
  it('posts a body that Slack, Discord and ntfy can all render', async () => {
    const fetch = vi.fn(async () => response());
    await new WebhookAlertSink({ url: 'https://example.test/hook', fetch }).send(alert);

    const [, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body.text).toEqual(body.content);
    expect(body.severity).toBe('critical');
    expect(body.fields).toEqual({ persistence: 'memory', storage: 'local' });
  });

  it('throws on a rejected webhook so the fan-out can log which sink failed', async () => {
    const fetch = vi.fn(async () => response(404));
    await expect(
      new WebhookAlertSink({ url: 'https://example.test/hook', fetch }).send(alert),
    ).rejects.toThrow('404');
  });

  it('drops a warning when configured for critical only', async () => {
    const fetch = vi.fn(async () => response());
    await new WebhookAlertSink({
      url: 'https://example.test/hook',
      minSeverity: 'critical',
      fetch,
    }).send({ ...alert, severity: 'warning' });

    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('SmsAlertSink', () => {
  it('sends criticals and leaves warnings alone by default', async () => {
    const fetch = vi.fn(async () => response());
    const sink = new SmsAlertSink({
      username: 'u',
      password: 'p',
      from: 'Photografic',
      to: '+46700000000',
      fetch,
    });

    await sink.send({ ...alert, severity: 'warning' });
    expect(fetch).not.toHaveBeenCalled();

    await sink.send(alert);
    expect(fetch).toHaveBeenCalledTimes(1);
    const [, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    const form = new URLSearchParams(String(init.body));
    expect(form.get('to')).toBe('+46700000000');
    expect((form.get('message') ?? '').length).toBeLessThanOrEqual(160);
  });
});

describe('FanOutAlertSink', () => {
  it('keeps delivering after one sink throws', async () => {
    const logger = silent();
    const delivered: string[] = [];
    const sink = new FanOutAlertSink(
      [
        {
          kind: 'broken',
          send: async () => {
            throw new Error('nej');
          },
        },
        { kind: 'working', send: async () => void delivered.push('yes') },
      ],
      logger,
    );

    await sink.send(alert);

    expect(delivered).toEqual(['yes']);
    expect(logger.error).toHaveBeenCalledWith('alert_send_failed', expect.objectContaining({ sink: 'broken' }));
  });
});

describe('createAlertSinkFromEnv', () => {
  it('reports log-only when nothing is configured, rather than pretending', () => {
    const selection = createAlertSinkFromEnv({}, { logger: silent() });
    expect(selection.logOnly).toBe(true);
    expect(selection.kinds).toEqual(['log']);
  });

  it('refuses a half-configured SMS channel instead of quietly logging', () => {
    expect(() =>
      createAlertSinkFromEnv({ ALERT_SMS_TO: '+46700000000' }, { logger: silent() }),
    ).toThrow('ELKS_API_USERNAME');
  });

  it('takes both channels when both are configured', () => {
    const selection = createAlertSinkFromEnv(
      {
        ALERT_WEBHOOK_URL: 'https://example.test/hook',
        ALERT_SMS_TO: '+46700000000',
        ELKS_API_USERNAME: 'u',
        ELKS_API_PASSWORD: 'p',
        SMS_FROM: 'Photografic',
      },
      { logger: silent() },
    );

    expect(selection.kinds).toEqual(['webhook', 'sms']);
    expect(selection.logOnly).toBe(false);
  });

  it('rejects an unknown severity rather than guessing what was meant', () => {
    expect(() =>
      createAlertSinkFromEnv(
        { ALERT_WEBHOOK_URL: 'https://example.test/hook', ALERT_WEBHOOK_MIN_SEVERITY: 'loud' },
        { logger: silent() },
      ),
    ).toThrow('Okänd larmnivå');
  });
});
