/**
 * Scope vocabulary.
 *
 * Two kinds of scope value exist: capabilities (`memory.read`) and room selectors
 * (`room:<uuid>`). Room selectors are how a token is narrowed to specific rooms; the
 * resulting uuids land in `oauth_token.room_scope`.
 *
 * An empty room_scope is not "no rooms". It means "every room this person belongs to,
 * resolved at request time" -- see `actor.ts`.
 */

import type { RoomId } from '@photographic/core';

export const SCOPE_MEMORY_READ = 'memory.read';
export const SCOPE_MEMORY_WRITE = 'memory.write';
export const SCOPE_ROOMS_READ = 'rooms.read';
export const SCOPE_PROFILE_READ = 'profile.read';
/** Presence of this scope is what makes the token endpoint issue a refresh token. */
export const SCOPE_OFFLINE_ACCESS = 'offline_access';

export const SUPPORTED_SCOPES: readonly string[] = [
  SCOPE_MEMORY_READ,
  SCOPE_MEMORY_WRITE,
  SCOPE_ROOMS_READ,
  SCOPE_PROFILE_READ,
  SCOPE_OFFLINE_ACCESS,
];

/** What a client gets when it asks for nothing: read the memory, keep the connection. */
export const DEFAULT_SCOPE = [
  SCOPE_MEMORY_READ,
  SCOPE_ROOMS_READ,
  SCOPE_PROFILE_READ,
  SCOPE_OFFLINE_ACCESS,
].join(' ');

const ROOM_SELECTOR_PREFIX = 'room:';
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: string): boolean {
  return UUID_PATTERN.test(value);
}

/** Splits a scope string on whitespace, dropping empties and duplicates, order kept. */
export function parseScope(raw: string | undefined | null): string[] {
  if (!raw) return [];
  const out: string[] = [];
  for (const part of raw.split(/\s+/)) {
    if (part === '') continue;
    if (!out.includes(part)) out.push(part);
  }
  return out;
}

export function formatScope(scopes: readonly string[]): string {
  return scopes.join(' ');
}

export type ScopeValidation =
  | { ok: true; scope: string; scopes: string[]; roomScope: RoomId[] }
  | { ok: false; reason: string };

/**
 * Validates a requested scope string against what the server supports.
 *
 * Unknown capability scopes are rejected rather than silently dropped: a client that
 * asked for something we do not implement should find out at authorization time, not by
 * getting a 404 from a tool call later.
 */
export function validateScope(
  requested: string | undefined | null,
  supported: readonly string[] = SUPPORTED_SCOPES,
): ScopeValidation {
  const scopes = parseScope(requested ?? DEFAULT_SCOPE);
  if (scopes.length === 0) return { ok: false, reason: 'scope must not be empty' };

  const roomScope: RoomId[] = [];
  for (const scope of scopes) {
    if (scope.startsWith(ROOM_SELECTOR_PREFIX)) {
      const roomId = scope.slice(ROOM_SELECTOR_PREFIX.length);
      if (!isUuid(roomId)) return { ok: false, reason: `invalid room selector: ${scope}` };
      const typed = roomId.toLowerCase() as RoomId;
      if (!roomScope.includes(typed)) roomScope.push(typed);
      continue;
    }
    if (!supported.includes(scope)) return { ok: false, reason: `unsupported scope: ${scope}` };
  }

  return { ok: true, scope: formatScope(scopes), scopes, roomScope };
}

/** Room uuids named by `room:` selectors in an already-validated scope string. */
export function roomScopeOf(scope: string): RoomId[] {
  const out: RoomId[] = [];
  for (const part of parseScope(scope)) {
    if (!part.startsWith(ROOM_SELECTOR_PREFIX)) continue;
    const roomId = part.slice(ROOM_SELECTOR_PREFIX.length).toLowerCase();
    if (isUuid(roomId) && !out.includes(roomId as RoomId)) out.push(roomId as RoomId);
  }
  return out;
}

export function hasScope(scope: string, needed: string): boolean {
  return parseScope(scope).includes(needed);
}

/**
 * A refresh request may narrow the scope but never widen it (RFC 6749 section 6).
 */
export function narrowScope(
  granted: string,
  requested: string | undefined | null,
): { ok: true; scope: string } | { ok: false; reason: string } {
  if (requested === undefined || requested === null || requested.trim() === '') {
    return { ok: true, scope: granted };
  }
  const grantedScopes = parseScope(granted);
  const requestedScopes = parseScope(requested);
  for (const scope of requestedScopes) {
    if (!grantedScopes.includes(scope)) {
      return { ok: false, reason: `scope ${scope} was not granted` };
    }
  }
  return { ok: true, scope: formatScope(requestedScopes) };
}
