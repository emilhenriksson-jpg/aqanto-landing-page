/**
 * Where an alert actually goes.
 *
 * The bar for this package is "reaches a human", so the sinks are the two things that do
 * that for a one-machine deployment with one owner — a webhook into whatever chat app is
 * already on the owner's phone, and an SMS for the ones worth waking up for — plus the
 * log, which reaches nobody and is therefore only ever a default to complain about.
 *
 * Severity is filtered per sink rather than globally: an SMS costs money and interrupts,
 * so it carries `critical` only by default, while the webhook carries everything. That
 * split is the whole reason `Severity` exists.
 *
 * Nothing here retries. A sink that fails is logged and the next pass will try again with
 * the same alert, because the condition is still failing — the retry loop is the watchdog,
 * not a queue in here.
 */

import type { Alert, AlertSink, Severity } from './alert.js';
import { formatAlert } from './alert.js';

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface SinkLogger {
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

const SEVERITY_ORDER: Record<Severity, number> = { warning: 10, critical: 20 };

function atLeast(severity: Severity, minimum: Severity): boolean {
  return SEVERITY_ORDER[severity] >= SEVERITY_ORDER[minimum];
}

// ---------------------------------------------------------------------------
// The log, which is not an alert
// ---------------------------------------------------------------------------

/**
 * Writes the alert to the process log.
 *
 * Present so that a laptop and a test have somewhere to send, and so that every alert is
 * *also* in the log next to the request that caused it. It is not an alerting channel:
 * every failure this package exists for was already in the log and still had to be found
 * by a human noticing something looked wrong.
 */
export class LogAlertSink implements AlertSink {
  readonly kind = 'log';

  constructor(private readonly logger: SinkLogger) {}

  async send(alert: Alert): Promise<void> {
    const fields = { key: alert.key, resolved: alert.resolved, ...alert.fields };
    if (alert.resolved || alert.severity === 'warning') this.logger.warn('alert', fields);
    else this.logger.error('alert', fields);
  }
}

// ---------------------------------------------------------------------------
// Webhook
// ---------------------------------------------------------------------------

export interface WebhookAlertSinkOptions {
  url: string;
  /** Sent as `Authorization: Bearer …` when present. For ntfy and the like. */
  token?: string;
  minSeverity?: Severity;
  fetch?: FetchLike;
  timeoutMs?: number;
}

/**
 * Posts one JSON object per alert.
 *
 * The body carries `text` *and* `content` with the same string, which is not sloppiness:
 * Slack incoming webhooks read `text`, Discord reads `content`, and ntfy takes the raw
 * body — so one shape works with all three and the owner picks the app rather than the
 * code picking it for them. The structured fields ride along beside them for anything
 * that stores the payload.
 */
export class WebhookAlertSink implements AlertSink {
  readonly kind = 'webhook';
  private readonly minSeverity: Severity;
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;

  constructor(private readonly options: WebhookAlertSinkOptions) {
    this.minSeverity = options.minSeverity ?? 'warning';
    this.fetchImpl = options.fetch ?? ((url, init) => globalThis.fetch(url, init));
    this.timeoutMs = options.timeoutMs ?? 10_000;
  }

  async send(alert: Alert): Promise<void> {
    if (!atLeast(alert.severity, this.minSeverity)) return;

    const text = formatAlert(alert, { maxLength: 1000 });
    const response = await this.fetchImpl(this.options.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(this.options.token ? { authorization: `Bearer ${this.options.token}` } : {}),
      },
      body: JSON.stringify({
        text,
        content: text,
        key: alert.key,
        severity: alert.severity,
        resolved: alert.resolved,
        at: alert.at.toISOString(),
        fields: alert.fields ?? {},
      }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`Larm-webhook svarade ${response.status}: ${body.slice(0, 200)}`);
    }
  }
}

// ---------------------------------------------------------------------------
// SMS
// ---------------------------------------------------------------------------

export interface SmsAlertSinkOptions {
  username: string;
  password: string;
  /** Sender name, up to 11 alphanumeric characters. `SMS_FROM`, same as sign-up. */
  from: string;
  /** The owner's number, in E.164. `ALERT_SMS_TO`. */
  to: string;
  minSeverity?: Severity;
  fetch?: FetchLike;
  timeoutMs?: number;
  endpoint?: string;
}

const ELKS_ENDPOINT = 'https://api.46elks.com/a1/sms';

/**
 * SMS over 46elks, the same provider sign-up codes go through.
 *
 * A deliberate copy of the six lines in `@photographic/delivery`'s `ElksSmsSender` rather
 * than a reuse of it: that class exists to send a *sign-up code*, formats its body through
 * `codeSms`, and takes the recipient from the person signing up. An alert is not a code
 * and its recipient is not a user, so sharing the class would mean either a
 * `channel: 'sms'` argument that means nothing here or a message formatter that has to
 * know about both. The credentials are shared, which is the part that matters
 * operationally — one 46elks account, one place to rotate.
 */
export class SmsAlertSink implements AlertSink {
  readonly kind = 'sms';
  private readonly minSeverity: Severity;
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;
  private readonly endpoint: string;

  constructor(private readonly options: SmsAlertSinkOptions) {
    // Critical only, by default. A warning that costs money and buzzes a phone at 03:00
    // gets muted, and a muted channel is worse than no channel because it reads as one.
    this.minSeverity = options.minSeverity ?? 'critical';
    this.fetchImpl = options.fetch ?? ((url, init) => globalThis.fetch(url, init));
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.endpoint = options.endpoint ?? ELKS_ENDPOINT;
  }

