import type { RoomDocumentDto } from '../api/index.js';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  loadDocumentsFromApi,
  loadSharedRoomFromApi,
  mapClientHealth,
  mapCompassEntry,
  mapProposal,
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

  it('maps client health DTOs onto the Klienter row shape', () => {
    const client = mapClientHealth({
      agentClient: 'claude-desktop',
      displayName: 'Claude',
      lastSeenAt: '2026-09-15T22:04:00.000Z',
      profileDelivered: true,
      deliveryMethod: 'mcp_instructions',
      degraded: false,
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
      kind: 'instruction',
      body: 'utmana alltid mina idéer',
      reason: 'Instruktioner kräver godkännande.',
      proposedByClient: 'claude-desktop',
      createdAt: '2026-09-15T12:00:00.000Z',
    });
    expect(item).toMatchObject({
      id: 'prop-1',
      clientLabel: 'Claude',
      kind: 'instruction',
      body: 'utmana alltid mina idéer',
    });
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
