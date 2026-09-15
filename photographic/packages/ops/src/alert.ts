/**
 * What an alert is, and what a check is.
 *
 * The distinction matters for everything else in this package: a **check** answers "is
 * this true right now", and an **alert** is one message about a change in that answer.
 * A check that runs every minute must not produce a message every minute, which is why
 * `AlertRouter` sits between the two and why nothing here sends anything.
 *
 * Text is Swedish, because it is read by the owner on a phone, not by a dashboard.
 */

export type Severity = 'critical' | 'warning';

/** `failing` is a real answer; `unknown` is the check itself not having worked. */
export type CheckStatus = 'ok' | 'failing' | 'unknown';

export interface CheckResult {
  /**
   * Stable across passes and across restarts. It is the dedupe key, the cooldown key
   * and what a person greps for, so it never contains an id, a timestamp or a count.
   */
  key: string;
  status: CheckStatus;
  severity: Severity;
  /** One line, Swedish, no secrets. This is the SMS body. */
  title: string;
  /** A sentence of context. Also the place to say what to do about it. */
  detail?: string;
  /** Ids, counts, ages. Never a token, a phone number or a memory body. */
  fields?: Record<string, string | number | boolean | null>;
}

export interface Check {
  key: string;
  run(): Promise<CheckResult>;
}

export interface Alert extends CheckResult {
  /** True when this says a previously failing check is now fine again. */
  resolved: boolean;
  at: Date;
  /** How long the condition had been failing when this was sent. Absent on first fire. */
  failingForMs?: number;
}

export interface AlertSink {
  /** For the boot log line that says where alerts will actually go. */
  readonly kind: string;
  send(alert: Alert): Promise<void>;
}

export function ok(input: Omit<CheckResult, 'status'>): CheckResult {
  return { ...input, status: 'ok' };
}

export function failing(input: Omit<CheckResult, 'status'>): CheckResult {
  return { ...input, status: 'failing' };
}

/**
 * One line, short enough for an SMS, complete enough to act on without opening a laptop.
 *
 * The severity word is Swedish and first, because on a locked screen the first few words
 * are all you get and "KRITISKT" is the difference between getting up and not.
 */
export function formatAlert(alert: Alert, options: { maxLength?: number } = {}): string {
  const maxLength = options.maxLength ?? 320;
  const prefix = alert.resolved
    ? 'ÅTERSTÄLLT'
    : alert.severity === 'critical'
      ? 'KRITISKT'
      : 'VARNING';

  const parts = [`[${prefix}] Photografic: ${alert.title}`];
  if (alert.detail) parts.push(alert.detail);

  const fields = Object.entries(alert.fields ?? {})
    .map(([key, value]) => `${key}=${String(value)}`)
    .join(' ');
  if (fields) parts.push(`(${fields})`);
  parts.push(`[${alert.key}]`);

  const line = parts.join(' ');
  return line.length <= maxLength ? line : `${line.slice(0, maxLength - 1)}…`;
}
