import type { RoomDocumentDto } from '../api/index.js';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  loadDocumentsFromApi,
  loadSharedRoomFromApi,
  mapClientHealth,
  mapCompassEntry,
  mapInvitePreview,
  mapProposal,
  mapProvenance,
  mapRoomDocument,
  mapRoomSummary,
  mapTrashEntry,
} from './load.js';

describe('API → UI mapping', () => {
  it('maps room summaries onto the card shape the screens already use', () => {
    const card = mapRoomSummary({
      roomId: 'room-1',
      slug: 'ditt-rum',
      title: 'Ditt rum',
      kind: 'personal',
      role: 'owner',
      oneLine: 'Ditt personliga minne',
      memberCount: 1,
      unseenCount: 0,
    });
    expect(card).toMatchObject({
      id: 'room-1',
      kind: 'personal',
      title: 'Ditt rum',
      headline: 'Ditt personliga minne',
      memberNames: [],
      unseenCount: 0,
    });
  });

  it('maps invite preview DTOs onto the recipient landing shape', () => {
    const invite = mapInvitePreview('tok-1', {
      room: { title: 'Villan', description: 'Renovering' },
      invitedByName: 'Emil',
      preview: 'Peab har offererat\nElektrikern heter Micke',
    });
    expect(invite).toMatchObject({
      token: 'tok-1',
      roomTitle: 'Villan',
      brief: 'Renovering',
      invitedByName: 'Emil',
    });
    expect(invite.lines.map((line) => line.body)).toEqual([
      'Peab har offererat',
      'Elektrikern heter Micke',
    ]);
  });

  it('maps client health DTOs onto the Klienter row shape', () => {
    const client = mapClientHealth({
      agentClient: 'claude-desktop',
      displayName: 'Claude',
      lastSeenAt: '2026-09-15T22:04:00.000Z',
      profileDelivered: true,
      deliveryMethod: 'mcp_instructions',
      degraded: false,
      revoked: false,
    });
    expect(client).toMatchObject({
      id: 'claude-desktop',
      displayName: 'Claude',
      profileDelivered: true,
      deliveryMethod: 'mcp_instructions',
      degraded: false,
    });
  });

  it('maps trash DTOs onto quiet shelf lines with days remaining', () => {
    const line = mapTrashEntry({
      shortId: 'p-old1',
      roomId: 'room-1',
      roomTitle: 'Ditt rum',
      kind: 'fact',
      body: 'Bor i Malmö',
      deletedAt: '2026-09-01T12:00:00.000Z',
      deletedByClient: 'claude-desktop',
      deleteReason: 'Flyttade till Stockholm',
      purgeAfter: '2026-10-01T12:00:00.000Z',
      daysRemaining: 28,
    });
    expect(line).toMatchObject({
      shortId: 'p-old1',
      roomTitle: 'Ditt rum',
      body: 'Bor i Malmö',
      daysLabel: '28 dagar kvar',
      deleteReason: 'Flyttade till Stockholm',
    });
  });

  it('maps proposals onto approval cards with a Swedish client label', () => {
    const item = mapProposal({
      id: 'prop-1',
      roomId: 'room-1',
      intent: 'remember',
      kind: 'instruction',
      body: 'utmana alltid mina idéer',
      reason: 'Instruktioner kräver godkännande.',
      proposedByClient: 'claude-desktop',
      createdAt: '2026-09-15T12:00:00.000Z',
    });
    expect(item).toMatchObject({
      id: 'prop-1',
      clientLabel: 'Claude',
      intent: 'remember',
      kind: 'instruction',
      body: 'utmana alltid mina idéer',
      roomId: 'room-1',
    });
  });

  /*
   * The regression this mapping existed to cause: `roomId` and `intent` were dropped
   * here, so the queue rendered "vill spara" over a request to put something in front of
   * other people, and the card could not name the room it would land in.
   */
  it('keeps the intent and names the room a share would land in', () => {
    const item = mapProposal(
      {
        id: 'prop-2',
        roomId: 'room-ledning',
        intent: 'share',
        kind: 'note',
        body: 'Peab har offererat 340 000 kr',
        reason: 'Allt som skrivs till ett delat rum avgörs av dig.',
        proposedByClient: 'chatgpt-web',
        createdAt: '2026-09-15T12:00:00.000Z',
      },
      new Map([
        [
          'room-ledning',
          { title: 'Buyersclub Ledning', kind: 'shared' as const, audience: ['Anna', 'Jacob'], audienceCount: 3 },
        ],
      ]),
    );

    expect(item).toMatchObject({
      intent: 'share',
      clientLabel: 'ChatGPT',
      roomTitle: 'Buyersclub Ledning',
      roomKind: 'shared',
      audience: ['Anna', 'Jacob'],
    });
  });

  it('maps provenance into sentences, and finds the event to zoom into', () => {
    const answer = mapProvenance(
      {
        shortId: 'p-h58j',
        body: 'Emil, 34, bor i Stockholm',
        roomTitle: 'Ditt rum',
        savedAt: '2026-09-02T09:14:00.000Z',
        savedByClient: 'claude-desktop',
        approvedByName: null,
        motivation: 'Handlar om vem du är.',
        source: { kind: 'conversation', label: 'Samtal med Claude', ref: 'sess-1', uri: null },
        changed: false,
        timeline: [
          {
            seq: 41,
            action: 'saved',
            occurredAt: '2026-09-02T09:14:00.000Z',
            roomId: 'room-1',
            roomTitle: 'Ditt rum',
            shortId: 'p-h58j',
            body: 'Emil, 34, bor i Stockholm',
            agentClient: 'claude-desktop',
            actorName: 'Emil',
            wasApproved: false,
            redacted: false,
          },
        ],
      },
      'personal',
    );

    expect(answer).toMatchObject({
      shortId: 'p-h58j',
      who: 'Claude',
      sourceLabel: 'Samtal med Claude',
      motivation: 'Handlar om vem du är.',
      roomTitle: 'Ditt rum',
      seq: 41,
    });
    expect(answer.when).toContain('2 september 2026');
  });

  it('maps a default compass entry with a Swedish label and no id', () => {
    const line = mapCompassEntry({
      key: 'directness',
      text: 'Var direkt. Säg det du menar utan att mjuka upp det i onödan.',
      source: 'default',
      shortId: null,
    });
    expect(line).toEqual({
      key: 'directness',
      label: 'Var direkt',
      text: 'Var direkt. Säg det du menar utan att mjuka upp det i onödan.',
      source: 'default',
      shortId: null,
    });
  });

  it('maps a personalised compass entry with its short id', () => {
    const line = mapCompassEntry({
      key: 'label_certainty',
      text: 'Säg alltid rakt ut om du gissar.',
      source: 'personal',
      shortId: 'p-9x2q',
    });
    expect(line).toMatchObject({ source: 'personal', shortId: 'p-9x2q' });
  });

  it('maps room documents onto DocumentLine with calm Swedish meta', () => {
    const line = mapRoomDocument(
      documentDto({ pageCount: 3, byteSizeLabel: '1,2 MB' }),
    );

    expect(line).toEqual({
      id: 'doc-1',
      title: 'Vaccinationskort Vera.pdf',
      meta: '3 sidor · 1,2 MB',
      searchable: true,
    });
  });

  it('says on the shelf when a document could not be read as text', () => {
    // Otherwise a scanned PDF sits there looking like every other row, and a person has
    // no way to know their AI cannot read it.
    const line = mapRoomDocument(
      documentDto({
        filename: 'Inskannat avtal.pdf',
        searchable: false,
        chunkCount: 0,
        extraction: 'empty',
        extractionError: 'Vi hittade ingen text i "Inskannat avtal.pdf".',
      }),
    );

    expect(line.meta).toContain('kan inte läsas som text');
    expect(line.searchable).toBe(false);
  });

  it('leaves out the page count for a single-page document', () => {
    const line = mapRoomDocument(documentDto({ pageCount: 1, byteSizeLabel: '816 B' }));
    expect(line.meta).toBe('816 B');
  });
});

