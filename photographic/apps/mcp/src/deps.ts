/**
 * What this server needs, and deliberately nothing more.
 *
 * `authenticate` is a function rather than an OAuth provider interface because this app
 * has no business knowing how a token became an actor. It receives the bearer token the
 * client sent and gets back who that is, or null. That keeps the whole auth question in
 * one place — the API process that already owns it — and means this package can be
 * tested with a three-line fake instead of a running authorisation server.
 */

import type { Actor, Services } from '@photographic/core';

export interface McpConfig {
  /** Externally reachable origin of this server, without a trailing slash. */
  publicUrl: string;
  /**
   * Where a client should go to get a token. Usually the same origin, but they are
   * separable so the API and the MCP endpoint can be split across hosts later without
   * a client noticing.
   */
  issuerUrl: string;
  serverName: string;
  serverVersion: string;
  /**
   * How long a connection nobody is using is kept.
   *
   * It has to be generous: a person leaves a chat open over lunch and expects it to still
   * know them, and a client that has to re-initialize loses the instructions string —
   * which several clients only read once, so the profile does not come back with it.
   */
  idleTimeoutMs: number;
}

export interface McpDeps {
  services: Services;
  /** Resolves a bearer token to an actor. Null for unknown, expired or malformed. */
  authenticate(token: string): Promise<Actor | null>;
  config: McpConfig;
  log?: McpLog;
  /** Injected so a test can expire an idle connection without waiting half an hour. */
  now?: () => number;
}

export interface McpLog {
  info(event: string, fields?: Record<string, unknown>): void;
  warn(event: string, fields?: Record<string, unknown>): void;
  error(event: string, fields?: Record<string, unknown>): void;
}

export const SILENT_LOG: McpLog = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

export function defaultConfig(overrides: Partial<McpConfig> = {}): McpConfig {
  const publicUrl = (
    overrides.publicUrl ??
    process.env.PUBLIC_URL ??
    'http://localhost:8787'
  ).replace(/\/+$/, '');

  return {
    publicUrl,
    issuerUrl: (overrides.issuerUrl ?? publicUrl).replace(/\/+$/, ''),
    serverName: overrides.serverName ?? 'photographic',
    serverVersion: overrides.serverVersion ?? '0.1.0',
    idleTimeoutMs: overrides.idleTimeoutMs ?? 2 * 60 * 60 * 1000,
  };
}
