/**
 * Live MCP smoke against a running REST process (default http://127.0.0.1:8787).
 *
 * Skipped unless `LIVE_MCP=1`, and excluded from the default e2e run: the journey
 * resets the same database this process is serving. Use `test:live`.
 *
 *   DATABASE_URL=… pnpm db:seed
 *   # REST already listening; signup codes land in its log
 *   LIVE_MCP=1 LIVE_MCP_LOG=/tmp/rest.log pnpm --filter @photographic/e2e test:live
 *
 * Proves OAuth access token → POST /mcp initialize → instructions mention a seeded
 * personal fact (ketchup). Session tokens alone are not enough for /mcp.
 *
 * Point it at a public hostname to prove the same thing an AI client will do from
 * outside the machine — every step below is a request Claude makes for itself:
 *
 *   LIVE_MCP=1 LIVE_MCP_URL=https://<host> LIVE_MCP_PUBLIC_URL=https://<host> …
 */

import { createHash, randomBytes } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';

import { describe, expect, it } from 'vitest';

const enabled = process.env.LIVE_MCP === '1';
const API = process.env.LIVE_MCP_URL ?? 'http://127.0.0.1:8787';
const PUBLIC = process.env.LIVE_MCP_PUBLIC_URL ?? 'http://localhost:8787';
/** The seeded demo person's number. Signing in is by mobile number and nothing else. */
const PHONE = process.env.LIVE_MCP_PHONE ?? '+46700000000';
const LOG = process.env.LIVE_MCP_LOG ?? '/tmp/rest-demo-api.log';
const REDIRECT_URI = 'cursor://anysphere.cursor-retrieval/oauth/callback';

const base64url = (value: Buffer) => value.toString('base64url');
const pkce = () => {
  const verifier = base64url(randomBytes(32));
  return { verifier, challenge: base64url(createHash('sha256').update(verifier).digest()) };
};

async function postJson(path: string, body: unknown, token?: string) {
  const response = await fetch(`${API}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
  return { response, body: (await response.json()) as Record<string, unknown> };
}

async function postForm(path: string, fields: Record<string, string>) {
  return fetch(`${API}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(fields),
  });
}

/** Dev codes are only logged (`signup_code`); scrape the REST log after requesting one. */
async function readSignupCode(beforeBytes: number): Promise<string> {
  if (process.env.LIVE_MCP_CODE) return process.env.LIVE_MCP_CODE;

  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const text = readFileSync(LOG, 'utf8').slice(beforeBytes);
      for (const line of text.split('\n').reverse()) {
        if (!line.includes('"signup_code"') && !line.includes('signup_code')) continue;
        const code = line.match(/"code"\s*:\s*"(\d+)"/)?.[1];
        if (code) return code;
      }
    } catch {
      // log may not exist yet
    }
    await sleep(100);
  }

  throw new Error(
    `No signup_code in ${LOG}. Set LIVE_MCP_LOG to the REST process log, or LIVE_MCP_CODE.`,
  );
}

async function readSseResult(response: Response): Promise<Record<string, unknown>> {
  const raw = await response.text();
  const data = raw
    .split('\n')
    .find((line) => line.startsWith('data:'))
    ?.slice('data:'.length)
    .trim();
  if (!data) throw new Error(`MCP response had no data line: ${raw.slice(0, 200)}`);
  return JSON.parse(data) as Record<string, unknown>;
}

describe.skipIf(!enabled)(`live MCP against ${API}`, () => {
  it('initialize instructions include a seeded personal fact', async () => {
    const health = await fetch(`${API}/health`);
    expect(health.status).toBe(200);

    let beforeBytes = 0;
    try {
      beforeBytes = statSync(LOG).size;
    } catch {
      beforeBytes = 0;
    }

    const requested = await postJson('/v1/signup/request', { phone: PHONE });
    expect(requested.response.status).toBe(200);
    const requestId = requested.body['requestId'] as string;
    const code = await readSignupCode(beforeBytes);

    const verified = await postJson('/v1/signup/verify', { requestId, code });
    expect(verified.response.status).toBe(200);
    const session = verified.body['session'] as { token: string };
    expect(session.token).toMatch(/^session-/);

    const { verifier, challenge } = pkce();
    const state = base64url(randomBytes(8));

    const registered = await postJson('/oauth/register', {
      client_name: 'Live MCP Smoke',
      redirect_uris: [REDIRECT_URI],
      token_endpoint_auth_method: 'none',
    });
    expect(registered.response.status).toBe(201);
    const clientId = registered.body['client_id'] as string;

    const scopes = 'memory.read memory.write rooms.read profile.read offline_access';
    const authorize = await fetch(
      `${API}/oauth/authorize?${new URLSearchParams({
        response_type: 'code',
        client_id: clientId,
        redirect_uri: REDIRECT_URI,
        code_challenge: challenge,
        code_challenge_method: 'S256',
        scope: scopes,
        state,
        resource: `${PUBLIC}/mcp`,
      })}`,
      { redirect: 'manual' },
    );
    expect(authorize.status).toBe(302);
    const authRequest = new URL(authorize.headers.get('location') as string).searchParams.get(
      'auth_request',
    ) as string;

    const approved = await postJson(
      '/oauth/authorize/approve',
      { requestId: authRequest, approved: true },
      session.token,
    );
    expect(approved.response.status).toBe(200);
    const redirectUrl = new URL(approved.body['redirectUrl'] as string);
    const authCode = redirectUrl.searchParams.get('code') as string;

    const tokenResponse = await postForm('/oauth/token', {
      grant_type: 'authorization_code',
      code: authCode,
      redirect_uri: REDIRECT_URI,
      client_id: clientId,
      code_verifier: verifier,
    });
    expect(tokenResponse.status).toBe(200);
    const tokens = (await tokenResponse.json()) as Record<string, string>;
    const accessToken = tokens['access_token'] as string;

    const init = await fetch(`${API}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'live-mcp-smoke', version: '0' },
        },
      }),
    });
    expect(init.status).toBe(200);

    const payload = await readSseResult(init);
    const result = payload['result'] as { instructions?: string };
    const instructions = result.instructions ?? '';

    expect(instructions.length).toBeGreaterThan(0);
    expect(instructions.toLowerCase()).toContain('ketchup');
  }, 30_000);
});
