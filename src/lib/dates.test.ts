import { describe, expect, it } from "vitest";
import {
  atTimeIn,
  dayKeyIn,
  daysUntilIn,
  endOfDayIn,
  eventTimeZone,
  formatEventDate,
  shiftDays,
} from "./dates";

const TORONTO = "America/Toronto";
const VANCOUVER = "America/Vancouver";

describe("endOfDayIn", () => {
  it("puts a deadline at the end of its day, not the start", () => {
    // The bug this module exists for: `new Date("2026-12-01")` is
    // 2026-12-01T00:00:00Z, which is 7pm on November 30 in Toronto. People who
    // believed they had all of December 1st were refused the evening before.
    const deadline = endOfDayIn("2026-12-01", TORONTO);

    expect(deadline.toISOString()).toBe("2026-12-02T04:59:59.999Z");
    expect(deadline.getTime()).toBeGreaterThan(new Date("2026-12-01T23:00:00Z").getTime());
  });

  it("follows the zone, not the server", () => {
    // Asserted as a relationship rather than an absolute, because the absolute
    // is not ours to predict: tzdata 2026c has Vancouver on permanent PDT, so
    // the "obvious" UTC-8 for December is simply wrong. That is the argument
    // for asking Intl instead of hardcoding an offset anywhere.
    const toronto = endOfDayIn("2026-12-01", TORONTO);
    const vancouver = endOfDayIn("2026-12-01", VANCOUVER);

    expect(vancouver.getTime()).toBeGreaterThan(toronto.getTime());
    // Whatever the offsets are, both must land on the last second of Dec 1st
    // as their own zone tells it.
    expect(dayKeyIn(vancouver, VANCOUVER)).toBe("2026-12-01");
    expect(dayKeyIn(toronto, TORONTO)).toBe("2026-12-01");
    expect(dayKeyIn(new Date(vancouver.getTime() + 1), VANCOUVER)).toBe("2026-12-02");
  });

  it("gets the offset right on both sides of a DST change", () => {
    // Toronto leaves DST on 2026-11-01. A fixed -5 or -4 offset would be an
    // hour wrong on one side of this.
    expect(endOfDayIn("2026-10-31", TORONTO).toISOString()).toBe("2026-11-01T03:59:59.999Z");
    expect(endOfDayIn("2026-11-02", TORONTO).toISOString()).toBe("2026-11-03T04:59:59.999Z");
  });

  it("handles the spring-forward day, when a local hour does not exist", () => {
    // 2026-03-08 in Toronto has no 02:30 local. End of day is unaffected, but
    // the iteration must not fall over reaching it.
    expect(endOfDayIn("2026-03-08", TORONTO).toISOString()).toBe("2026-03-09T03:59:59.999Z");
  });
});

describe("dayKeyIn", () => {
  it("names the local day, which is not always the UTC day", () => {
    // 03:00 UTC is still the previous evening in Toronto. Anything keyed on
    // the UTC day - a once-per-day guard, say - would fire on the wrong day.
    expect(dayKeyIn(new Date("2026-12-02T03:00:00Z"), TORONTO)).toBe("2026-12-01");
    expect(dayKeyIn(new Date("2026-12-02T13:00:00Z"), TORONTO)).toBe("2026-12-02");
  });
});

describe("daysUntilIn", () => {
  const deadline = endOfDayIn("2026-12-01", TORONTO);

  it("counts whole days regardless of time of day", () => {
    // A cron firing at 09:00 must not report a different number of days than
    // one firing at 23:00 - that is exactly how a reminder day gets skipped.
    expect(daysUntilIn(deadline, atTimeIn("2026-11-24", { hour: 9 }, TORONTO), TORONTO)).toBe(7);
    expect(daysUntilIn(deadline, atTimeIn("2026-11-24", { hour: 23 }, TORONTO), TORONTO)).toBe(7);
  });

  it("still reads zero during the deadline day itself", () => {
    // The reminder that says "today's the deadline" depends on this: with an
    // end-of-day deadline and UTC-day arithmetic it would read 1 all day.
    expect(daysUntilIn(deadline, atTimeIn("2026-12-01", { hour: 8 }, TORONTO), TORONTO)).toBe(0);
    expect(daysUntilIn(deadline, atTimeIn("2026-12-01", { hour: 22 }, TORONTO), TORONTO)).toBe(0);
  });

  it("goes negative only once the day is over", () => {
    expect(daysUntilIn(deadline, atTimeIn("2026-12-02", { hour: 1 }, TORONTO), TORONTO)).toBe(-1);
  });
});

describe("shiftDays", () => {
  it("does calendar arithmetic, including across a month and a year", () => {
    expect(shiftDays("2026-12-01", -7)).toBe("2026-11-24");
    expect(shiftDays("2026-12-31", 1)).toBe("2027-01-01");
  });
});

describe("formatEventDate", () => {
  it("renders an end-of-day deadline as its own day, not the next morning", () => {
    // The reason every toLocaleDateString() call had to change: on Vercel the
    // server locale is UTC, where this instant is already December 2nd.
    expect(formatEventDate(endOfDayIn("2026-12-01", TORONTO), TORONTO)).toBe("December 1, 2026");
  });
});

describe("eventTimeZone", () => {
  it("defaults to the group's zone and can be overridden", () => {
    const original = process.env.EVENT_TIMEZONE;
    try {
      delete process.env.EVENT_TIMEZONE;
      expect(eventTimeZone()).toBe("America/Toronto");

      // An empty string is how an env var usually arrives unset; it must not
      // win and leave Intl with an invalid zone.
      process.env.EVENT_TIMEZONE = "";
      expect(eventTimeZone()).toBe("America/Toronto");

      process.env.EVENT_TIMEZONE = VANCOUVER;
      expect(eventTimeZone()).toBe(VANCOUVER);
    } finally {
      if (original === undefined) delete process.env.EVENT_TIMEZONE;
      else process.env.EVENT_TIMEZONE = original;
    }
  });
});
