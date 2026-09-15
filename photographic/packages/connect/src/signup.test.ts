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

/** How a Swedish person writes their own number, and what it means. */
const PHONE = '070-123 45 67';
const E164 = '+46701234567';
const OTHER = '072-987 65 43';
const THIRD = '073-111 22 33';
const FOURTH = '076-444 55 66';

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
    const result = await requestCode(h.deps, { phone: PHONE });

    expect(h.sender.lastCode).toBe('424242');
    expect(JSON.stringify(result)).not.toContain('424242');
    expect(result.channel).toBe('sms');
  });

  it('sends by SMS and never by email, whatever else is configured', async () => {
    // The email sender is still in the tree and still tested; nothing can reach it from
    // here, because there is no longer an input that names an address.
    const h = createHarness();
    await requestCode(h.deps, { phone: PHONE });

    expect(h.sender.sent.map((s) => s.channel)).toEqual(['sms']);
    expect(h.sender.sent[0]?.destination).toBe(E164);
  });

  it('masks the destination it echoes back', async () => {
    const h = createHarness();
    const result = await requestCode(h.deps, { phone: PHONE });

    // Enough to recognise your own number on the code screen, not enough to read over a
    // shoulder.
    expect(result.destinationHint).toBe('070-••• 45 67');
    expect(result.destinationHint).not.toContain('123');
  });

  it('never persists the raw code', async () => {
    const h = createHarness({ fixedCode: '424242' });
    const { requestId } = await requestCode(h.deps, { phone: PHONE });

    const stored = h.codes.raw(requestId);
    expect(stored).toBeDefined();
    expect(JSON.stringify(stored)).not.toContain('424242');
    expect(stored?.codeHash).toBe(hashCode('424242', 'test-secret', E164));
  });

  it('binds the hash to the destination so a code cannot be replayed elsewhere', () => {
    expect(hashCode('424242', 's', '+46701234567')).not.toBe(
      hashCode('424242', 's', '+46729876543'),
    );
  });

  /**
   * The four shapes a Swedish number arrives in.
   *
   * A person types their own number the way they always have. Storing one of these and
   * refusing the other three would mean the same person is two accounts, or locked out of
   * the one they have, depending on which tab they happened to sign up from.
   */
  it('reads the same number whichever way it was written', async () => {
    const h = createHarness();

    for (const written of ['070-123 45 67', '0701234567', '+46 70 123 45 67', '+46701234567']) {
      const result = await requestCode(h.deps, { phone: written });
      expect(h.codes.raw(result.requestId)?.destination).toBe(E164);
      expect(result.channel).toBe('sms');
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

  it('rejects a request with no number', async () => {
    const h = createHarness();
    await expect(requestCode(h.deps, { phone: '' })).rejects.toThrow(/Ange ditt mobilnummer/i);
  });

  it('says what is wrong rather than just saying no', async () => {
    const h = createHarness();

    await expect(requestCode(h.deps, { phone: '08-123 45 67' })).rejects.toThrow(/börjar på 070/);
    await expect(requestCode(h.deps, { phone: '070-123 45' })).rejects.toThrow(/för kort/i);
    await expect(requestCode(h.deps, { phone: '+47 900 12 345' })).rejects.toThrow(/svenskt/i);
    await expect(requestCode(h.deps, { phone: 'emil@example.com' })).rejects.toThrow(/SMS/);
  });

  it('rate limits per destination', async () => {
    const h = createHarness();
    for (let i = 0; i < MAX_REQUESTS_PER_HOUR; i += 1) {
      await requestCode(h.deps, { phone: PHONE });
    }
    await expect(requestCode(h.deps, { phone: PHONE })).rejects.toThrow(/För många försök/i);

    // A different number is unaffected.
    await expect(requestCode(h.deps, { phone: OTHER })).resolves.toBeTruthy();
  });

  it('counts a rewritten number as the same destination', async () => {
    // Otherwise the limit is per spelling, and five requests becomes twenty.
    const h = createHarness();
    for (const written of ['070-123 45 67', '0701234567', '+46 70 123 45 67', '+46701234567']) {
      await requestCode(h.deps, { phone: written });
    }
    await requestCode(h.deps, { phone: '070 123 4567' });

    await expect(requestCode(h.deps, { phone: PHONE })).rejects.toThrow(/För många försök/i);
  });

  it('lets the window expire', async () => {
    const h = createHarness();
    for (let i = 0; i < MAX_REQUESTS_PER_HOUR; i += 1) {
      await requestCode(h.deps, { phone: PHONE });
    }
    h.setNow(new Date(h.now().getTime() + 61 * 60 * 1000));
    await expect(requestCode(h.deps, { phone: PHONE })).resolves.toBeTruthy();
  });
});

describe('verifying a code', () => {
  it('creates the person and their personal room in one step', async () => {
    const h = createHarness({ fixedCode: '424242' });
    const { requestId } = await requestCode(h.deps, { phone: PHONE });

    const result = await verifyCode(h.deps, { requestId, code: '424242' });

    expect(result.created).toBe(true);
    expect(result.person.phone).toBe(E164);
    expect(result.person.email).toBeNull();
    expect(result.personalRoom.kind).toBe('personal');
    expect(result.session.token).toContain(result.person.id);
  });

  it('logs an existing person back in instead of creating a second one', async () => {
    const h = createHarness({ fixedCode: '424242' });
    const first = await requestCode(h.deps, { phone: PHONE });
    const created = await verifyCode(h.deps, { requestId: first.requestId, code: '424242' });

    const second = await requestCode(h.deps, { phone: PHONE });
    const returning = await verifyCode(h.deps, { requestId: second.requestId, code: '424242' });

    expect(returning.created).toBe(false);
    expect(returning.person.id).toBe(created.person.id);
    expect(returning.personalRoom.id).toBe(created.personalRoom.id);
  });

  it('recognises the returning person through a different spelling of their number', async () => {
    const h = createHarness({ fixedCode: '424242' });
    const first = await requestCode(h.deps, { phone: '070-123 45 67' });
    const created = await verifyCode(h.deps, { requestId: first.requestId, code: '424242' });

    const second = await requestCode(h.deps, { phone: '+46 70 123 45 67' });
    const returning = await verifyCode(h.deps, { requestId: second.requestId, code: '424242' });

    expect(returning.created).toBe(false);
    expect(returning.person.id).toBe(created.person.id);
  });

  it('rejects the wrong code and counts the attempt', async () => {
    const h = createHarness({ fixedCode: '424242' });
    const { requestId } = await requestCode(h.deps, { phone: PHONE });

    await expect(verifyCode(h.deps, { requestId, code: '000000' })).rejects.toThrow(CODE_REJECTED);
    expect(h.codes.raw(requestId)?.attempts).toBe(1);
    expect(h.codes.raw(requestId)?.consumedAt).toBeNull();
  });

  it('locks out after too many attempts', async () => {
    const h = createHarness({ fixedCode: '424242' });
    const { requestId } = await requestCode(h.deps, { phone: PHONE });

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
    const { requestId } = await requestCode(h.deps, { phone: PHONE });

    for (let i = 0; i < MAX_ATTEMPTS + 3; i += 1) {
      await expect(verifyCode(h.deps, { requestId, code: '000000' })).rejects.toThrow();
    }

    expect(h.codes.raw(requestId)?.attempts).toBe(MAX_ATTEMPTS);
  });

  it('rejects an expired code', async () => {
    const h = createHarness({ fixedCode: '424242' });
    const { requestId } = await requestCode(h.deps, { phone: PHONE });

    h.setNow(new Date(h.now().getTime() + 11 * 60 * 1000));
    await expect(verifyCode(h.deps, { requestId, code: '424242' })).rejects.toThrow(CODE_REJECTED);
  });

  it('refuses to reuse a code', async () => {
    const h = createHarness({ fixedCode: '424242' });
    const { requestId } = await requestCode(h.deps, { phone: PHONE });

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

    const wrongId = (await requestCode(h.deps, { phone: PHONE })).requestId;
    const wrong = await failureOf(() => verifyCode(h.deps, { requestId: wrongId, code: '000000' }));

    const usedId = (await requestCode(h.deps, { phone: OTHER })).requestId;
    await verifyCode(h.deps, { requestId: usedId, code: '424242' });
    const used = await failureOf(() => verifyCode(h.deps, { requestId: usedId, code: '424242' }));

    const expiredId = (await requestCode(h.deps, { phone: THIRD })).requestId;
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
      phone: FOURTH,
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
    const { requestId } = await requestCode(h.deps, { phone: PHONE });
    const result = await verifyCode(h.deps, { requestId, code: '424242' });

    expect(result.joinedRoom).toBeNull();
    expect(h.invites.accepted).toEqual([]);
  });
});
