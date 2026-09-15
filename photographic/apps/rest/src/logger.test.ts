/**
 * What the log is allowed to contain.
 *
 * The interesting assertions here are all negative, and one of them is the reason this
 * file exists at all: a sign-in code sat in the production log in plaintext because
 * `REDACTED_KEYS` listed `destination` and not `code`, so the log line looked careful
 * while carrying the credential. A list like that is only as good as a test that reads it
 * from the outside.
 */

import { describe, expect, it } from 'vitest';

import { createLogger, redact } from './logger.js';

function captured(options: Parameters<typeof createLogger>[0] = {}) {
  const lines: Record<string, unknown>[] = [];
  const logger = createLogger({
    level: 'debug',
    ...options,
    write: (line) => lines.push(JSON.parse(line) as Record<string, unknown>),
  });
  return { logger, lines };
}

describe('redaction', () => {
  it('never prints a sign-in code by default', () => {
    const { logger, lines } = captured();

    logger.warn('signup_code', { channel: 'sms', destination: '+46701234567', code: '424242' });

    expect(lines[0]).toMatchObject({ code: '[redacted]', destination: '[redacted]' });
    expect(JSON.stringify(lines)).not.toContain('424242');
  });

  it('redacts a code logged by anything, not just by the sender', () => {
    // The case the list is for: some future line, in some unrelated file, that logs a code
    // without thinking about it. Neither the delivery refusal nor the log sender can help
    // there, so this has to hold without either of them.
    const { logger, lines } = captured();

    logger.info('some_unrelated_thing', { code: '424242' });
    logger.error('another', { CODE: '424242' });

    expect(JSON.stringify(lines)).not.toContain('424242');
  });

  it('keeps redacting through a child logger', () => {
    const { logger, lines } = captured();

    logger.child({ requestId: 'r1' }).warn('signup_code', { code: '424242' });

    expect(lines[0]).toMatchObject({ requestId: 'r1', code: '[redacted]' });
  });

  it('lets the code through only where the log is the delivery channel', () => {
    // `pnpm dev`, `scripts/mcp-smoke.md` and the live e2e smoke all sign in by grepping
    // `signup_code` out of a file. Without this there is no way to run the product on a
    // laptop, which is why the flag exists — and why it is off unless asked for.
    const { logger, lines } = captured({ revealSignupCode: true });

    logger.warn('signup_code', { destination: '+46701234567', code: '424242' });

    expect(lines[0]).toMatchObject({ code: '424242' });
    // And the allowance is exactly one key wide: the destination stays redacted.
    expect(lines[0]).toMatchObject({ destination: '[redacted]' });
  });

  it('holds the rest of the list whatever the caller thinks it is doing', () => {
    expect(
      redact({
        authorization: 'Bearer x',
        refreshToken: 'r',
        body: 'a memory',
        phone: '+46701234567',
        roomId: 'kept',
      }),
    ).toEqual({
      authorization: '[redacted]',
      refreshToken: '[redacted]',
      body: '[redacted]',
      phone: '[redacted]',
      roomId: 'kept',
    });
  });
});
