import { describe, expect, it } from 'vitest';

import type { AuthError } from '@photographic/core';
import type { Room, RoomId } from '@photographic/core';

import { createHarness } from './testing/index.js';

/** Stands in for `DeliveryError`, which lives in a package this one must not depend on. */
class DeliveryFailure extends Error {}

import {
  CODE_REJECTED,
  hashCode,
  MAX_ATTEMPTS,
  MAX_REQUESTS_PER_HOUR,
  requestCode,
  verifyCode,
} from './signup.js';

const EMAIL = 'emil@example.com';

/** The rejection, or a failure saying there wasn't one. Never the success value. */
async function failureOf(run: () => Promise<unknown>): Promise<Error> {
  const caught = await run().then(
    () => null,
    (error: unknown) => error as Error,
  );
  if (!caught) throw new Error('förväntade att verifieringen skulle avvisas');
  return caught;
}

function sharedRoom(): Room {
  return {
    id: 'room-buyersclub' as RoomId,
    kind: 'shared',
    slug: 'buyersclub-ledning',
    title: 'Buyersclub Ledning',
    description: null,
    sensitivity: 'normal',
    createdBy: 'person-9' as Room['createdBy'],
    createdAt: new Date(),
    archivedAt: null,
  };
}

describe('requesting a code', () => {
  it('sends a code and returns a request id without the code in it', async () => {
    const h = createHarness({ fixedCode: '424242' });
    const result = await requestCode(h.deps, { email: EMAIL });

    expect(h.sender.lastCode).toBe('424242');
    expect(JSON.stringify(result)).not.toContain('424242');
    expect(result.channel).toBe('email');
  });

  it('masks the destination it echoes back', async () => {
    const h = createHarness();
    const result = await requestCode(h.deps, { email: EMAIL });
    expect(result.destinationHint).toBe('e***@example.com');
    expect(result.destinationHint).not.toContain('mil@');
  });

  it('never persists the raw code', async () => {
    const h = createHarness({ fixedCode: '424242' });
    const { requestId } = await requestCode(h.deps, { email: EMAIL });

    const stored = h.codes.raw(requestId);
    expect(stored).toBeDefined();
    expect(JSON.stringify(stored)).not.toContain('424242');
    expect(stored?.codeHash).toBe(hashCode('424242', 'test-secret', EMAIL));
  });

  it('binds the hash to the destination so a code cannot be replayed elsewhere', () => {
    expect(hashCode('424242', 's', 'a@example.com')).not.toBe(
      hashCode('424242', 's', 'b@example.com'),
    );
  });

  it('normalises email and phone', async () => {
    const h = createHarness();
    const byEmail = await requestCode(h.deps, { email: '  EMIL@Example.COM ' });
    expect(h.codes.raw(byEmail.requestId)?.destination).toBe(EMAIL);

    const byPhone = await requestCode(h.deps, { phone: '070 123 45 67' });
    expect(h.codes.raw(byPhone.requestId)?.destination).toBe('+46701234567');
    expect(byPhone.channel).toBe('sms');
  });

  /**
   * This used to assert `+0701234567`, which is the bug rather than the behaviour.
   *
   * The leading `0` is a national trunk prefix and is *replaced* by the country code,
   * not kept — so prefixing `+` produced a number valid in no country. It survived
   * because the expectation was written from what the code did, and because the log
   * sender accepts any destination, so nothing downstream ever objected. It would have
   * become visible as "I never got the SMS" the day a real provider was switched on.
   */
  it('reaches one destination however a Swede types their own number', async () => {
    const h = createHarness();
    const typed = ['070-123 45 67', '0701234567', '+46701234567', '+46 70 123 45 67', '0046701234567'];

    for (const phone of typed) {
      const requested = await requestCode(h.deps, { phone });
      expect(h.codes.raw(requested.requestId)?.destination, phone).toBe('+46701234567');
    }
  });

  it('keeps a number that already carries another country code', async () => {
    const h = createHarness();
    const requested = await requestCode(h.deps, { phone: '+1 202 555 0143' });
    expect(h.codes.raw(requested.requestId)?.destination).toBe('+12025550143');
  });

  it('refuses a number no provider could send to, rather than claiming it sent', async () => {
    const h = createHarness();
    // `+0…` is what the old normaliser produced. No country code starts with zero, so
    // this is the guard that stops a trunk prefix reaching the provider.
    for (const phone of ['+0701234567', '0', '070-123']) {
      await expect(requestCode(h.deps, { phone }), phone).rejects.toThrow(/Ogiltigt telefonnummer/i);
    }
  });

  it('does not spend the allowance on a code that was never delivered', async () => {
    const h = createHarness();
    const failing = {
      send: async () => {
        throw new DeliveryFailure();
      },
    };

    // Every attempt fails at the provider, and there are more of them than the limit.
    for (let i = 0; i < MAX_REQUESTS_PER_HOUR + 2; i += 1) {
      await expect(
        requestCode({ ...h.deps, sender: failing }, { phone: '0701234567' }),
      ).rejects.toBeInstanceOf(DeliveryFailure);
    }

    // The person is exactly where they started: nothing counted, nothing stored, and the
    // next attempt is a delivery question rather than a lockout. Before this, six failed
    // sends left them locked out for an hour over an outage they could not see.
    expect(await h.codes.countSince('+46701234567', new Date(0))).toBe(0);

    const recovered = await requestCode(h.deps, { phone: '0701234567' });
    expect(recovered.channel).toBe('sms');
  });

  it('keeps counting requests that did reach someone', async () => {
    const h = createHarness();
    for (let i = 0; i < MAX_REQUESTS_PER_HOUR; i += 1) {
      await requestCode(h.deps, { phone: '0701234567' });
    }

    await expect(requestCode(h.deps, { phone: '0701234567' })).rejects.toThrow(/För många försök/i);
  });

  it('rejects a request with neither email nor phone', async () => {
    const h = createHarness();
    await expect(requestCode(h.deps, {})).rejects.toThrow(/e-post eller telefon/i);
  });

  it('rejects a malformed email', async () => {
    const h = createHarness();
    await expect(requestCode(h.deps, { email: 'not-an-email' })).rejects.toThrow(/Ogiltig/i);
  });

  it('rate limits per destination', async () => {
    const h = createHarness();
    for (let i = 0; i < MAX_REQUESTS_PER_HOUR; i += 1) {
      await requestCode(h.deps, { email: EMAIL });
    }
    await expect(requestCode(h.deps, { email: EMAIL })).rejects.toThrow(/För många försök/i);

    // A different address is unaffected.
    await expect(requestCode(h.deps, { email: 'jacob@example.com' })).resolves.toBeTruthy();
  });

  it('lets the window expire', async () => {
    const h = createHarness();
    for (let i = 0; i < MAX_REQUESTS_PER_HOUR; i += 1) {
      await requestCode(h.deps, { email: EMAIL });
    }
    h.setNow(new Date(h.now().getTime() + 61 * 60 * 1000));
    await expect(requestCode(h.deps, { email: EMAIL })).resolves.toBeTruthy();
  });
});

