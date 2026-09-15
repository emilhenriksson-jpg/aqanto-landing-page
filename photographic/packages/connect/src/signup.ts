/**
 * Passwordless sign-up, by SMS.
 *
 * No passwords, because a password is one more thing to invent before the person finds
 * out whether the product is any good, and because "forgot password" is a whole
 * subsystem we would have to build and secure for no benefit.
 *
 * **A mobile number is the only way in.** The `email` channel, the sender behind it and
 * the provider selection are all still here and still tested: this is a decision about
 * what the product offers, not a capability we tore out. What changed is that no code can
 * be requested for an address any more, because no address is configured to receive one —
 * and a channel that accepts a request and delivers nothing is worse than one that is not
 * offered. Re-offering email later means letting `requestCode` take one again.
 *
 * An invited person never sees a separate account step: preview the room, tap join,
 * type the code, and they are in with a personal room already created. A signup wall
 * as the first screen is where the invite loop dies.
 */

import { createHmac, randomInt, randomUUID, timingSafeEqual } from 'node:crypto';

import type { Person, PersonId, Room } from '@photographic/core';
import { AuthError, ValidationError } from '@photographic/core';

import type { ConnectDeps, PendingCode, SignupChannel } from './deps.js';
import { checkSwedishMobile, maskSwedishMobile } from './phone.js';

export const CODE_LENGTH = 6;
export const CODE_TTL_MS = 10 * 60 * 1000;
export const MAX_ATTEMPTS = 5;
/** Per destination, per window. Enough for a mistyped digit, not enough to spam. */
export const MAX_REQUESTS_PER_HOUR = 5;

/**
 * What anything still asking to sign up by email is told.
 *
 * Said rather than ignored. A request that quietly succeeded without sending would leave
 * the caller waiting for a code that was never on its way, which is exactly the failure
 * taking email out of the interface is meant to end.
 */
export const SMS_ONLY = 'Koden kommer med SMS. Ange ditt mobilnummer.';
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

/**
 * One number, however it was written, in E.164 — or the reason it is not a number we can
 * text. `checkSwedishMobile` owns the reading; this is only the throwing edge of it.
 */
function normalisePhone(phone: string): string {
  const checked = checkSwedishMobile(phone);
  if (!checked.ok) throw new ValidationError(checked.message);
  return checked.e164;
}

export interface RequestCodeInput {
  /** A Swedish mobile number, in any of the shapes a person writes one. */
  phone: string;
  /** Present when the person is arriving from a room invite. */
  inviteToken?: string;
}

export interface RequestCodeResult {
  requestId: string;
  channel: SignupChannel;
  /** Masked for display: `070-••• 45 67`. Never the raw destination. */
  destinationHint: string;
  expiresAt: Date;
}

export async function requestCode(
  deps: ConnectDeps,
  input: RequestCodeInput,
): Promise<RequestCodeResult> {
  const now = deps.clock();

  const channel: SignupChannel = 'sms';
  const destination = normalisePhone(input.phone ?? '');

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
  return maskSwedishMobile(destination);
}

/**
 * The one answer every failed verification gives.
 *
 * Wrong code, unknown request id, already used, expired, out of attempts — all the same
 * sentence and the same status. The endpoint is publicly reachable and mints a session,
 * so anything that distinguishes those states is a probe: "already used" tells an
 * attacker holding a stolen request id that the code was real and the person got in,
 * and "expired" tells them to stop guessing and come back after the next request.
 *
 * It also has to be a sentence a person can act on, because the honest cases — a typo, a
 * code left too long in another tab — are overwhelmingly the common ones. Saying both
 * halves covers every state truthfully without naming which one happened.
 */
export const CODE_REJECTED = 'Koden stämmer inte, eller så har den gått ut. Begär en ny.';

function rejected(): AuthError {
  return new AuthError(CODE_REJECTED);
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

  // The HMAC is computed before any branch, and on a placeholder destination when there
  // is no record, so that "this request id means nothing" costs the same as "this code
  // is wrong". Rejecting early would make the work — and the response time — describe
  // which of the two happened.
  const candidate = hashCode(input.code.trim(), deps.codeSecret, record?.destination ?? '');

  if (!record) throw rejected();
  if (record.consumedAt) throw rejected();
  if (record.expiresAt <= now) throw rejected();
  if (record.attempts >= MAX_ATTEMPTS) throw rejected();

  if (!codeMatches(record.codeHash, candidate)) {
    await deps.codes.recordAttempt(record.id);
    throw rejected();
  }

  // Consume before doing anything durable, so a double-submitted form cannot register
  // two people for one code.
  const claimed = await deps.codes.consume(record.id, now);
  if (!claimed) throw new AuthError('Koden är redan använd.');

  // Both channels are still resolved here even though only `sms` can be requested. A code
  // that was issued for an address is still a code we promised to honour, and the day
  // email is offered again this is the half that would otherwise have to be rebuilt.
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
