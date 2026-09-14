import { buildClients, orderClients } from '@photographic/connect';
import type { ClientId, VerificationHandle, VerificationState } from '@photographic/connect';

import type { Api, ClientHealthEntry, ConnectPayload, InvitePreview } from '../api.js';
import { ApiError } from '../api.js';

export const MCP_URL = 'https://photographic.me/mcp';

export interface FakeApiOptions {
  /** Queued states returned by successive status polls. The last one repeats. */
  verification?: VerificationState[];
  invite?: InvitePreview;
  health?: ClientHealthEntry[];
  profile?: string;
  failVerifyWith?: string;
}

export class FakeApi implements Api {
  readonly requested: Array<{ email?: string; phone?: string; inviteToken?: string }> = [];
  readonly started: ClientId[] = [];
  polls = 0;

  constructor(private readonly options: FakeApiOptions = {}) {}

  async requestCode(input: { email?: string; phone?: string; inviteToken?: string }) {
    this.requested.push(input);
    if (input.email && !input.email.includes('@')) {
      throw new ApiError('Ogiltig e-postadress.', 400);
    }
    return {
      requestId: 'req-1',
      channel: 'email' as const,
      destinationHint: 'e***@example.com',
      expiresAt: new Date(Date.now() + 600_000).toISOString(),
    };
  }

  async verifyCode(input: { requestId: string; code: string }) {
    if (this.options.failVerifyWith) throw new ApiError(this.options.failVerifyWith, 401);
    if (input.code !== '424242') throw new ApiError('Fel kod.', 401);
    return {
      session: { token: 'session-1', expiresAt: new Date().toISOString() },
      created: true,
      person: { id: 'person-1', displayName: null },
      personalRoom: { id: 'room-1', title: 'Mitt rum' },
      joinedRoom: this.options.invite
        ? { id: 'room-2', title: this.options.invite.room.title, role: 'editor' }
        : null,
      next: 'connect' as const,
    };
  }

  async connect(): Promise<ConnectPayload> {
    const config = { mcpUrl: MCP_URL, connectPageUrl: 'https://photographic.me/connect' };
    return {
      mcpUrl: MCP_URL,
      clients: orderClients(buildClients(config), null),
      detected: { platform: 'macos', mobile: false, likelyClient: null },
      qrDataUrl: 'data:image/png;base64,iVBORw0KGgo=',
      headline: 'Samma adress för alla. Du loggar in när du kopplar.',
    };
  }

  async peekInvite(): Promise<InvitePreview> {
    if (!this.options.invite) throw new ApiError('Inbjudan gäller inte längre.', 404);
    return this.options.invite;
  }

  async startVerification(clientId: ClientId) {
    this.started.push(clientId);
    const handle: VerificationHandle = {
      clientId,
      expected: ['claude-desktop'],
      startedAtMs: Date.now(),
      timeoutMs: 90_000,
      baseline: {},
    };
    return { handle, prompt: 'Vad vet du om mig?' };
  }

  async verificationStatus(): Promise<VerificationState> {
    const queue = this.options.verification ?? [
      { status: 'waiting', prompt: 'Vad vet du om mig?', elapsedMs: 0, remainingMs: 90_000 },
    ];
    const state = queue[Math.min(this.polls, queue.length - 1)];
    this.polls += 1;
    return state as VerificationState;
  }

  async health(): Promise<ClientHealthEntry[]> {
    return this.options.health ?? [];
  }

  async renderedProfile(): Promise<string> {
    return this.options.profile ?? '';
  }
}
