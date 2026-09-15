/**
 * The providers, against a fake `fetch`.
 *
 * The request shape is the contract with the provider and the error handling is the
 * contract with everyone else — chiefly that a failure is loud and that nothing the
 * provider said about the recipient reaches the person who typed the address.
 */

import { describe, expect, it, vi } from 'vitest';

import { ElksSmsSender } from './elks.js';
import { DeliveryError } from './errors.js';
import { LogCodeSender } from './log-sender.js';
import { ResendEmailSender } from './resend.js';

function respond(status: number, body = ''): Response {
  return new Response(body, { status });
}

/** Typed so `mock.calls[0]` is the real argument tuple rather than `[]`. */
function stubFetch(handler: (url: string, init: RequestInit) => Promise<Response>) {
  return vi.fn((url: string, init: RequestInit) => handler(url, init));
}

/** The rejection, or a failure saying there wasn't one. Never the success value. */
async function failureOf(run: () => Promise<unknown>): Promise<DeliveryError> {
  const caught = await run().then(
    () => null,
    (error: unknown) => error as DeliveryError,
  );
  if (!caught) throw new Error('expected the send to fail');
  return caught;
}

describe('ResendEmailSender', () => {
  it('posts the rendered email to the recipient', async () => {
    const fetchImpl = stubFetch(async () => respond(200, '{"id":"x"}'));
    const sender = new ResendEmailSender({
      apiKey: 'key_123',
      from: 'Photographic <hej@photographic.me>',
      fetch: fetchImpl,
    });

    await sender.send({ channel: 'email', destination: 'jacob@example.com', code: '424242' });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0]!;

    expect(url).toBe('https://api.resend.com/emails');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer key_123');

    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body.to).toEqual(['jacob@example.com']);
    expect(body.from).toBe('Photographic <hej@photographic.me>');
    expect(body.subject).toContain('424242');
    expect(body.text).toContain('424242');
    expect(body.html).toContain('424242');
    expect(body).not.toHaveProperty('reply_to');
  });

  it('includes a reply-to only when there is one', async () => {
    const fetchImpl = stubFetch(async () => respond(200));
    await new ResendEmailSender({
      apiKey: 'k',
      from: 'a@b.se',
      replyTo: 'svar@b.se',
      fetch: fetchImpl,
    }).send({ channel: 'email', destination: 'c@d.se', code: '1' });

    const body = JSON.parse(fetchImpl.mock.calls[0]![1].body as string) as Record<string, unknown>;
    expect(body.reply_to).toBe('svar@b.se');
  });

  it('fails loudly when the provider refuses', async () => {
    const sender = new ResendEmailSender({
      apiKey: 'k',
      from: 'a@b.se',
      fetch: async () => respond(422, '{"message":"domain not verified"}'),
    });

    await expect(
      sender.send({ channel: 'email', destination: 'c@d.se', code: '1' }),
    ).rejects.toBeInstanceOf(DeliveryError);
  });

  it('keeps the provider’s words out of the message a person sees', async () => {
    const sender = new ResendEmailSender({
      apiKey: 'k',
      from: 'a@b.se',
      fetch: async () => respond(422, 'recipient c@d.se rejected for domain b.se'),
    });

    const error = await failureOf(() =>
      sender.send({ channel: 'email', destination: 'c@d.se', code: '1' }),
    );

    expect(error.message).toBe('Koden kunde inte skickas just nu. Försök igen om en stund.');
    expect(error.message).not.toContain('c@d.se');
    // Still recoverable from the log, which is where an operator needs it.
    expect(error.detail).toContain('recipient c@d.se rejected');
  });

  it('turns a transport failure into the same error rather than a stack trace', async () => {
    const sender = new ResendEmailSender({
      apiKey: 'k',
      from: 'a@b.se',
      fetch: async () => {
        throw new Error('ECONNRESET');
      },
    });

    const error = await failureOf(() =>
      sender.send({ channel: 'email', destination: 'c@d.se', code: '1' }),
    );

    expect(error).toBeInstanceOf(DeliveryError);
    expect(error.detail).toContain('ECONNRESET');
  });
});

describe('ElksSmsSender', () => {
  it('posts form-encoded with basic auth', async () => {
    const fetchImpl = stubFetch(async () => respond(200));
    await new ElksSmsSender({
      username: 'u',
      password: 'p',
      from: 'Photograph',
      fetch: fetchImpl,
    }).send({ channel: 'sms', destination: '+46701234567', code: '424242' });

    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe('https://api.46elks.com/a1/sms');
    expect((init.headers as Record<string, string>).authorization).toBe(
      `Basic ${Buffer.from('u:p').toString('base64')}`,
    );

    const form = new URLSearchParams(init.body as string);
    expect(form.get('to')).toBe('+46701234567');
    expect(form.get('from')).toBe('Photograph');
    expect(form.get('message')).toContain('424242');
  });

  it('fails loudly when the provider refuses', async () => {
    await expect(
      new ElksSmsSender({
        username: 'u',
        password: 'p',
        from: 'P',
        fetch: async () => respond(401, 'bad credentials'),
      }).send({ channel: 'sms', destination: '+46701234567', code: '1' }),
    ).rejects.toBeInstanceOf(DeliveryError);
  });
});

describe('LogCodeSender', () => {
  it('writes the grepped shape that the smoke scripts depend on', async () => {
    const warn = vi.fn();
    await new LogCodeSender({ warn }).send({
      channel: 'email',
      destination: 'c@d.se',
      code: '424242',
    });

    expect(warn).toHaveBeenCalledWith('signup_code', {
      channel: 'email',
      destination: 'c@d.se',
      code: '424242',
    });
  });
});
