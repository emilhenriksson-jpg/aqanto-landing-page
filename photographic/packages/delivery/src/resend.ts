/**
 * Email over Resend's HTTP API.
 *
 * `fetch` and no SDK, because the whole call is one POST with a JSON body and adding a
 * dependency to avoid writing it would be the more expensive choice. It also keeps the
 * seam honest: `fetch` is injectable, so the tests below exercise the real request shape
 * and the real error handling rather than a mocked client object.
 *
 * Resend specifically is not load-bearing. Everything here is behind `CodeSender`, so
 * moving to Postmark, SES or plain SMTP is a new file next to this one and one line in
 * `select.ts`.
 */

import type { SignupChannel } from '@photographic/connect';

import { DeliveryError } from './errors.js';
import { codeEmail } from './message.js';

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export interface ResendEmailSenderOptions {
  apiKey: string;
  /** `Namn <adress@domän>` or a bare address. The domain must be verified in Resend. */
  from: string;
  replyTo?: string | undefined;
  fetch?: FetchLike;
  /** Exposed for tests; a code is worthless after ten minutes, so this stays short. */
  timeoutMs?: number;
  endpoint?: string;
}

const DEFAULT_ENDPOINT = 'https://api.resend.com/emails';

export class ResendEmailSender {
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;
  private readonly endpoint: string;

  constructor(private readonly options: ResendEmailSenderOptions) {
    this.fetchImpl = options.fetch ?? ((input, init) => fetch(input, init));
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.endpoint = options.endpoint ?? DEFAULT_ENDPOINT;
  }

  async send(input: { channel: SignupChannel; destination: string; code: string }): Promise<void> {
    const message = codeEmail({ code: input.code });

    // A hung provider must not hold the request open: the person is staring at a form
    // and would rather be told to try again than wait out a TCP timeout.
    const abort = AbortSignal.timeout(this.timeoutMs);

    let response: Response;
    try {
      response = await this.fetchImpl(this.endpoint, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.options.apiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          from: this.options.from,
          to: [input.destination],
          subject: message.subject,
          text: message.text,
          html: message.html,
          ...(this.options.replyTo ? { reply_to: this.options.replyTo } : {}),
        }),
        signal: abort,
      });
    } catch (cause) {
      throw new DeliveryError(
        `resend request failed: ${cause instanceof Error ? cause.message : String(cause)}`,
      );
    }

    if (!response.ok) {
      // Read the body for the log and then throw the generic message. Resend echoes the
      // recipient and the sending domain in its errors, and neither belongs in front of
      // whoever typed the address.
      const body = await response.text().catch(() => '');
      throw new DeliveryError(`resend responded ${response.status}: ${body.slice(0, 300)}`);
    }
  }
}