describe('verifying a code', () => {
  it('creates the person and their personal room in one step', async () => {
    const h = createHarness({ fixedCode: '424242' });
    const { requestId } = await requestCode(h.deps, { email: EMAIL });

    const result = await verifyCode(h.deps, { requestId, code: '424242' });

    expect(result.created).toBe(true);
    expect(result.person.email).toBe(EMAIL);
    expect(result.personalRoom.kind).toBe('personal');
    expect(result.session.token).toContain(result.person.id);
  });

  it('logs an existing person back in instead of creating a second one', async () => {
    const h = createHarness({ fixedCode: '424242' });
    const first = await requestCode(h.deps, { email: EMAIL });
    const created = await verifyCode(h.deps, { requestId: first.requestId, code: '424242' });

    const second = await requestCode(h.deps, { email: EMAIL });
    const returning = await verifyCode(h.deps, { requestId: second.requestId, code: '424242' });

    expect(returning.created).toBe(false);
    expect(returning.person.id).toBe(created.person.id);
    expect(returning.personalRoom.id).toBe(created.personalRoom.id);
  });

  it('rejects the wrong code and counts the attempt', async () => {
    const h = createHarness({ fixedCode: '424242' });
    const { requestId } = await requestCode(h.deps, { email: EMAIL });

    await expect(verifyCode(h.deps, { requestId, code: '000000' })).rejects.toThrow(CODE_REJECTED);
    expect(h.codes.raw(requestId)?.attempts).toBe(1);
    expect(h.codes.raw(requestId)?.consumedAt).toBeNull();
  });

  it('locks out after too many attempts', async () => {
    const h = createHarness({ fixedCode: '424242' });
    const { requestId } = await requestCode(h.deps, { email: EMAIL });

    for (let i = 0; i < MAX_ATTEMPTS; i += 1) {
      await expect(verifyCode(h.deps, { requestId, code: '000000' })).rejects.toThrow();
    }
    // Even the right code is refused once the attempt budget is gone.
    await expect(verifyCode(h.deps, { requestId, code: '424242' })).rejects.toThrow(CODE_REJECTED);
  });

  it('stops counting attempts once the budget is gone', async () => {
    // Otherwise the counter climbs forever on a row nobody can use, and a flood against
    // one request id is a write per guess.
    const h = createHarness({ fixedCode: '424242' });
    const { requestId } = await requestCode(h.deps, { email: EMAIL });

    for (let i = 0; i < MAX_ATTEMPTS + 3; i += 1) {
      await expect(verifyCode(h.deps, { requestId, code: '000000' })).rejects.toThrow();
    }

    expect(h.codes.raw(requestId)?.attempts).toBe(MAX_ATTEMPTS);
  });

  it('rejects an expired code', async () => {
    const h = createHarness({ fixedCode: '424242' });
    const { requestId } = await requestCode(h.deps, { email: EMAIL });

    h.setNow(new Date(h.now().getTime() + 11 * 60 * 1000));
    await expect(verifyCode(h.deps, { requestId, code: '424242' })).rejects.toThrow(CODE_REJECTED);
  });

  it('refuses to reuse a code', async () => {
    const h = createHarness({ fixedCode: '424242' });
    const { requestId } = await requestCode(h.deps, { email: EMAIL });

    await verifyCode(h.deps, { requestId, code: '424242' });
    await expect(verifyCode(h.deps, { requestId, code: '424242' })).rejects.toThrow(CODE_REJECTED);
  });

  it('rejects an unknown request id', async () => {
    const h = createHarness();
    await expect(verifyCode(h.deps, { requestId: 'nope', code: '424242' })).rejects.toThrow(
      CODE_REJECTED,
    );
  });

  it('answers every failure identically, so none of them is a probe', async () => {
    // A publicly reachable endpoint that mints sessions. "Already used" would tell
    // someone holding a stolen request id that the code was real and the person got in;
    // "expired" would tell them when to stop guessing. Both are the same sentence here,
    // and this is the test that keeps them that way.
    const h = createHarness({ fixedCode: '424242' });

    const wrongId = (await requestCode(h.deps, { email: EMAIL })).requestId;
    const wrong = await failureOf(() => verifyCode(h.deps, { requestId: wrongId, code: '000000' }));

    const usedId = (await requestCode(h.deps, { email: 'a@example.com' })).requestId;
    await verifyCode(h.deps, { requestId: usedId, code: '424242' });
    const used = await failureOf(() => verifyCode(h.deps, { requestId: usedId, code: '424242' }));

    const expiredId = (await requestCode(h.deps, { email: 'b@example.com' })).requestId;
    h.setNow(new Date(h.now().getTime() + 11 * 60 * 1000));
    const expired = await failureOf(() =>
      verifyCode(h.deps, { requestId: expiredId, code: '424242' }),
    );

    const unknown = await failureOf(() =>
      verifyCode(h.deps, { requestId: 'nope', code: '424242' }),
    );

    const failures = [wrong, used, expired, unknown];
    expect(new Set(failures.map((e) => e.message))).toEqual(new Set([CODE_REJECTED]));
    expect(new Set(failures.map((e) => (e as AuthError).status))).toEqual(new Set([401]));
  });
});

describe('the invited person', () => {
  it('joins the room and gets a personal room without a separate signup step', async () => {
    const h = createHarness({ fixedCode: '424242' });
    h.invites.seed('invite-token-1', sharedRoom());

    const { requestId } = await requestCode(h.deps, {
      email: 'jacob@example.com',
      inviteToken: 'invite-token-1',
    });
    const result = await verifyCode(h.deps, { requestId, code: '424242' });

    expect(result.created).toBe(true);
    expect(result.personalRoom.kind).toBe('personal');
    expect(result.joinedRoom?.room.title).toBe('Buyersclub Ledning');
    expect(result.joinedRoom?.role).toBe('editor');
    expect(h.invites.accepted).toEqual([
      { token: 'invite-token-1', personId: result.person.id },
    ]);
  });

  it('still signs the person in when there is no invite', async () => {
    const h = createHarness({ fixedCode: '424242' });
    const { requestId } = await requestCode(h.deps, { email: EMAIL });
    const result = await verifyCode(h.deps, { requestId, code: '424242' });

    expect(result.joinedRoom).toBeNull();
    expect(h.invites.accepted).toEqual([]);
  });
});
