import { describe, expect, it } from 'vitest';

import { mapRoomSummary } from './load.js';

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
});
