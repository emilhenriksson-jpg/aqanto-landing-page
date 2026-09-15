/**
 * Day boundaries.
 *
 * A day is the unit of the calendar, so where a day starts is a product decision and not
 * an implementation detail. It is the person's own midnight: a fact saved at 23:40 in
 * Stockholm belongs to that evening, and putting it in tomorrow because the server stores
 * UTC would make the calendar wrong in exactly the way that makes someone stop trusting
 * it.
 *
 * Both backends ask for a half-open range in absolute time and query on that, rather than
 * doing timezone arithmetic in SQL and again in JS. One implementation of midnight.
 */

/** Swedish product, Swedish clock, until a person's own zone is stored on them. */
export const DEFAULT_TIME_ZONE = 'Europe/Stockholm';

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export function isCalendarDate(value: string): boolean {
  if (!ISO_DATE.test(value)) return false;
  const [y, m, d] = value.split('-').map(Number) as [number, number, number];
  if (m < 1 || m > 12 || d < 1 || d > 31) return false;
  const probe = new Date(Date.UTC(y, m - 1, d));
  return probe.getUTCFullYear() === y && probe.getUTCMonth() === m - 1 && probe.getUTCDate() === d;
}

/**
 * How far `timeZone` is ahead of UTC at that instant, in milliseconds.
 *
 * Read out of `Intl` rather than from a table, so DST is whatever the platform's tz
 * database says it is. Formatting the instant in the zone and reading it back as if it
 * were UTC gives the offset by subtraction, which is the standard trick and the only one
 * that does not need a dependency.
 */
function offsetMs(instant: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(instant);

  const at = (type: string): number => Number(parts.find((p) => p.type === type)?.value ?? '0');
  // `hour12: false` renders midnight as 24 in some ICU versions.
  const hour = at('hour') % 24;

  const asUtc = Date.UTC(at('year'), at('month') - 1, at('day'), hour, at('minute'), at('second'));
  return asUtc - Math.floor(instant.getTime() / 1000) * 1000;
}

/** `YYYY-MM-DD` for an instant, as the clock on that person's wall read. */
export function calendarDateOf(instant: Date, timeZone = DEFAULT_TIME_ZONE): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(instant);
  const at = (type: string): string => parts.find((p) => p.type === type)?.value ?? '';
  return `${at('year')}-${at('month')}-${at('day')}`;
}

/**
 * The half-open range `[from, to)` covering one local day.
 *
 * Resolved twice because the offset depends on the instant and the instant depends on the
 * offset: a first guess using the offset at UTC midnight, then a correction using the
 * offset at the guessed local midnight. That second pass is what makes the two days a year
 * when the clocks change come out with 23 and 25 hours instead of silently losing an hour
 * of someone's memory.
 */
export function calendarDayRange(
  date: string,
  timeZone = DEFAULT_TIME_ZONE,
): { from: Date; to: Date } {
  if (!isCalendarDate(date)) {
    throw new RangeError(`Ogiltigt datum: ${date}`);
  }
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const utcMidnight = Date.UTC(y, m - 1, d);

  const start = (dayOffset: number): Date => {
    const base = utcMidnight + dayOffset * 86_400_000;
    const guess = new Date(base - offsetMs(new Date(base), timeZone));
    return new Date(base - offsetMs(guess, timeZone));
  };

  return { from: start(0), to: start(1) };
}

/** `YYYY-MM-DD` shifted by whole local days. Used for stepping between days. */
export function shiftCalendarDate(date: string, days: number): string {
  if (!isCalendarDate(date)) throw new RangeError(`Ogiltigt datum: ${date}`);
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const shifted = new Date(Date.UTC(y, m - 1, d + days));
  return shifted.toISOString().slice(0, 10);
}
