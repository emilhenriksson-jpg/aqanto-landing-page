/**
 * Framework-agnostic handlers. Plain in, plain out, no HTTP library imported here, so
 * the REST app can mount them and the tests can call them directly.
 */

import type { Actor } from '@photographic/core';
import { PhotographicError } from '@photographic/core';

import type { ClientDescriptor, ConnectConfig } from './clients.js';
import { buildClients, findClient } from './clients.js';
import type { ClientId } from './clients.js';
import type { ConnectDeps } from './deps.js';
import { detect, orderClients } from './detect.js';
import { connectHandoffUrl, qrDataUrl } from './qr.js';
import { requestCode, SMS_ONLY, verifyCode } from './signup.js';
import type { VerificationDeps, VerificationHandle, VerificationState } from './verification.js';
import { pollVerification, startVerification } from './verification.js';

export interface HandlerRequest {
  body?: unknown;
  query?: Record<string, string | undefined>;
  headers?: Record<string, string | undefined>;
  /** Present only on authenticated routes. */
  actor?: Actor;
}

export interface HandlerResponse {
  status: number;
  body: unknown;
}

function ok(body: unknown): HandlerResponse {
  return { status: 200, body };
}

function fail(error: unknown): HandlerResponse {
  if (error instanceof PhotographicError) {
    return { status: error.status, body: { error: error.code, message: error.message } };
  }
  return { status: 500, body: { error: 'internal', message: 'Något gick fel.' } };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

// ---------------------------------------------------------------------------
// POST /v1/signup/request
// ---------------------------------------------------------------------------

/**
 * The only door in, and the only place that says so.
 *
 * An `email` in the body is refused rather than dropped. The form no longer sends one,
 * but a saved link, an old client or a curl left over from before would otherwise get a
 * `200` and a request id for a code that is never delivered anywhere — the same silent
 * dead end as offering the field, only harder to find.
 */
export async function handleSignupRequest(
  deps: ConnectDeps,
  req: HandlerRequest,
): Promise<HandlerResponse> {
  try {
    const body = asRecord(req.body);
    if (str(body.email)) {
      return { status: 400, body: { error: 'validation', message: SMS_ONLY } };
    }

    const input: Parameters<typeof requestCode>[1] = { phone: str(body.phone) ?? '' };
    const inviteToken = str(body.inviteToken);
    if (inviteToken) input.inviteToken = inviteToken;

    return ok(await requestCode(deps, input));
  } catch (error) {
    return fail(error);
  }
}

// ---------------------------------------------------------------------------
// POST /v1/signup/verify
// ---------------------------------------------------------------------------

export async function handleSignupVerify(
  deps: ConnectDeps,
  req: HandlerRequest,
): Promise<HandlerResponse> {
  try {
    const body = asRecord(req.body);
    const requestId = str(body.requestId);
    const code = str(body.code);
    if (!requestId || !code) {
      return { status: 400, body: { error: 'validation', message: 'Ange kod.' } };
    }

    const result = await verifyCode(deps, { requestId, code });

    return ok({
      session: result.session,
      created: result.created,
      person: { id: result.person.id, displayName: result.person.displayName },
      personalRoom: { id: result.personalRoom.id, title: result.personalRoom.title },
      joinedRoom: result.joinedRoom
        ? { id: result.joinedRoom.room.id, title: result.joinedRoom.room.title, role: result.joinedRoom.role }
        : null,
      /** Where the web app sends them: straight to connecting an AI. */
      next: 'connect',
    });
  } catch (error) {
    return fail(error);
  }
}

// ---------------------------------------------------------------------------
// GET /v1/connect
// ---------------------------------------------------------------------------

export interface ConnectPayload {
  mcpUrl: string;
  clients: ClientDescriptor[];
  detected: ReturnType<typeof detect>;
  qrDataUrl: string;
  /** The one thing worth reading if the person reads nothing else. */
  headline: string;
}

export async function handleConnect(
  config: ConnectConfig,
  req: HandlerRequest,
): Promise<HandlerResponse> {
  try {
    const userAgent = req.headers?.['user-agent'] ?? null;
    const clients = orderClients(buildClients(config), userAgent);

    return ok({
      mcpUrl: config.mcpUrl,
      clients,
      detected: detect(userAgent),
      qrDataUrl: await qrDataUrl(connectHandoffUrl({ connectPageUrl: config.connectPageUrl })),
      headline: 'Samma adress för alla. Du loggar in när du kopplar.',
    } satisfies ConnectPayload);
  } catch (error) {
    return fail(error);
  }
}

// ---------------------------------------------------------------------------
// POST /v1/connect/verify  and  GET /v1/connect/status
// ---------------------------------------------------------------------------

export async function handleStartVerification(
  deps: VerificationDeps,
  config: ConnectConfig,
  req: HandlerRequest,
): Promise<HandlerResponse> {
  try {
    if (!req.actor) return { status: 401, body: { error: 'auth', message: 'Logga in först.' } };
    const clientId = str(asRecord(req.body).clientId) as ClientId | undefined;
    if (!clientId) return { status: 400, body: { error: 'validation', message: 'Ange klient.' } };

    const client = findClient(buildClients(config), clientId);
    const handle = await startVerification(deps, req.actor, client);

    return ok({ handle, prompt: client.verifyPrompt });
  } catch (error) {
    return fail(error);
  }
}

export async function handleVerificationStatus(
  deps: VerificationDeps,
  config: ConnectConfig,
  req: HandlerRequest & { handle?: VerificationHandle },
): Promise<HandlerResponse> {
  try {
    if (!req.actor) return { status: 401, body: { error: 'auth', message: 'Logga in först.' } };
    const handle = req.handle ?? (asRecord(req.body).handle as VerificationHandle | undefined);
    if (!handle) return { status: 400, body: { error: 'validation', message: 'Saknar handle.' } };

    const client = findClient(buildClients(config), handle.clientId);
    const state: VerificationState = await pollVerification(deps, req.actor, handle, client);

    return ok(state);
  } catch (error) {
    return fail(error);
  }
}
