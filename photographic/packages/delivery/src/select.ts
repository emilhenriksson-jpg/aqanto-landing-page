/**
 * Chooses how a code actually reaches a person.
 *
 * The only place in this package that reads the environment, mirroring
 * `createLlmFromEnv` in `@photographic/llm` — same default-to-safe shape, same refusal
 * to half-configure: naming a provider without its credential is an error at boot, not a
 * silent fall back to the log. A process that quietly logs codes it was told to email is
 * one where nobody finds out until a person says they never got it.
 *
 * Email and SMS are chosen independently, because they will not arrive at the same time
 * and a half-configured process should still send the half it can.
 */

import type { CodeSender, SignupChannel } from '@photographic/connect';

import { ElksSmsSender } from './elks.js';
import type { DeliveryLogger } from './log-sender.js';
import { LogCodeSender, RefusingCodeSender } from './log-sender.js';
import { ResendEmailSender } from './resend.js';

export type EmailProvider = 'log' | 'resend';
export type SmsProvider = 'log' | '46elks';

export interface CodeSenderSelection {
  email: EmailProvider;
  sms: SmsProvider;
  sender: CodeSender;
  /**
   * Channels that will refuse rather than deliver, because they have no provider and
   * this is production. Empty everywhere else.
   *
   * Returned rather than only logged here, so the composition root can say it at `error`
   * level at every boot. That is what replaces a boot refusal — see `RefusingCodeSender`
   * for why the refusal is at send time instead.
   */
  inert: SignupChannel[];
}

/**
 * One sender per channel, behind the single `CodeSender` the sign-up flow knows about.
 *
 * The flow decided the channel already — it normalised the address and set
 * `channel` — so this re-reads that rather than sniffing the destination. Two places
 * deciding what an address is, is how a phone number ends up in an email API.
 */
export class ChannelCodeSender implements CodeSender {
  constructor(private readonly routes: Record<SignupChannel, CodeSender>) {}

  async send(input: { channel: SignupChannel; destination: string; code: string }): Promise<void> {
    await this.routes[input.channel].send(input);
  }
}

export function createCodeSenderFromEnv(
  env: NodeJS.ProcessEnv,
  deps: { logger: DeliveryLogger },
): CodeSenderSelection {
  // The one environment read that decides policy rather than wiring, kept here because
  // this is already the only file in the package that looks at `env`.
  const inProduction = env.NODE_ENV === 'production';

  // Two independent barriers rather than one, because they fail differently. The wrapper
  // below is what a person actually meets: the channel refuses to claim it sent anything.
  // `revealCode` is what happens if that wrapper is ever bypassed — a channel added later
  // and forgotten in `route`, a sender constructed somewhere else — and it means the worst
  // case is a code that goes nowhere rather than a code that goes into the log.
  const log = new LogCodeSender(deps.logger, { revealCode: !inProduction });

  const email = pickEmail(env, log);
  const sms = pickSms(env, log);

  const inert: SignupChannel[] = [];

  const route = (channel: SignupChannel, kind: string, sender: CodeSender): CodeSender => {
    if (!inProduction || kind !== 'log') return sender;
    inert.push(channel);
    return new RefusingCodeSender(deps.logger, channel);
  };

  return {
    email: email.kind,
    sms: sms.kind,
    sender: new ChannelCodeSender({
      email: route('email', email.kind, email.sender),
      sms: route('sms', sms.kind, sms.sender),
    }),
    inert,
  };
}

function pickEmail(
  env: NodeJS.ProcessEnv,
  log: CodeSender,
): { kind: EmailProvider; sender: CodeSender } {
  const provider = (env.PHOTOGRAPHIC_MAIL ?? 'log').toLowerCase();

  if (provider === 'resend') {
    const apiKey = required(env.RESEND_API_KEY, 'PHOTOGRAPHIC_MAIL=resend requires RESEND_API_KEY.');
    const from = required(
      env.MAIL_FROM,
      'PHOTOGRAPHIC_MAIL=resend requires MAIL_FROM, e.g. "Photographic <hej@dindomän.se>". ' +
        'The domain has to be verified in Resend.',
    );
    return {
      kind: 'resend',
      sender: new ResendEmailSender({ apiKey, from, replyTo: env.MAIL_REPLY_TO }),
    };
  }

  if (provider !== 'log' && provider !== '') {
    throw new Error(`Unknown PHOTOGRAPHIC_MAIL="${provider}". Supported: log, resend.`);
  }

  return { kind: 'log', sender: log };
}

function pickSms(env: NodeJS.ProcessEnv, log: CodeSender): { kind: SmsProvider; sender: CodeSender } {
  const provider = (env.PHOTOGRAPHIC_SMS ?? 'log').toLowerCase();

  if (provider === '46elks') {
    const username = required(env.ELKS_API_USERNAME, 'PHOTOGRAPHIC_SMS=46elks requires ELKS_API_USERNAME.');
    const password = required(env.ELKS_API_PASSWORD, 'PHOTOGRAPHIC_SMS=46elks requires ELKS_API_PASSWORD.');
    const from = required(
      env.SMS_FROM,
      'PHOTOGRAPHIC_SMS=46elks requires SMS_FROM (up to 11 alphanumeric characters).',
    );
    return { kind: '46elks', sender: new ElksSmsSender({ username, password, from }) };
  }

  if (provider !== 'log' && provider !== '') {
    throw new Error(`Unknown PHOTOGRAPHIC_SMS="${provider}". Supported: log, 46elks.`);
  }

  return { kind: 'log', sender: log };
}

function required(value: string | undefined, message: string): string {
  if (!value) throw new Error(message);
  return value;
}
