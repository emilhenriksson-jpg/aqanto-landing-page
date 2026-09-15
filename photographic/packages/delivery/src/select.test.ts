/**
 * Choosing a provider.
 *
 * The case that matters most is the default: with an empty environment this has to be
 * the log sender, because that is what keeps `pnpm dev`, both e2e suites and every
 * package test running with no credentials. The case that matters second is the
 * half-configured one — a provider named without its key must stop the process, not
 * quietly log codes it was told to email.
 */

import { describe, expect, it, vi } from 'vitest';

import { DeliveryError } from './errors.js';
import { ChannelCodeSender, createCodeSenderFromEnv } from './select.js';

const logger = { warn: vi.fn() };

describe('createCodeSenderFromEnv', () => {
  it('logs by default, so nothing needs credentials to run', () => {
    const selection = createCodeSenderFromEnv({}, { logger });

    expect(selection.email).toBe('log');
    expect(selection.sms).toBe('log');
  });

  it('still logs by default outside production, which is what dev and the suites rely on', async () => {
    for (const NODE_ENV of ['development', 'test', undefined]) {
      const selection = createCodeSenderFromEnv({ ...(NODE_ENV ? { NODE_ENV } : {}) }, { logger });

      expect(selection.inert, String(NODE_ENV)).toEqual([]);
      // Resolves rather than throwing: the code goes to the log, as it always has.
      await expect(
        selection.sender.send({ channel: 'sms', destination: '+46701234567', code: '123456' }),
      ).resolves.toBeUndefined();
    }
  });

  describe('in production, a channel with no provider refuses instead of pretending', () => {
    /**
     * The shape being prevented: the form says "we sent you a code" and the code goes to
     * a log file only we can read. A person cannot tell that apart from a working signup.
     *
     * Refused at send rather than at boot on purpose — see `RefusingCodeSender`. Boot
     * refusal would take the MCP endpoint and everyone's memory down to stop new
     * signups failing, which is a strictly larger outage than the fault.
     */
    const production = { NODE_ENV: 'production' };

    it('names both channels as inert so the boot log can shout about them', () => {
      expect(createCodeSenderFromEnv(production, { logger }).inert).toEqual(['email', 'sms']);
    });

    it('refuses the send, and says enough to fix it without leaking it to the person', async () => {
      const selection = createCodeSenderFromEnv(production, { logger });

      let error: DeliveryError | null = null;
      try {
        await selection.sender.send({
          channel: 'sms',
          destination: '+46701234567',
          code: '123456',
        });
      } catch (thrown) {
        error = thrown as DeliveryError;
      }

      expect(error).toBeInstanceOf(DeliveryError);
      if (!error) throw new Error('expected a refusal');

      // What the person sees is the ordinary, retryable failure — not our configuration.
      expect(error.message).toBe('Koden kunde inte skickas just nu. Försök igen om en stund.');
      expect(error.status).toBe(502);
      // What the log gets is enough to act on.
      expect(error.detail).toContain('PHOTOGRAPHIC_SMS=46elks');
      expect(error.detail).toContain('ELKS_API_USERNAME');
      expect(error.detail).toMatch(/aldrig nått personen/);
      // And never the code itself.
      expect(error.detail).not.toContain('123456');
    });

    it('leaves a channel that does have a provider alone', async () => {
      const selection = createCodeSenderFromEnv(
        { ...production, PHOTOGRAPHIC_SMS: '46elks', ELKS_API_USERNAME: 'u', ELKS_API_PASSWORD: 'p', SMS_FROM: 'Photografic' },
        { logger },
      );

      // Only email is inert; sms is configured and must not be wrapped.
      expect(selection.inert).toEqual(['email']);
      expect(selection.sms).toBe('46elks');
    });
  });

  it('selects Resend for email when told to, and leaves sms on the log', () => {
    const selection = createCodeSenderFromEnv(
      { PHOTOGRAPHIC_MAIL: 'resend', RESEND_API_KEY: 'k', MAIL_FROM: 'a@b.se' },
      { logger },
    );

    expect(selection.email).toBe('resend');
    expect(selection.sms).toBe('log');
  });

  it('selects the two channels independently', () => {
    const selection = createCodeSenderFromEnv(
      {
        PHOTOGRAPHIC_SMS: '46elks',
        ELKS_API_USERNAME: 'u',
        ELKS_API_PASSWORD: 'p',
        SMS_FROM: 'Photograph',
      },
      { logger },
    );

    expect(selection.email).toBe('log');
    expect(selection.sms).toBe('46elks');
  });

  it('refuses to start half-configured rather than silently logging', () => {
    expect(() => createCodeSenderFromEnv({ PHOTOGRAPHIC_MAIL: 'resend' }, { logger })).toThrow(
      /RESEND_API_KEY/,
    );
    expect(() =>
      createCodeSenderFromEnv({ PHOTOGRAPHIC_MAIL: 'resend', RESEND_API_KEY: 'k' }, { logger }),
    ).toThrow(/MAIL_FROM/);
    expect(() => createCodeSenderFromEnv({ PHOTOGRAPHIC_SMS: '46elks' }, { logger })).toThrow(
      /ELKS_API_USERNAME/,
    );
  });

  it('refuses a provider it does not have', () => {
    expect(() => createCodeSenderFromEnv({ PHOTOGRAPHIC_MAIL: 'carrier-pigeon' }, { logger })).toThrow(
      /Supported: log, resend/,
    );
  });

  it('is case-insensitive about the provider name', () => {
    const selection = createCodeSenderFromEnv(
      { PHOTOGRAPHIC_MAIL: 'Resend', RESEND_API_KEY: 'k', MAIL_FROM: 'a@b.se' },
      { logger },
    );

    expect(selection.email).toBe('resend');
  });
});

describe('ChannelCodeSender', () => {
  it('routes on the channel the flow decided, not on the address', async () => {
    const email = { send: vi.fn(async () => undefined) };
    const sms = { send: vi.fn(async () => undefined) };
    const sender = new ChannelCodeSender({ email, sms });

    await sender.send({ channel: 'sms', destination: '+46701234567', code: '1' });

    expect(sms.send).toHaveBeenCalledOnce();
    expect(email.send).not.toHaveBeenCalled();
  });

  it('propagates a provider failure rather than swallowing it', async () => {
    const boom = { send: vi.fn(async () => { throw new Error('nope'); }) };
    const sender = new ChannelCodeSender({ email: boom, sms: boom });

    await expect(
      sender.send({ channel: 'email', destination: 'a@b.se', code: '1' }),
    ).rejects.toThrow('nope');
  });
});
