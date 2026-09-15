import { apiFetch } from './client.js';
import type { CalendarDayDto, MemoryEventDetailDto } from './types.js';

/** One day of memory events — GET /v1/calendar/day. */
export function getCalendarDay(input: {
  date: string;
  timeZone?: string;
  roomId?: string;
}): Promise<CalendarDayDto> {
  const query = new URLSearchParams({ date: input.date });
  if (input.timeZone) query.set('tz', input.timeZone);
  if (input.roomId) query.set('room', input.roomId);
  return apiFetch(`/v1/calendar/day?${query.toString()}`);
}

/** One event, zoomed to its revisions and its source — GET /v1/calendar/events/:seq. */
export function getCalendarEvent(seq: number): Promise<MemoryEventDetailDto> {
  return apiFetch(`/v1/calendar/events/${seq}`);
}
