import { describe, expect, it } from 'vitest';

import {
  DEFAULT_TIME_ZONE,
  calendarDateOf,
  calendarDayRange,
  isCalendarDate,
  shiftCalendarDate,
} from './calendar.js';
import {
  deriveMotivation,
  deriveSource,
  memoryEventKindOf,
} from './provenance.js';

/**
 * A day is the unit of the calendar, so where a day starts is a product decision. It is
 * the person's own midnight: a fact saved at 23:40 in Stockholm belongs to that evening,
 * and putting it in tomorrow because the server stores UTC is exactly the kind of wrong
 * that makes someone stop trusting the screen.
 */
describe('the day boundary', () => {
  it('starts and ends at the local midnight, not at UTC', () => {
    const { from, to } = calendarDayRange('2026-09-15', DEFAULT_TIME_ZONE);

    // Stockholm is UTC+2 in September, so the day opens at 22:00 the evening before.
    expect(from.toISOString()).toBe('2026-09-14T22:00:00.000Z');
    expect(to.toISOString()).toBe('2026-09-15T22:00:00.000Z');
  });

  it('puts a late-evening memory in the evening it happened', () => {
    const late = new Date('2026-09-15T21:40:00.000Z'); // 23:40 in Stockholm
    expect(calendarDateOf(late, DEFAULT_TIME_ZONE)).toBe('2026-09-15');

    const { from, to } = calendarDayRange('2026-09-15', DEFAULT_TIME_ZONE);
    expect(late >= from && late < to).toBe(true);
  });

  it('gives the clock-change days 23 and 25 hours', () => {
    // The offset depends on the instant and the instant depends on the offset, so this
    // is resolved twice. Getting it wrong loses an hour of somebody's memory twice a year.
    const spring = calendarDayRange('2026-03-29', DEFAULT_TIME_ZONE);
    const autumn = calendarDayRange('2026-10-25', DEFAULT_TIME_ZONE);

    expect((spring.to.getTime() - spring.from.getTime()) / 3_600_000).toBe(23);
    expect((autumn.to.getTime() - autumn.from.getTime()) / 3_600_000).toBe(25);
  });

  it('is always 24 hours somewhere that does not change its clocks', () => {
    const { from, to } = calendarDayRange('2026-03-29', 'Europe/Moscow');
    expect((to.getTime() - from.getTime()) / 3_600_000).toBe(24);
  });

  it('refuses a date that is not a date', () => {
    expect(isCalendarDate('2026-02-30')).toBe(false);
    expect(isCalendarDate('15/09/2026')).toBe(false);
    expect(isCalendarDate('2026-09-15')).toBe(true);
    expect(() => calendarDayRange('inte ett datum')).toThrow();
  });

  it('steps by whole days across a month boundary', () => {
    expect(shiftCalendarDate('2026-09-01', -1)).toBe('2026-08-31');
    expect(shiftCalendarDate('2026-12-31', 1)).toBe('2027-01-01');
  });
});

describe('what an event was', () => {
  it('separates a private save from one that landed in a room', () => {
    expect(memoryEventKindOf('item.created', 'personal')).toBe('saved_private');
    expect(memoryEventKindOf('item.created', 'shared')).toBe('saved_to_room');
  });

  it('reads a creation that replaces something as a correction', () => {
    // The 15 oktober becoming 1 november case. Calling it "saved" would lose both the
    // original value and the fact that anything changed.
    expect(memoryEventKindOf('item.created', 'personal', { supersedes: 'abc' })).toBe('updated');
  });

  it('maps the remaining log types onto the eight the calendar shows', () => {
    expect(memoryEventKindOf('item.superseded', 'shared')).toBe('updated');
    expect(memoryEventKindOf('item.shared', 'shared')).toBe('shared');
    expect(memoryEventKindOf('item.moved', 'shared')).toBe('moved');
    expect(memoryEventKindOf('item.deleted', 'personal')).toBe('deleted');
    expect(memoryEventKindOf('item.restored', 'personal')).toBe('restored');
    expect(memoryEventKindOf('item.disputed', 'shared')).toBe('disputed');
  });

  it('ignores everything the calendar is not a view over', () => {
    // An allowlist, so a new internal event type cannot leak into the day by being
    // forgotten about.
    expect(memoryEventKindOf('proposal.created', 'personal')).toBeNull();
    expect(memoryEventKindOf('item.purged', 'personal')).toBeNull();
    expect(memoryEventKindOf('rebuild.finished', 'personal')).toBeNull();
  });
});

describe('where the information came from', () => {
  it('reads a client plus a session as a conversation', () => {
    expect(deriveSource({ agentClient: 'claude-desktop', sessionRef: 's-1' })).toEqual({
      kind: 'conversation',
      label: 'Samtal med Claude',
      ref: 's-1',
      uri: null,
    });
  });

  it('prefers a document over the conversation that mentioned it', () => {
    const source = deriveSource({
      agentClient: 'claude-desktop',
      sessionRef: 's-1',
      documentId: 'doc-1',
      documentName: 'avtal.pdf',
    });
    expect(source).toMatchObject({ kind: 'document', label: 'avtal.pdf', ref: 'doc-1' });
  });

  it('knows the difference between the person typing and a model writing', () => {
    expect(deriveSource({ agentClient: 'web', sessionRef: null }).kind).toBe('manual');
    expect(deriveSource({ agentClient: null, sessionRef: null }).kind).toBe('unknown');
  });

  it('will not call a script a conversation', () => {
    // A confident wrong attribution in someone's own history is worse than an honest gap.
    const api = deriveSource({ agentClient: 'api', sessionRef: null });
    expect(api.kind).toBe('unknown');
    expect(api.label).not.toMatch(/Samtal/);

    const unknown = deriveSource({ agentClient: 'unknown', sessionRef: null });
    expect(unknown.label).toContain('okänd klient');
  });
});

describe('why it was stored there', () => {
  it('gives every kind a sentence a person can read', () => {
    // Every automatic action owes the person a sentence, so a model that forgot to write
    // one must not turn into a blank.
    for (const kind of [
      'saved_private',
      'saved_to_room',
      'shared',
      'updated',
      'moved',
      'deleted',
      'restored',
      'disputed',
    ] as const) {
      const text = deriveMotivation({ kind, roomTitle: 'Buyersclub Ledning', roomKind: 'shared' });
      expect(text.length).toBeGreaterThan(10);
      expect(text).not.toMatch(/undefined|null/);
    }
  });

  it('names both rooms on a move', () => {
    expect(
      deriveMotivation({
        kind: 'moved',
        roomTitle: 'Villan',
        roomKind: 'shared',
        fromRoomTitle: 'Ditt rum',
      }),
    ).toContain('Ditt rum');
  });
});
