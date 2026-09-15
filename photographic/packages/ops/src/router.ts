/**
 * Turns a check that is failing every minute into a message a person can stand receiving.
 *
 * Three rules, and they are the whole design:
 *
 * 1. **Fire on the change, not the state.** The first pass that sees a check fail sends.
 * 2. **Repeat slowly.** While it keeps failing, resend once per cooldown (an hour), so a
 *    problem nobody has fixed is still visible tomorrow without being a flood today.
 * 3. **Say when it stops.** A recovery message is not politeness: without it, the owner
 *    cannot tell "still broken" from "fixed and I never heard".
 *
 * State lives in the process, which is the right size for a one-machine deployment. The
 * consequence is honest and worth writing down: a restart re-fires everything that is
 * still failing. That is the safe direction — a duplicate message costs nothing, and a
 * restart is exactly when a person should hear that the process came back into a broken
 * state.
 */

import type { Alert, AlertSink, CheckResult, Severity } from './alert.js';

interface TrackedState {
  failingSince: Date;
  lastSentAt: Date;
  severity: Severity;
}

export interface AlertRouterOptions {
  sink: AlertSink;
  /** How long before a still-failing check is repeated. Default one hour. */
  cooldownMs?: number;
  now?: () => Date;
}

export class AlertRouter {
  private readonly failing = new Map<string, TrackedState>();
  private readonly cooldownMs: number;
  private readonly now: () => Date;

  constructor(private readonly options: AlertRouterOptions) {
    this.cooldownMs = options.cooldownMs ?? 60 * 60 * 1000;
    this.now = options.now ?? (() => new Date());
  }

  /** Keys currently considered failing. For a status line, and for tests. */
  get failingKeys(): string[] {
    return [...this.failing.keys()];
  }

  /**
   * One pass. Feed every result, including the ones that are fine — a result that is
   * missing is not treated as recovered, because "the check did not run" and "the check
   * passed" must never collapse into the same thing.
   *
   * Returns what was sent, so a caller can log or assert on it.
   */
  async route(results: CheckResult[]): Promise<Alert[]> {
    const at = this.now();
    const sent: Alert[] = [];

    for (const result of results) {
      const tracked = this.failing.get(result.key);

      if (result.status === 'ok') {
        if (!tracked) continue;
        this.failing.delete(result.key);
        const alert: Alert = {
          ...result,
          severity: tracked.severity,
          resolved: true,
          at,
          failingForMs: at.getTime() - tracked.failingSince.getTime(),
        };
        await this.options.sink.send(alert);
        sent.push(alert);
        continue;
      }

      // `unknown` is a failure of the check, not of the thing checked, and it is carried
      // here rather than dropped: a probe that cannot run is how a silent failure stays
      // silent. The check itself decides how loudly to say so via `severity`.
      if (!tracked) {
        this.failing.set(result.key, {
          failingSince: at,
          lastSentAt: at,
          severity: result.severity,
        });
        const alert: Alert = { ...result, resolved: false, at };
        await this.options.sink.send(alert);
        sent.push(alert);
        continue;
      }

      const escalated = tracked.severity === 'warning' && result.severity === 'critical';
      const due = at.getTime() - tracked.lastSentAt.getTime() >= this.cooldownMs;
      if (!escalated && !due) continue;

      tracked.lastSentAt = at;
      tracked.severity = result.severity;
      const alert: Alert = {
        ...result,
        resolved: false,
        at,
        failingForMs: at.getTime() - tracked.failingSince.getTime(),
      };
      await this.options.sink.send(alert);
      sent.push(alert);
    }

    return sent;
  }
}
