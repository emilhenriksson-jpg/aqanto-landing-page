import { describe, expect, it } from 'vitest';

import type { Room, RoomId } from '@photographic/core';

import { createHarness } from './testing/index.js';
import { hashCode, MAX_ATTEMPTS, MAX_REQUESTS_PER_HOUR, requestCode, verifyCode } from './signup.js';

const EMAIL = 'emil@example.com';

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
    expect(h.codes.raw(byPhone.requestId)?.destination).toBe('+0701234567');
    expect(byPhone.channel).toBe('sms');
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

    await expect(verifyCode(h.deps, { requestId, code: '000000' })).rejects.toThrow(/Fel kod/i);
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
    await expect(verifyCode(h.deps, { requestId, code: '424242' })).rejects.toThrow(
      /Begär en ny kod/i,
    );
  });

  it('rejects an expired code', async () => {
    const h = createHarness({ fixedCode: '424242' });
    const { requestId } = await requestCode(h.deps, { email: EMAIL });

    h.setNow(new Date(h.now().getTime() + 11 * 60 * 1000));
    await expect(verifyCode(h.deps, { requestId, code: '424242' })).rejects.toThrow(/gått ut/i);
  });

  it('refuses to reuse a code', async () => {
    const h = createHarness({ fixedCode: '424242' });
    const { requestId } = await requestCode(h.deps, { email: EMAIL });

    await verifyCode(h.deps, { requestId, code: '424242' });
    await expect(verifyCode(h.deps, { requestId, code: '424242' })).rejects.toThrow(
      /redan använd/i,
    );
  });

  it('rejects an unknown request id', async () => {
    const h = createHarness();
    await expect(verifyCode(h.deps, { requestId: 'nope', code: '424242' })).rejects.toThrow(
      /inte längre giltig/i,
    );
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
