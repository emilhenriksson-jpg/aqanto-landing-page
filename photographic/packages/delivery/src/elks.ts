/**
 * SMS over 46elks.
 *
 * Swedish provider, form-encoded POST, HTTP basic auth — the same shape as `resend.ts`
 * and for the same reason: one request does not justify a dependency.
 *
 * Here because the sign-up flow already has a phone channel (`normalisePhone`,
 * `channel: 'sms'`). Leaving that on the log sender while email became real would be a
 * silent asymmetry: the form would accept a number, claim to have sent something, and
 * the code would exist only in a log nobody outside the machine can read.
 */

import type { SignupChannel } from '@photographic/connect';

import { DeliveryError } from './errors.js';
import { codeSms } from './message.js';
import type { FetchLike } from './resend.js';

export interface ElksSmsSenderOptions {
  username: string;
  password: string;
  /** Sender name (max 11 alphanumeric characters) or a number you own at 46elks. */
  from: string;
  fetch?: FetchLike;
  timeoutMs?: number;
  endpoint?: string;
}

const DEFAULT_ENDPOINT = 'https://api.46elks.com/a1/sms';

export class ElksSmsSender {
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;
  private readonly endpoint: string;

  constructor(private readonly options: ElksSmsSenderOptions) {
    this.fetchImpl = options.fetch ?? ((input, init) => fetch(input, init));
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.endpoint = options.endpoint ?? DEFAULT_ENDPOINT;
  }

  async send(input: { channel: SignupChannel; destination: string; code: string }): Promise<void> {
    const credentials = Buffer.from(`${this.options.username}:${this.options.password}`).toString(
      'base64',
    );

    let response: Response;
    try {
      response = await this.fetchImpl(this.endpoint, {
        method: 'POST',
        headers: {
          authorization: `Basic ${credentials}`,
          'content-type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({
          from: this.options.from,
          to: input.destination,
          message: codeSms({ code: input.code }),
        }).toString(),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (cause) {
      throw new DeliveryError(
        `46elks request failed: ${cause instanceof Error ? cause.message : String(cause)}`,
      );
    }

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new DeliveryError(`46elks responded ${response.status}: ${body.slice(0, 300)}`);
    }
  }
}