  async send(alert: Alert): Promise<void> {
    if (!atLeast(alert.severity, this.minSeverity)) return;

    const credentials = Buffer.from(`${this.options.username}:${this.options.password}`).toString(
      'base64',
    );

    const response = await this.fetchImpl(this.endpoint, {
      method: 'POST',
      headers: {
        authorization: `Basic ${credentials}`,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        from: this.options.from,
        to: this.options.to,
        // 160 characters: one SMS segment. 46elks would happily split a longer message
        // into several and bill for each, and the first segment already carries the
        // severity, the key and the number that says how bad it is.
        message: formatAlert(alert, { maxLength: 160 }),
      }).toString(),
      signal: AbortSignal.timeout(this.timeoutMs),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`46elks svarade ${response.status}: ${body.slice(0, 200)}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Fan-out
// ---------------------------------------------------------------------------

/**
 * Sends to every sink and never throws.
 *
 * One sink failing must not stop another from delivering: the whole point of having two
 * is that the webhook and the SMS fail for different reasons. A sink's own failure is
 * logged rather than alerted on, because alerting about the alerting is how a loop starts.
 */
export class FanOutAlertSink implements AlertSink {
  readonly kind: string;

  constructor(
    private readonly sinks: AlertSink[],
    private readonly logger: SinkLogger,
  ) {
    this.kind = sinks.map((sink) => sink.kind).join('+') || 'none';
  }

  async send(alert: Alert): Promise<void> {
    for (const sink of this.sinks) {
      try {
        await sink.send(alert);
      } catch (error) {
        this.logger.error('alert_send_failed', {
          sink: sink.kind,
          key: alert.key,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Selection from the environment
// ---------------------------------------------------------------------------

export interface AlertSinkSelection {
  sink: AlertSink;
  /** What was configured, for one boot log line. Never a value, only a channel name. */
  kinds: string[];
  /**
   * True when nothing but the log is configured. The caller says this loudly in
   * production rather than this function refusing: alerting that cannot be delivered is
   * bad, and a process that will not boot because of it is worse — it would take the
   * memory offline to protect the monitoring of the memory.
   */
  logOnly: boolean;
}

/**
 * Reads the environment once, the same shape as `createCodeSenderFromEnv` and
 * `createLlmFromEnv`: naming a channel without its credential is an error at boot rather
 * than a silent fall back to the log, because a silent fall back to the log is precisely
 * the failure this package exists to end.
 *
 * | Variable | Where it lives | What it does |
 * | --- | --- | --- |
 * | `ALERT_WEBHOOK_URL` | Fly secret | Chat webhook (Slack, Discord, ntfy). Gets everything. |
 * | `ALERT_WEBHOOK_TOKEN` | Fly secret, optional | `Authorization: Bearer` for the above. |
 * | `ALERT_SMS_TO` | Fly secret | Owner's number in E.164. Gets `critical` only. |
 * | `ELKS_API_USERNAME`, `ELKS_API_PASSWORD`, `SMS_FROM` | Fly secrets | Shared with sign-up codes. |
 * | `ALERT_WEBHOOK_MIN_SEVERITY`, `ALERT_SMS_MIN_SEVERITY` | Fly env, optional | `warning` or `critical`. |
 */
export function createAlertSinkFromEnv(
  env: NodeJS.ProcessEnv,
  deps: { logger: SinkLogger; fetch?: FetchLike },
): AlertSinkSelection {
  const sinks: AlertSink[] = [new LogAlertSink(deps.logger)];
  const kinds: string[] = [];

  const webhookUrl = env.ALERT_WEBHOOK_URL?.trim();
  if (webhookUrl) {
    sinks.push(
      new WebhookAlertSink({
        url: webhookUrl,
        token: env.ALERT_WEBHOOK_TOKEN,
        minSeverity: severityFromEnv(env.ALERT_WEBHOOK_MIN_SEVERITY, 'warning'),
        ...(deps.fetch ? { fetch: deps.fetch } : {}),
      }),
    );
    kinds.push('webhook');
  }

  const smsTo = env.ALERT_SMS_TO?.trim();
  if (smsTo) {
    sinks.push(
      new SmsAlertSink({
        to: smsTo,
        username: required(env.ELKS_API_USERNAME, 'ALERT_SMS_TO kräver ELKS_API_USERNAME.'),
        password: required(env.ELKS_API_PASSWORD, 'ALERT_SMS_TO kräver ELKS_API_PASSWORD.'),
        from: required(env.SMS_FROM, 'ALERT_SMS_TO kräver SMS_FROM (max 11 tecken).'),
        minSeverity: severityFromEnv(env.ALERT_SMS_MIN_SEVERITY, 'critical'),
        ...(deps.fetch ? { fetch: deps.fetch } : {}),
      }),
    );
    kinds.push('sms');
  }

  return {
    sink: new FanOutAlertSink(sinks, deps.logger),
    kinds: kinds.length > 0 ? kinds : ['log'],
    logOnly: kinds.length === 0,
  };
}

function severityFromEnv(value: string | undefined, fallback: Severity): Severity {
  if (value === 'critical' || value === 'warning') return value;
  if (value !== undefined && value.trim() !== '') {
    throw new Error(`Okänd larmnivå "${value}". Använd warning eller critical.`);
  }
  return fallback;
}

function required(value: string | undefined, message: string): string {
  if (!value) throw new Error(message);
  return value;
}
