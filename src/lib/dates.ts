/**
 * Dates in the group's timezone, not the server's.
 *
 * The server runs in UTC. Left alone, a deadline of "December 1" parses as
 * 2026-12-01T00:00:00Z, which is 7pm on November 30 in Toronto and 4pm in
 * Vancouver - so people who believe they have all of December 1st get refused
 * the evening before. Every date in this app is a *calendar day* in one
 * timezone, and this module is the only place that converts between a calendar
 * day and an instant.
 *
 * No dependency: Intl already knows every zone's offsets and DST rules, which
 * is the hard part.
 */

/** The group's timezone. One exchange per deployment, so one zone. */
export function eventTimeZone(): string {
  return process.env.EVENT_TIMEZONE || "America/Toronto";
}

type Parts = { year: number; month: number; day: number; hour: number; minute: number; second: number };

function partsIn(instant: Date, timeZone: string): Parts {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    // h23 rather than hour12:false: the latter can render midnight as "24".
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });

  const found = Object.fromEntries(
    formatter.formatToParts(instant).map((part) => [part.type, part.value]),
  );

  return {
    year: Number(found.year),
    month: Number(found.month),
    day: Number(found.day),
    hour: Number(found.hour),
    minute: Number(found.minute),
    second: Number(found.second),
  };
}

/** How far ahead of UTC `timeZone` is at this instant, in milliseconds. */
function offsetAt(instant: Date, timeZone: string): number {
  const p = partsIn(instant, timeZone);
  const asIfUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  // Drop the milliseconds from the instant too - formatToParts has no ms.
  return asIfUtc - Math.floor(instant.getTime() / 1000) * 1000;
}

function parseDayKey(dayKey: string): { year: number; month: number; day: number } {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(dayKey.trim());
  if (!match) throw new Error(`Not a YYYY-MM-DD date: ${dayKey}`);
  return { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) };
}

/**
 * The instant at a given wall-clock time on a given calendar day in a zone.
 *
 * Solved by iteration rather than a lookup table: guess that the local time is
 * UTC, ask what the offset actually is there, correct, then confirm - the
 * second pass is what gets the days either side of a DST change right.
 */
export function atTimeIn(
  dayKey: string,
  time: { hour?: number; minute?: number; second?: number; ms?: number },
  timeZone: string = eventTimeZone(),
): Date {
  const { year, month, day } = parseDayKey(dayKey);
  const wall = Date.UTC(
    year,
    month - 1,
    day,
    time.hour ?? 0,
    time.minute ?? 0,
    time.second ?? 0,
    time.ms ?? 0,
  );

  let instant = wall - offsetAt(new Date(wall), timeZone);
  instant = wall - offsetAt(new Date(instant), timeZone);
  return new Date(instant);
}

/**
 * The last instant of a calendar day.
 *
 * This is what a deadline means: "December 1" is due at the end of December
 * 1st, not at the start of it.
 */
export function endOfDayIn(dayKey: string, timeZone: string = eventTimeZone()): Date {
  return atTimeIn(dayKey, { hour: 23, minute: 59, second: 59, ms: 999 }, timeZone);
}

/** The calendar day an instant falls on, as YYYY-MM-DD. */
export function dayKeyIn(instant: Date, timeZone: string = eventTimeZone()): string {
  const p = partsIn(instant, timeZone);
  return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
}

/** Calendar arithmetic on a day key, with no timezone involved at all. */
export function shiftDays(dayKey: string, days: number): string {
  const { year, month, day } = parseDayKey(dayKey);
  const shifted = new Date(Date.UTC(year, month - 1, day + days));
  return shifted.toISOString().slice(0, 10);
}

/**
 * Whole calendar days from `today` to `deadline`, counted in `timeZone`.
 *
 * Compares days, not instants, so a run at 09:00 and one at 23:00 give the same
 * answer - that is exactly how a reminder day gets skipped otherwise.
 */
export function daysUntilIn(
  deadline: Date,
  today: Date,
  timeZone: string = eventTimeZone(),
): number {
  const toUtcMidnight = (dayKey: string) => {
    const { year, month, day } = parseDayKey(dayKey);
    return Date.UTC(year, month - 1, day);
  };

  return Math.round(
    (toUtcMidnight(dayKeyIn(deadline, timeZone)) - toUtcMidnight(dayKeyIn(today, timeZone))) /
      86_400_000,
  );
}

/**
 * A date for people to read, in the group's zone.
 *
 * Never `toLocaleDateString()` with no zone: on Vercel the server locale is
 * UTC, so an end-of-day deadline renders as the following morning.
 */
export function formatEventDate(instant: Date, timeZone: string = eventTimeZone()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone, dateStyle: "long" }).format(instant);
}
