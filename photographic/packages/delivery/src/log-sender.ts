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

import { DeliveryError } from './errors.js';

export interface DeliveryLogger {
  warn(message: string, fields?: Record<string, unknown>): void;
}

export interface LogCodeSenderOptions {
  /**
   * Whether the code itself may be written.
   *
   * False in production, and the reason is worth stating because the class is not even
   * *selected* there: `createCodeSenderFromEnv` wraps it in `RefusingCodeSender` before it
   * can be reached. So this flag protects against the wiring, not against the environment
   * — someone constructing a `LogCodeSender` directly, a fourth channel added later that
   * routes past the selection, a test double that becomes a production path the way
   * `MemoryCodeStore` did. One class, two behaviours, and the unsafe one cannot be reached
   * by default from the composition root.
   *
   * Defaults to true so `pnpm dev`, both e2e suites and every package test keep reading
   * codes out of the log with no configuration, which is the whole reason this sender
   * exists.
   */
  revealCode?: boolean;
}

export class LogCodeSender implements CodeSender {
  private readonly revealCode: boolean;

  constructor(
    private readonly logger: DeliveryLogger,
    options: LogCodeSenderOptions = {},
  ) {
    this.revealCode = options.revealCode ?? true;
  }

  async send(input: { channel: SignupChannel; destination: string; code: string }): Promise<void> {
    // The destination is logged as well as the code, because with two people testing at
    // once "which code was mine" is otherwise a guess. Both are safe only where nobody
    // but a developer can read the log — which is what `RefusingCodeSender` enforces,
    // because this class being selected in production is not a development convenience,
    // it is a channel that silently goes nowhere.
    //
    // `signup_code` stays the message either way: `scripts/mcp-smoke.md` and
    // `e2e/src/live-mcp.smoke.test.ts` grep for it, and a line that says a code was
    // produced is still worth having where the code itself must not be.
    this.logger.warn('signup_code', {
      channel: input.channel,
      destination: input.destination,
      ...(this.revealCode ? { code: input.code } : { code: null, withheld: 'production' }),
    });
  }
}

/**
 * Stands in for the log sender in production, and refuses instead of pretending.
 *
 * A channel on `log` in production is a channel that tells a person "we sent you a code"
 * and writes it to a file only we can read. That is the silent-success shape this
 * codebase keeps removing, and it is worse here than elsewhere because the person cannot
 * tell the difference — the form behaves identically whether the SMS is on its way or
 * was never sendable.
 *
 * **Why this refuses at send rather than at boot**, which is the interesting half.
 *
 * `createCodeSenderFromEnv` refuses at boot when a provider is *named* without its
 * credential, and that is right: the operator stated an intent that cannot be honoured,
 * so there is no sensible runtime behaviour to choose. This is a different fault. `log`
 * is the default, not a contradiction — it is coherent, it works, and it is merely
 * inappropriate here. Refusing it at boot would mean any deploy where a delivery secret
 * is missing or mistyped takes down the MCP endpoint, the product screens and everyone's
 * memory, in order to prevent new signups from failing. That inverts the priority the
 * rest of this system is built around: `min_machines_running`, the health check and the
 * always-on settings all exist so that memory stays reachable.
 *
 * So the blast radius is kept to the operation that is actually broken. A person already
 * signed in is unaffected; a person trying to sign up gets the ordinary visible failure
 * (502, `Koden kunde inte skickas just nu`) and can retry, and — since a failed delivery
 * no longer spends the allowance — retrying is not rationed either. The part boot
 * refusal would have bought, being impossible to ignore, is bought instead by
 * `code_delivery_inert` at `error` level on every boot, which names the channel and the
 * variables to set.
 *
 * The person never sees the reason. `DeliveryError`'s own message is deliberately
 * generic, and the specifics go to `detail`, for the log: which channel is inert and how
 * to fix it is operator information, not something to tell whoever is trying to sign up.
 */
export class RefusingCodeSender implements CodeSender {
  constructor(
    private readonly logger: DeliveryLogger,
    private readonly channel: SignupChannel,
  ) {}

  async send(input: { channel: SignupChannel; destination: string; code: string }): Promise<void> {
    this.logger.warn('code_delivery_refused', {
      channel: input.channel,
      reason: 'no provider configured in production',
    });

    throw new DeliveryError(inertChannelDetail(this.channel));
  }
}

/**
 * The sentence an operator needs, wherever they meet it.
 *
 * Shared by the boot log and the refusal so the two cannot drift, and written to be
 * enough to act on without opening the source: which channel, why, and what to set.
 */
export function inertChannelDetail(channel: SignupChannel): string {
  const fix =
    channel === 'sms'
      ? 'Sätt PHOTOGRAPHIC_SMS=46elks med ELKS_API_USERNAME, ELKS_API_PASSWORD och SMS_FROM'
      : 'Sätt PHOTOGRAPHIC_MAIL=resend med RESEND_API_KEY och MAIL_FROM';

  return (
    `Kanalen "${channel}" har ingen leverantör i produktion, så koden skulle bara ha ` +
    `skrivits till serverloggen och aldrig nått personen. ${fix}, eller stäng av kanalen ` +
    'i gränssnittet. Koden skickades inte.'
  );
}
