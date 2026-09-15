import { describe, expect, it } from 'vitest';

import {
  countingCodeSender,
  deliveryCheck,
  DeliveryFailureLog,
  persistenceCheck,
  runChecks,
} from './checks.js';

describe('persistenceCheck', () => {
  it('is the loudest alarm in the system when production has no database', async () => {
    const result = await persistenceCheck({
      environment: 'production',
      persistence: 'memory',
      storageKind: 'supabase',
    }).run();

    expect(result.status).toBe('failing');
    expect(result.severity).toBe('critical');
    expect(result.title).toContain('databasen');
    expect(result.detail).toContain('DATABASE_URL');
  });

  it('names storage too, since documents fall back separately from memories', async () => {
    const result = await persistenceCheck({
      environment: 'production',
      persistence: 'postgres',
      storageKind: 'local',
    }).run();

    expect(result.status).toBe('failing');
    expect(result.title).toContain('lagringen');
  });

  it('stays quiet on a laptop, where both fallbacks are the point', async () => {
    const result = await persistenceCheck({
      environment: 'development',
      persistence: 'memory',
      storageKind: 'local',
    }).run();

    expect(result.status).toBe('ok');
  });

  it('passes a production process that has both', async () => {
    const result = await persistenceCheck({
      environment: 'production',
      persistence: 'postgres',
      storageKind: 'supabase',
    }).run();

    expect(result.status).toBe('ok');
  });
});

describe('delivery failures', () => {
  it('counts a failed send on its way past and re-throws it untouched', async () => {
    const log = new DeliveryFailureLog();
    const sender = countingCodeSender(
      {
        send: async () => {
          throw new Error('46elks svarade 402');
        },
      },
      log,
    );

    await expect(
      sender.send({ channel: 'sms', destination: '+46700000000', code: '123456' }),
    ).rejects.toThrow('402');
    expect(log.countSince(60_000)).toBe(1);
  });

  it('does not count a successful send', async () => {
    const log = new DeliveryFailureLog();
    const sender = countingCodeSender({ send: async () => {} }, log);

    await sender.send({ channel: 'sms', destination: '+46700000000', code: '123456' });

    expect(log.countSince(60_000)).toBe(0);
  });

  it('forgets failures that fall out of the window, so one bad afternoon does not alarm forever', () => {
    let at = 0;
    const log = new DeliveryFailureLog({ now: () => new Date(at) });

    log.record('sms');
    log.record('sms');
    at = 20 * 60_000;
    log.record('sms');

    expect(log.countSince(15 * 60_000)).toBe(1);
  });

  it('alarms only once the threshold is crossed inside the window', async () => {
    const log = new DeliveryFailureLog();
    const check = deliveryCheck({ log, threshold: 3 });

    log.record('sms');
    log.record('sms');
    expect((await check.run()).status).toBe('ok');

    log.record('sms');
    const result = await check.run();
    expect(result.status).toBe('failing');
    expect(result.severity).toBe('critical');
  });
});

describe('runChecks', () => {
  it('turns a probe that throws into a finding instead of taking the watchdog down', async () => {
    const results = await runChecks([
      {
        key: 'job_queue',
        run: async () => {
          throw new Error('connection terminated unexpectedly');
        },
      },
    ]);

    expect(results[0]?.status).toBe('unknown');
    expect(results[0]?.severity).toBe('critical');
    expect(results[0]?.detail).toContain('connection terminated');
  });
});
