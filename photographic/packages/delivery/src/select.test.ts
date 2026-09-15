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

import { ChannelCodeSender, createCodeSenderFromEnv } from './select.js';

const logger = { warn: vi.fn() };

describe('createCodeSenderFromEnv', () => {
  it('logs by default, so nothing needs credentials to run', () => {
    const selection = createCodeSenderFromEnv({}, { logger });

    expect(selection.email).toBe('log');
    expect(selection.sms).toBe('log');
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