function documentDto(overrides: Partial<RoomDocumentDto> = {}): RoomDocumentDto {
  return {
    id: 'doc-1',
    filename: 'Vaccinationskort Vera.pdf',
    mimeType: 'application/pdf',
    byteSize: 1_258_291,
    byteSizeLabel: '1,2 MB',
    createdAt: '2026-09-14T10:00:00.000Z',
    extraction: 'extracted',
    extractionError: null,
    warnings: [],
    pageCount: 3,
    chunkCount: 4,
    searchable: true,
    summary: null,
    ...overrides,
  };
}

describe('loadDocumentsFromApi', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  it('loads documents from GET /v1/rooms/:id/documents', async () => {
    const roomId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith(`/v1/rooms/${roomId}/documents`)) {
        return Response.json({
          documents: [documentDto({ id: 'doc-1', filename: 'Offert Peab kök.pdf' })],
        });
      }
      return new Response('not found', { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const documents = await loadDocumentsFromApi(roomId);

    expect(documents).toEqual([
      { id: 'doc-1', title: 'Offert Peab kök.pdf', meta: '3 sidor · 1,2 MB', searchable: true },
    ]);
  });
});

describe('loadSharedRoomFromApi', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  it('populates memories from GET /v1/rooms/:id/items', async () => {
    const roomId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith(`/v1/rooms/${roomId}/items`)) {
        return Response.json({
          items: [{ shortId: 'd-7k2m', kind: 'decision', body: 'Skjuta till Q3' }],
        });
      }
      if (url.endsWith(`/v1/rooms/${roomId}`)) {
        return Response.json({
          room: {
            id: roomId,
            kind: 'shared',
            slug: 'ledning',
            title: 'Buyersclub Ledning',
            description: 'Ledningsgruppen',
            createdAt: '2026-09-15T00:00:00.000Z',
            archivedAt: null,
          },
          brief: {
            roomId,
            rendered: 'Beslut och underlag',
            tokenCount: 4,
            stale: false,
            builtAt: '2026-09-15T00:00:00.000Z',
          },
          members: [
            { personId: 'p1', displayName: 'Emil', role: 'owner' },
            { personId: 'p2', displayName: 'Anna', role: 'member' },
          ],
        });
      }
      return new Response('not found', { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const room = await loadSharedRoomFromApi(roomId);

    expect(room).toMatchObject({
      id: roomId,
      kind: 'shared',
      title: 'Buyersclub Ledning',
      memberNames: ['Emil', 'Anna'],
      memories: [{ shortId: 'd-7k2m', kind: 'decision', body: 'Skjuta till Q3' }],
    });
  });
});
