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
import { LogCodeSender } from './log-sender.js';
import { ResendEmailSender } from './resend.js';

export type EmailProvider = 'log' | 'resend';
export type SmsProvider = 'log' | '46elks';

export interface CodeSenderSelection {
  email: EmailProvider;
  sms: SmsProvider;
  sender: CodeSender;
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
  const log = new LogCodeSender(deps.logger);

  const email = pickEmail(env, log);
  const sms = pickSms(env, log);

  return {
    email: email.kind,
    sms: sms.kind,
    sender: new ChannelCodeSender({ email: email.sender, sms: sms.sender }),
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
