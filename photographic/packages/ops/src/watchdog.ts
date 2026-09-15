/**
 * The loop, and the one alarm that can fire when this process is dead.
 *
 * Everything else in this package assumes the process is running well enough to notice its
 * own problems. The machine being gone — OOM, a failed deploy, a Fly incident, a crash
 * loop — is the case that cannot be reported from inside, and it is the one this
 * deployment is most exposed to with `min_machines_running = 1`. So the watchdog also
 * *stops* doing something: it pings an external dead-man's switch on every healthy pass,
 * and the absence of that ping is what reaches a human.
 *
 * That inversion is the important part. A monitor that alerts when it hears something bad
 * cannot tell "nothing is wrong" from "nothing is left to tell me".
 */

import type { Alert, Check } from './alert.js';
import { runChecks } from './checks.js';
import type { AlertRouter } from './router.js';
import type { FetchLike, SinkLogger } from './sinks.js';

export interface HeartbeatOptions {
  /**
   * `HEARTBEAT_URL` — a check-in URL from a dead-man's-switch service (healthchecks.io,
   * Better Stack, Cronitor; the free tiers all do this). It emails or texts the owner when
   * a ping stops arriving, which is the only way "the machine is gone" reaches anyone.
   */
  url: string;
  fetch?: FetchLike;
  timeoutMs?: number;
}

export interface WatchdogPass {
  at: Date;
  failing: string[];
  criticalFailing: string[];
  sent: Alert[];
  heartbeat: 'sent' | 'withheld' | 'failed' | 'off';
}

export interface WatchdogOptions {
  checks: Check[];
  router: AlertRouter;
  logger: SinkLogger;
  heartbeat?: HeartbeatOptions;
  /** Default 60 seconds. */
  intervalMs?: number;
  now?: () => Date;
}

export interface Watchdog {
  /** One pass, for the CLI and for tests. Never throws. */
  runOnce(): Promise<WatchdogPass>;
  /** Starts the interval. The timer is unref'd so it cannot hold the process open. */
  start(): void;
  stop(): void;
}

export function createWatchdog(options: WatchdogOptions): Watchdog {
  const intervalMs = options.intervalMs ?? 60_000;
  const now = options.now ?? (() => new Date());
  let timer: NodeJS.Timeout | null = null;

  async function runOnce(): Promise<WatchdogPass> {
    const at = now();
    const results = await runChecks(options.checks);
    const bad = results.filter((result) => result.status !== 'ok');
    const criticalFailing = bad
      .filter((result) => result.severity === 'critical')
      .map((result) => result.key);

    let sent: Alert[] = [];
    try {
      sent = await options.router.route(results);
    } catch (error) {
      // The router only fails if a sink throws past `FanOutAlertSink`, which it does not,
      // but a watchdog that can be taken down by its own reporting is not a watchdog.
      options.logger.error('alert_routing_failed', {
        message: error instanceof Error ? error.message : String(error),
      });
    }

    const heartbeat = await ping(options, criticalFailing.length === 0);

    return {
      at,
      failing: bad.map((result) => result.key),
      criticalFailing,
      sent,
      heartbeat,
    };
  }

  return {
    runOnce,
    start: () => {
      if (timer) return;
      timer = setInterval(() => {
        void runOnce().catch((error: unknown) => {
          options.logger.error('watchdog_pass_failed', {
            message: error instanceof Error ? error.message : String(error),
          });
        });
      }, intervalMs);
      // Never the reason the process stays alive, and never the reason a shutdown hangs.
      timer.unref();
    },
    stop: () => {
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}

/**
 * Pings on a healthy pass, and deliberately stays silent on an unhealthy one.
 *
 * Withholding rather than sending a failure signal is chosen so the mechanism works with
 * any service: every dead-man's switch understands "no ping"; only some understand a
 * `/fail` endpoint. The cost is latency — the external monitor's own grace period decides
 * how long before it tells anyone — and that is acceptable because the in-process sinks
 * have already sent the critical alert by this point. This is the backstop for the case
 * where they cannot.
 */
async function ping(options: WatchdogOptions, healthy: boolean): Promise<WatchdogPass['heartbeat']> {
  const heartbeat = options.heartbeat;
  if (!heartbeat) return 'off';
  if (!healthy) {
    options.logger.warn('heartbeat_withheld', {
      detail: 'Kritisk kontroll faller: pulsen skickas inte, så den externa vakten larmar.',
    });
    return 'withheld';
  }

  const fetchImpl = heartbeat.fetch ?? ((url: string, init?: RequestInit) => globalThis.fetch(url, init));
  try {
    const response = await fetchImpl(heartbeat.url, {
      method: 'POST',
      signal: AbortSignal.timeout(heartbeat.timeoutMs ?? 10_000),
    });
    if (!response.ok) {
      options.logger.warn('heartbeat_rejected', { status: response.status });
      return 'failed';
    }
    return 'sent';
  } catch (error) {
    // Not alerted on: the usual cause is our own network, and the monitor on the other end
    // is about to notice the missing ping anyway.
    options.logger.warn('heartbeat_failed', {
      message: error instanceof Error ? error.message : String(error),
    });
    return 'failed';
  }
}

export function heartbeatFromEnv(env: NodeJS.ProcessEnv): HeartbeatOptions | null {
  const url = env.HEARTBEAT_URL?.trim();
  return url ? { url } : null;
}
