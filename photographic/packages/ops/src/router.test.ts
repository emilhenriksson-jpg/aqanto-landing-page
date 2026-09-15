import { describe, expect, it } from 'vitest';

import type { Alert, AlertSink, CheckResult } from './alert.js';
import { AlertRouter } from './router.js';

class RecordingSink implements AlertSink {
  readonly kind = 'recording';
  readonly sent: Alert[] = [];

  async send(alert: Alert): Promise<void> {
    this.sent.push(alert);
  }
}

const failing: CheckResult = {
  key: 'job_queue',
  status: 'failing',
  severity: 'critical',
  title: 'Jobbkön töms inte',
};
const healthy: CheckResult = { ...failing, status: 'ok', title: 'Jobbkön töms' };

function clock(start: number): { now: () => Date; advance: (ms: number) => void } {
  let at = start;
  return { now: () => new Date(at), advance: (ms) => void (at += ms) };
}

describe('AlertRouter', () => {
  it('sends once when a check starts failing, and stays quiet while it keeps failing', async () => {
    const sink = new RecordingSink();
    const time = clock(0);
    const router = new AlertRouter({ sink, cooldownMs: 60_000, now: time.now });

    await router.route([failing]);
    time.advance(1_000);
    await router.route([failing]);
    time.advance(1_000);
    await router.route([failing]);

    expect(sink.sent).toHaveLength(1);
    expect(sink.sent[0]?.resolved).toBe(false);
  });

  it('repeats after the cooldown, so a problem nobody fixed is still visible tomorrow', async () => {
    const sink = new RecordingSink();
    const time = clock(0);
    const router = new AlertRouter({ sink, cooldownMs: 60_000, now: time.now });

    await router.route([failing]);
    time.advance(59_000);
    await router.route([failing]);
    expect(sink.sent).toHaveLength(1);

    time.advance(2_000);
    await router.route([failing]);
    expect(sink.sent).toHaveLength(2);
    expect(sink.sent[1]?.failingForMs).toBe(61_000);
  });

  it('says when it recovers, because silence cannot mean two things', async () => {
    const sink = new RecordingSink();
    const time = clock(0);
    const router = new AlertRouter({ sink, now: time.now });

    await router.route([failing]);
    time.advance(120_000);
    await router.route([healthy]);

    expect(sink.sent.map((alert) => alert.resolved)).toEqual([false, true]);
    expect(sink.sent[1]?.failingForMs).toBe(120_000);
    expect(router.failingKeys).toEqual([]);
  });

  it('does not announce a recovery for something that was never failing', async () => {
    const sink = new RecordingSink();
    const router = new AlertRouter({ sink });

    await router.route([healthy]);

    expect(sink.sent).toHaveLength(0);
  });

  it('breaks the cooldown when a warning becomes critical', async () => {
    const sink = new RecordingSink();
    const time = clock(0);
    const router = new AlertRouter({ sink, cooldownMs: 3_600_000, now: time.now });

    await router.route([{ ...failing, severity: 'warning' }]);
    time.advance(1_000);
    await router.route([failing]);

    expect(sink.sent.map((alert) => alert.severity)).toEqual(['warning', 'critical']);
  });

  it('treats a check that could not run as a finding rather than as passing', async () => {
    const sink = new RecordingSink();
    const router = new AlertRouter({ sink });

    await router.route([{ ...failing, status: 'unknown', title: 'Kontrollen kunde inte köras' }]);

    expect(sink.sent).toHaveLength(1);
    expect(router.failingKeys).toEqual(['job_queue']);
  });

  it('ignores a key that is absent from the pass instead of assuming it recovered', async () => {
    const sink = new RecordingSink();
    const router = new AlertRouter({ sink });

    await router.route([failing]);
    await router.route([]);

    expect(sink.sent).toHaveLength(1);
    expect(router.failingKeys).toEqual(['job_queue']);
  });
});
