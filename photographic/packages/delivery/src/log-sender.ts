/**
 * The default sender: writes the code where a developer can read it.
 *
 * Not a stub to be replaced — it is the one that keeps `pnpm dev`, both e2e suites and
 * every package test working with no credentials and no network. A provider that has to
 * be configured before anything runs is a provider that gets stubbed out badly in three
 * places instead.
 *
 * It is also the reason the log line is deliberately loud and deliberately structured:
 * `signup_code` is grepped by `scripts/mcp-smoke.md` and by `e2e/src/live-mcp.smoke.test.ts`,
 * so the shape is a contract, not debug output.
 */

import type { CodeSender, SignupChannel } from '@photographic/connect';

export interface DeliveryLogger {
  warn(message: string, fields?: Record<string, unknown>): void;
}

export class LogCodeSender implements CodeSender {
  constructor(private readonly logger: DeliveryLogger) {}

  async send(input: { channel: SignupChannel; destination: string; code: string }): Promise<void> {
    // The destination is logged as well as the code, because with two people testing at
    // once "which code was mine" is otherwise a guess. Both are development-only by
    // construction: this class is never selected when a provider is configured.
    this.logger.warn('signup_code', {
      channel: input.channel,
      destination: input.destination,
      code: input.code,
    });
  }
}
