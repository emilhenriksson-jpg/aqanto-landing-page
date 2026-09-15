/**
 * The whole chain, over a real socket.
 *
 * `ChannelCodeSender` → `ResendEmailSender` → HTTP, against a server that records what
 * arrived. The unit tests above stub `fetch`, which proves the request is built correctly
 * and nothing about whether it can be sent; this is the one that would catch a body that
 * does not survive serialisation or a header the runtime rejects.
 *
 * It also pins the property the whole feature exists for, and the one that is easiest to
 * lose in a refactor: the code that arrives in the inbox is the code that verifies.
 *
 * The email half is driven through the port rather than through `requestCode`, because
 * sign-up no longer accepts an address: a mobile number is the only way in. That is a
 * decision about what the interface offers, and this file is the evidence that the
 * capability underneath it still works — so re-offering email later is a change to one
 * function and not a rebuild.
 */

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import type { PendingCode } from '@photographic/connect';
import { hashCode, requestCode, verifyCode } from '@photographic/connect';
import { createHarness } from '@photographic/connect/testing';
import { afterEach, describe, expect, it } from 'vitest';

import { ResendEmailSender } from './resend.js';
import { ChannelCodeSender } from './select.js';

interface Captured {
  authorization: string | undefined;
  body: Record<string, unknown>;
}

let server: Server | undefined;

afterEach(async () => {
  if (server) await new Promise((resolve) => server?.close(resolve));
  server = undefined;
});

async function captureServer(status = 200): Promise<{ url: string; received: Captured[] }> {
  const received: Captured[] = [];

  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      received.push({
        authorization: req.headers.authorization,
        body: JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>,
      });
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(status < 400 ? '{"id":"msg_1"}' : '{"message":"nope"}');
    });
  });

  await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
  const { port } = server?.address() as AddressInfo;

  return { url: `http://127.0.0.1:${port}/emails`, received };
}

describe('a code that actually goes somewhere', () => {
  it('delivers the code that then verifies', async () => {
    const { url, received } = await captureServer();
    const h = createHarness();

    const sender = new ChannelCodeSender({
      email: new ResendEmailSender({
        apiKey: 'key_live',
        from: 'Photographic <hej@photographic.me>',
        endpoint: url,
      }),
      sms: h.deps.sender,
    });

    // The record sign-up would have written, written here because sign-up no longer takes
    // an address. Everything after this line is the same code path a person walks.
    const destination = 'jacob@example.com';
    const code = h.deps.randomCode();
    const record: PendingCode = {
      id: h.deps.randomId(),
      channel: 'email',
      destination,
      codeHash: hashCode(code, h.deps.codeSecret, destination),
      createdAt: h.now(),
      expiresAt: new Date(h.now().getTime() + 600_000),
      attempts: 0,
      consumedAt: null,
      inviteToken: null,
    };
    await h.deps.codes.insert(record);
    await sender.send({ channel: 'email', destination, code });

    expect(received).toHaveLength(1);
    expect(received[0]?.authorization).toBe('Bearer key_live');
    expect(received[0]?.body.to).toEqual([destination]);

    // The code that arrived in the mail is read back out of it, so this asserts the
    // delivered code verifies rather than that the one we generated does.
    const subject = received[0]?.body.subject as string;
    const arrived = /(\d{6})/.exec(subject)?.[1] as string;
    expect(arrived).toBeTruthy();

    const result = await verifyCode(h.deps, { requestId: record.id, code: arrived });
    expect(result.person.email).toBe(destination);
    expect(result.created).toBe(true);
  });

  it('surfaces a provider refusal instead of claiming the code was sent', async () => {
    const { url } = await captureServer(422);
    const h = createHarness();

    const sender = new ChannelCodeSender({
      email: new ResendEmailSender({ apiKey: 'k', from: 'a@b.se', endpoint: url }),
      sms: h.deps.sender,
    });

    // The alternative is a screen that says "check your mail" about a mail that was
    // never accepted, and a person who waits instead of trying again.
    await expect(
      sender.send({ channel: 'email', destination: 'jacob@example.com', code: '424242' }),
    ).rejects.toThrow(/kunde inte skickas/i);
  });

  it('routes a signup to the sms sender and never to the mail provider', async () => {
    const { url, received } = await captureServer();
    const h = createHarness();

    h.deps.sender = new ChannelCodeSender({
      email: new ResendEmailSender({ apiKey: 'k', from: 'a@b.se', endpoint: url }),
      sms: h.deps.sender,
    });

    await requestCode(h.deps, { phone: '070 123 45 67' });

    expect(received).toHaveLength(0);
    expect(h.sender.sent.at(-1)?.channel).toBe('sms');
    expect(h.sender.sent.at(-1)?.destination).toBe('+46701234567');
  });

  /**
   * There is no input that reaches the mail provider from sign-up any more.
   *
   * The interesting failure is not "email is gone" — it is not — but "email is still
   * quietly reachable from the one endpoint a stranger can call". This is the assertion
   * that would fail if an address ever finds its way back in.
   */
  it('cannot be made to send mail from a signup request', async () => {
    const { url, received } = await captureServer();
    const h = createHarness();

    h.deps.sender = new ChannelCodeSender({
      email: new ResendEmailSender({ apiKey: 'k', from: 'a@b.se', endpoint: url }),
      sms: h.deps.sender,
    });

    await expect(requestCode(h.deps, { phone: 'jacob@example.com' })).rejects.toThrow(/SMS/);

    expect(received).toHaveLength(0);
    expect(h.sender.sent).toEqual([]);
  });
});
