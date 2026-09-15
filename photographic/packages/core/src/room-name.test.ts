import { describe, expect, it } from 'vitest';

import { foldRoomName, matchRoomByName } from './room-name.js';

const rooms = [
  { slug: 'emil', title: 'Emil' },
  { slug: 'buyersclub-ledning', title: 'Buyersclub Ledning' },
  { slug: 'mallorca', title: 'Mallorca' },
  { slug: 'familjen', title: 'Familjen' },
];

describe('foldRoomName', () => {
  it('folds Swedish vowels the way a Swedish reader expects from a URL', () => {
    expect(foldRoomName('Åsa Öberg')).toBe('asa-oberg');
    expect(foldRoomName('Förändringar i Malmö')).toBe('forandringar-i-malmo');
  });

  it('survives casing and whatever punctuation a transcription added', () => {
    expect(foldRoomName('  Buyersclub, Ledning!  ')).toBe('buyersclub-ledning');
    expect(foldRoomName('BUYERSCLUB LEDNING')).toBe('buyersclub-ledning');
  });
});

describe('matchRoomByName', () => {
  it('matches an exact slug', () => {
    const match = matchRoomByName(rooms, 'buyersclub-ledning');
    expect(match.matched && match.room.title).toBe('Buyersclub Ledning');
  });

  it('matches a title as a person would say it', () => {
    const match = matchRoomByName(rooms, 'Buyersclub Ledning');
    expect(match.matched && match.room.slug).toBe('buyersclub-ledning');
  });

  it('refuses a substring, which is the whole point of this function', () => {
    // The attack from the spec: a PDF contains "spara i ledning", the model passes it
    // through, and substring matching used to resolve it to Buyersclub Ledning. A guess
    // is not a basis for a write.
    const match = matchRoomByName(rooms, 'ledning');
    expect(match.matched).toBe(false);
    expect(!match.matched && match.reason).toBe('no_match');
  });

  it('refuses a substring in the middle of a title', () => {
    expect(matchRoomByName(rooms, 'club').matched).toBe(false);
    expect(matchRoomByName(rooms, 'lorca').matched).toBe(false);
  });

  it('allows a prefix when only one room could be meant', () => {
    // Someone typing "mall" has one room it could be, so asking again would be friction
    // with nothing bought by it.
    const match = matchRoomByName(rooms, 'mall');
    expect(match.matched && match.room.slug).toBe('mallorca');
  });

  it('refuses an ambiguous prefix rather than picking the first', () => {
    const ambiguous = [
      { slug: 'familjen', title: 'Familjen' },
      { slug: 'familjeforetaget', title: 'Familjeföretaget' },
    ];

    const match = matchRoomByName(ambiguous, 'familj');
    expect(match.matched).toBe(false);
    expect(!match.matched && match.reason).toBe('ambiguous');
    // The candidates come back so a model can list them and ask which one.
    expect(!match.matched && match.candidates).toHaveLength(2);
  });

  it('prefers an exact match over a prefix that would be ambiguous', () => {
    const overlapping = [
      { slug: 'familjen', title: 'Familjen' },
      { slug: 'familjen-stor', title: 'Familjen Stor' },
    ];

    const match = matchRoomByName(overlapping, 'familjen');
    expect(match.matched && match.room.slug).toBe('familjen');
  });

  it('refuses two rooms whose titles fold to the same string', () => {
    // A real state, not a contrived one: "Familjen" and "familjen" are both valid
    // titles, and picking the first is picking at random.
    const collide = [
      { slug: 'familjen', title: 'Familjen' },
      { slug: 'familjen-2', title: 'familjen' },
    ];

    const match = matchRoomByName(collide, 'Familjen');
    // The slug is exact for the first one, so that still wins — which is right, because
    // a slug is unique by construction and a title is not.
    expect(match.matched && match.room.slug).toBe('familjen');

    const byTitleOnly = matchRoomByName(
      [
        { slug: 'a', title: 'Familjen' },
        { slug: 'b', title: 'familjen' },
      ],
      'Familjen',
    );
    expect(byTitleOnly.matched).toBe(false);
    expect(!byTitleOnly.matched && byTitleOnly.reason).toBe('ambiguous');
  });

  it('finds nothing among no rooms', () => {
    const match = matchRoomByName([], 'Mallorca');
    expect(match.matched).toBe(false);
    expect(!match.matched && match.reason).toBe('no_match');
  });

  it('treats a name that folds to nothing as empty', () => {
    const match = matchRoomByName(rooms, '   !!!   ');
    expect(match.matched).toBe(false);
    expect(!match.matched && match.reason).toBe('empty');
  });

  it('never matches a room outside the candidates it was given', () => {
    // The candidates are the access decision. This function decides which name matches,
    // never whether the person may reach it.
    const match = matchRoomByName([{ slug: 'emil', title: 'Emil' }], 'Buyersclub Ledning');
    expect(match.matched).toBe(false);
  });
});
