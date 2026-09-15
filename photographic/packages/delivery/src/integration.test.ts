/**
 * The whole chain, over a real socket.
 *
 * `requestCode` → `ChannelCodeSender` → `ResendEmailSender` → HTTP, against a server
 * that records what arrived. The unit tests above stub `fetch`, which proves the request
 * is built correctly and nothing about whether it can be sent; this is the one that would
 * catch a body that does not survive serialisation or a header the runtime rejects.
 *
 * It also pins the property the whole feature exists for, and the one that is easiest to
 * lose in a refactor: the code that arrives in the inbox is the code that verifies.
 */

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { requestCode, verifyCode } from '@photographic/connect';
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

    h.deps.sender = new ChannelCodeSender({
      email: new ResendEmailSender({
        apiKey: 'key_live',
        from: 'Photographic <hej@photographic.me>',
        endpoint: url,
      }),
      sms: h.deps.sender,
    });

    const { requestId, destinationHint } = await requestCode(h.deps, { email: 'jacob@example.com' });

    expect(received).toHaveLength(1);
    expect(received[0]?.authorization).toBe('Bearer key_live');
    expect(received[0]?.body.to).toEqual(['jacob@example.com']);

    // The code is nowhere in the response the browser got, and is in the mail.
    const subject = received[0]?.body.subject as string;
    const code = /(\d{6})/.exec(subject)?.[1] as string;
    expect(code).toBeTruthy();
    expect(destinationHint).toBe('j***@example.com');

    const result = await verifyCode(h.deps, { requestId, code });
    expect(result.person.email).toBe('jacob@example.com');
    expect(result.created).toBe(true);
  });

  it('surfaces a provider refusal instead of claiming the code was sent', async () => {
    const { url } = await captureServer(422);
    const h = createHarness();

    h.deps.sender = new ChannelCodeSender({
      email: new ResendEmailSender({ apiKey: 'k', from: 'a@b.se', endpoint: url }),
      sms: h.deps.sender,
    });

    // The alternative is a screen that says "check your mail" about a mail that was
    // never accepted, and a person who waits instead of trying again.
    await expect(requestCode(h.deps, { email: 'jacob@example.com' })).rejects.toThrow(
      /kunde inte skickas/i,
    );
  });

  it('routes a phone number to the sms sender and never to the mail provider', async () => {
    const { url, received } = await captureServer();
    const h = createHarness();

    h.deps.sender = new ChannelCodeSender({
      email: new ResendEmailSender({ apiKey: 'k', from: 'a@b.se', endpoint: url }),
      sms: h.deps.sender,
    });

    await requestCode(h.deps, { phone: '070 123 45 67' });

    expect(received).toHaveLength(0);
    // E.164, with the national trunk `0` replaced by the country code rather than kept
    // behind a `+`. See `normalisePhone`; this expectation asserted the old bug.
    expect(h.sender.sent.at(-1)?.destination).toBe('+46701234567');
  });
});
