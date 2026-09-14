/**
 * Passwordless sign-up.
 *
 * No passwords, because a password is one more thing to invent before the person finds
 * out whether the product is any good, and because "forgot password" is a whole
 * subsystem we would have to build and secure for no benefit.
 *
 * An invited person never sees a separate account step: preview the room, tap join,
 * type the code, and they are in with a personal room already created. A signup wall
 * as the first screen is where the invite loop dies.
 */

import { createHmac, randomInt, randomUUID, timingSafeEqual } from 'node:crypto';

import type { Person, PersonId, Room } from '@photographic/core';
import { AuthError, ValidationError } from '@photographic/core';

import type { ConnectDeps, PendingCode, SignupChannel } from './deps.js';

export const CODE_LENGTH = 6;
export const CODE_TTL_MS = 10 * 60 * 1000;
export const MAX_ATTEMPTS = 5;
/** Per destination, per window. Enough for a fat-fingered email, not enough to spam. */
export const MAX_REQUESTS_PER_HOUR = 5;
const REQUEST_WINDOW_MS = 60 * 60 * 1000;

export function generateCode(): string {
  let out = '';
  for (let i = 0; i < CODE_LENGTH; i += 1) out += String(randomInt(0, 10));
  return out;
}

export function hashCode(code: string, secret: string, destination: string): string {
  // Destination is bound into the HMAC so a code issued for one address cannot be
  // replayed against another.
  return createHmac('sha256', secret).update(`${destination}:${code}`).digest('hex');
}

function codeMatches(expectedHash: string, candidateHash: string): boolean {
  const a = Buffer.from(expectedHash, 'utf8');
  const b = Buffer.from(candidateHash, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function normaliseEmail(email: string): string {
  return email.trim().toLowerCase();
}

function normalisePhone(phone: string): string {
  const cleaned = phone.replace(/[\s()-]/g, '');
  if (!/^\+?\d{6,15}$/.test(cleaned)) throw new ValidationError('Ogiltigt telefonnummer.');
  return cleaned.startsWith('+') ? cleaned : `+${cleaned}`;
}

export interface RequestCodeInput {
  email?: string;
  phone?: string;
  /** Present when the person is arriving from a room invite. */
  inviteToken?: string;
}

export interface RequestCodeResult {
  requestId: string;
  channel: SignupChannel;
  /** Masked for display: `e***@example.com`. Never the raw destination. */
  destinationHint: string;
  expiresAt: Date;
}

export async function requestCode(
  deps: ConnectDeps,
  input: RequestCodeInput,
): Promise<RequestCodeResult> {
  const now = deps.clock();

  let channel: SignupChannel;
  let destination: string;

  if (input.email) {
    channel = 'email';
    destination = normaliseEmail(input.email);
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(destination)) {
      throw new ValidationError('Ogiltig e-postadress.');
    }
  } else if (input.phone) {
    channel = 'sms';
    destination = normalisePhone(input.phone);
  } else {
    throw new ValidationError('Ange e-post eller telefonnummer.');
  }

  const recent = await deps.codes.countSince(destination, new Date(now.getTime() - REQUEST_WINDOW_MS));
  if (recent >= MAX_REQUESTS_PER_HOUR) {
    throw new AuthError('För många försök. Vänta en stund och försök igen.');
  }

  const code = deps.randomCode();
  const record: PendingCode = {
    id: deps.randomId(),
    channel,
    destination,
    codeHash: hashCode(code, deps.codeSecret, destination),
    createdAt: now,
    expiresAt: new Date(now.getTime() + CODE_TTL_MS),
    attempts: 0,
    consumedAt: null,
    inviteToken: input.inviteToken ?? null,
  };

  await deps.codes.insert(record);
  await deps.sender.send({ channel, destination, code });

  return {
    requestId: record.id,
    channel,
    destinationHint: maskDestination(channel, destination),
    expiresAt: record.expiresAt,
  };
}

export function maskDestination(channel: SignupChannel, destination: string): string {
  if (channel === 'email') {
    const at = destination.indexOf('@');
    if (at <= 1) return destination;
    return `${destination[0]}***${destination.slice(at)}`;
  }
  return `***${destination.slice(-4)}`;
}

export interface VerifyCodeResult {
  person: Person;
  personalRoom: Room;
  session: { token: string; expiresAt: Date };
  /** False when the code logged an existing person back in. */
  created: boolean;
  /** Set when an invite token came along for the ride. */
  joinedRoom: { room: Room; role: string } | null;
}

export async function verifyCode(
  deps: ConnectDeps,
  input: { requestId: string; code: string },
): Promise<VerifyCodeResult> {
  const now = deps.clock();
  const record = await deps.codes.findById(input.requestId);
  if (!record) throw new AuthError('Koden är inte längre giltig.');
  if (record.consumedAt) throw new AuthError('Koden är redan använd.');
  if (record.expiresAt <= now) throw new AuthError('Koden har gått ut. Begär en ny.');
  if (record.attempts >= MAX_ATTEMPTS) throw new AuthError('För många försök. Begär en ny kod.');

  const candidate = hashCode(input.code.trim(), deps.codeSecret, record.destination);
  if (!codeMatches(record.codeHash, candidate)) {
    await deps.codes.recordAttempt(record.id);
    throw new AuthError('Fel kod.');
  }

  // Consume before doing anything durable, so a double-submitted form cannot register
  // two people for one code.
  const claimed = await deps.codes.consume(record.id, now);
  if (!claimed) throw new AuthError('Koden är redan använd.');

  const existing = record.channel === 'email'
    ? await deps.identity.findByEmail(record.destination)
    : await deps.identity.findByPhone(record.destination);

  let person: Person;
  let personalRoom: Room;
  let created = false;

  if (existing) {
    person = existing;
    personalRoom = await deps.identity.personalRoomOf(person.id);
  } else {
    const registered = await deps.identity.register(
      record.channel === 'email'
        ? { email: record.destination }
        : { phone: record.destination },
    );
    person = registered.person;
    personalRoom = registered.personalRoom;
    created = true;
  }

  let joinedRoom: VerifyCodeResult['joinedRoom'] = null;
  if (record.inviteToken) {
    const accepted = await deps.invites.accept(record.inviteToken, person.id as PersonId);
    joinedRoom = { room: accepted.room, role: accepted.role };
  }

  const session = await deps.issuer.issue({ personId: person.id });

  return { person, personalRoom, session, created, joinedRoom };
}

export { randomUUID };
