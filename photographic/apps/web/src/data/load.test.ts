import { describe, expect, it } from 'vitest';

import { mapClientHealth, mapInvitePreview, mapProposal, mapRoomSummary } from './load.js';

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
    });
    expect(client).toMatchObject({
      id: 'claude-desktop',
      displayName: 'Claude',
      profileDelivered: true,
      deliveryMethod: 'mcp_instructions',
      degraded: false,
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
});
