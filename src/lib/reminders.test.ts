import { describe, expect, it } from "vitest";
import {
  REMINDER_DAYS,
  daysUntil,
  remindersDue,
  stateFor,
  type ReminderPerson,
} from "./reminders";

const DEADLINE = new Date("2026-12-01T00:00:00Z");
const REVEAL = new Date("2026-12-20T00:00:00Z");

function daysBefore(n: number): Date {
  return new Date(DEADLINE.getTime() - n * 86_400_000);
}

function person(name: string, hasSubmitted: boolean, isAdmin = false): ReminderPerson {
  return {
    participantId: name.toLowerCase(),
    displayName: name,
    email: `${name.toLowerCase()}@example.com`,
    hasSubmitted,
    isAdmin,
  };
}

const OPEN = { deadline: DEADLINE, state: "open" };

describe("daysUntil", () => {
  it("counts whole days regardless of time of day", () => {
    // A cron firing at 09:00 must not report a different number of days than
    // one firing at 23:00 - that is exactly how a reminder day gets skipped.
    expect(daysUntil(DEADLINE, new Date("2026-11-24T09:00:00Z"))).toBe(7);
    expect(daysUntil(DEADLINE, new Date("2026-11-24T23:59:00Z"))).toBe(7);
    expect(daysUntil(DEADLINE, new Date("2026-12-01T00:00:01Z"))).toBe(0);
  });

  it("goes negative after the deadline", () => {
    expect(daysUntil(DEADLINE, new Date("2026-12-02T12:00:00Z"))).toBe(-1);
  });
});

describe("remindersDue", () => {
  const people = [person("Alex", false), person("Bailey", true), person("Casey", false, true)];

  it("nudges on each scheduled day", () => {
    for (const day of REMINDER_DAYS) {
      const plan = remindersDue(OPEN, people, daysBefore(day));
      expect(plan.nudge.length).toBeGreaterThan(0);
      expect(plan.daysLeft).toBe(day);
    }
  });

  it("stays quiet on days that are not scheduled", () => {
    for (const day of [10, 6, 5, 4, 3]) {
      expect(remindersDue(OPEN, people, daysBefore(day)).nudge).toEqual([]);
    }
  });

  it("only nudges people who have not finished", () => {
    const plan = remindersDue(OPEN, people, daysBefore(2));

    expect(plan.nudge.map((p) => p.displayName).sort()).toEqual(["Alex", "Casey"]);
    expect(plan.nudge.map((p) => p.displayName)).not.toContain("Bailey");
  });

  it("nudges the organizer too when they are behind", () => {
    // Being the admin is not an exemption from making a shirt.
    const plan = remindersDue(OPEN, people, daysBefore(1));
    expect(plan.nudge.map((p) => p.displayName)).toContain("Casey");
  });

  it("sends the organizer a digest of who is outstanding", () => {
    const plan = remindersDue(OPEN, people, daysBefore(7));

    expect(plan.digestFor.map((p) => p.displayName)).toEqual(["Casey"]);
    expect(plan.outstanding.sort()).toEqual(["Alex", "Casey"]);
  });

  it("sends nothing once everyone has finished", () => {
    const done = [person("Alex", true), person("Bailey", true)];
    const plan = remindersDue(OPEN, done, daysBefore(1));

    expect(plan.nudge).toEqual([]);
    expect(plan.digestFor).toEqual([]);
  });

  it("stops after the deadline has passed", () => {
    // Chasing people now only annoys them; the organizer has the extend button.
    const plan = remindersDue(OPEN, people, new Date("2026-12-05T00:00:00Z"));

    expect(plan.nudge).toEqual([]);
    expect(plan.daysLeft).toBeLessThan(0);
  });

  it("sends nothing before the draw has run", () => {
    const plan = remindersDue({ deadline: DEADLINE, state: "setup" }, people, daysBefore(2));
    expect(plan.nudge).toEqual([]);
  });

  it("sends nothing once the exchange is locked", () => {
    const plan = remindersDue({ deadline: DEADLINE, state: "locked" }, people, daysBefore(2));
    expect(plan.nudge).toEqual([]);
  });

  it("reports the same plan for two runs on the same day", () => {
    // The cron can fire more than once; the plan must not drift between runs
    // within a day, or the second run would nudge a different set.
    const morning = remindersDue(OPEN, people, new Date("2026-11-29T08:00:00Z"));
    const evening = remindersDue(OPEN, people, new Date("2026-11-29T20:00:00Z"));

    expect(morning.nudge.map((p) => p.participantId)).toEqual(
      evening.nudge.map((p) => p.participantId),
    );
  });
});

describe("stateFor", () => {
  const event = { deadline: DEADLINE, revealAt: REVEAL, state: "open" };

  it("leaves an open exchange alone before the deadline", () => {
    expect(stateFor(event, new Date("2026-11-20T00:00:00Z"))).toBeNull();
  });

  it("locks it once the deadline passes", () => {
    expect(stateFor(event, new Date("2026-12-02T00:00:00Z"))).toBe("locked");
  });

  it("reveals it once the reveal date passes", () => {
    expect(stateFor({ ...event, state: "locked" }, new Date("2026-12-21T00:00:00Z"))).toBe(
      "revealed",
    );
  });

  it("does not rewind a state that is already correct", () => {
    expect(stateFor({ ...event, state: "locked" }, new Date("2026-12-02T00:00:00Z"))).toBeNull();
    expect(stateFor({ ...event, state: "revealed" }, new Date("2026-12-21T00:00:00Z"))).toBeNull();
  });

  it("never advances an exchange whose draw has not run", () => {
    // An event still in setup has no assignments; locking it would be
    // meaningless and would hide the admin's draw button.
    expect(stateFor({ ...event, state: "setup" }, new Date("2026-12-21T00:00:00Z"))).toBeNull();
  });
});
