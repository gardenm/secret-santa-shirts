import { describe, expect, it } from "vitest";
import { atTimeIn, dayKeyIn, endOfDayIn, shiftDays } from "./dates";
import {
  REMINDER_DAYS,
  daysUntil,
  planReminderRun,
  remindersDue,
  stateFor,
  type ReminderPerson,
} from "./reminders";

const TZ = "America/Toronto";

/** Deadlines are the *end* of their day, which is how the app now stores them. */
const DEADLINE_DAY = "2026-12-01";
const DEADLINE = endOfDayIn(DEADLINE_DAY, TZ);
const REVEAL = endOfDayIn("2026-12-20", TZ);

/** Mid-morning on the day `n` days before the deadline, local time. */
function daysBefore(n: number): Date {
  return atTimeIn(shiftDays(DEADLINE_DAY, -n), { hour: 11 }, TZ);
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
    expect(daysUntil(DEADLINE, atTimeIn("2026-11-24", { hour: 9 }, TZ), TZ)).toBe(7);
    expect(daysUntil(DEADLINE, atTimeIn("2026-11-24", { hour: 23 }, TZ), TZ)).toBe(7);
    expect(daysUntil(DEADLINE, atTimeIn("2026-12-01", { hour: 0 }, TZ), TZ)).toBe(0);
  });

  it("goes negative after the deadline", () => {
    expect(daysUntil(DEADLINE, atTimeIn("2026-12-02", { hour: 12 }, TZ), TZ)).toBe(-1);
  });
});

describe("remindersDue", () => {
  const people = [person("Alex", false), person("Bailey", true), person("Casey", false, true)];

  it("nudges on each scheduled day", () => {
    for (const day of REMINDER_DAYS) {
      const plan = remindersDue(OPEN, people, daysBefore(day), TZ);
      expect(plan.nudge.length).toBeGreaterThan(0);
      expect(plan.daysLeft).toBe(day);
    }
  });

  it("stays quiet on days that are not scheduled", () => {
    for (const day of [10, 6, 5, 4, 3]) {
      expect(remindersDue(OPEN, people, daysBefore(day), TZ).nudge).toEqual([]);
    }
  });

  it("only nudges people who have not finished", () => {
    const plan = remindersDue(OPEN, people, daysBefore(2), TZ);

    expect(plan.nudge.map((p) => p.displayName).sort()).toEqual(["Alex", "Casey"]);
    expect(plan.nudge.map((p) => p.displayName)).not.toContain("Bailey");
  });

  it("nudges the organizer too when they are behind", () => {
    // Being the admin is not an exemption from making a shirt.
    const plan = remindersDue(OPEN, people, daysBefore(1), TZ);
    expect(plan.nudge.map((p) => p.displayName)).toContain("Casey");
  });

  it("sends the organizer a digest of who is outstanding", () => {
    const plan = remindersDue(OPEN, people, daysBefore(7), TZ);

    expect(plan.digestFor.map((p) => p.displayName)).toEqual(["Casey"]);
    expect(plan.outstanding.sort()).toEqual(["Alex", "Casey"]);
  });

  it("sends nothing once everyone has finished", () => {
    const done = [person("Alex", true), person("Bailey", true)];
    const plan = remindersDue(OPEN, done, daysBefore(1), TZ);

    expect(plan.nudge).toEqual([]);
    expect(plan.digestFor).toEqual([]);
  });

  it("stops after the deadline has passed", () => {
    // Chasing people now only annoys them; the organizer has the extend button.
    const plan = remindersDue(OPEN, people, daysBefore(-4), TZ);

    expect(plan.nudge).toEqual([]);
    expect(plan.daysLeft).toBeLessThan(0);
  });

  it("sends nothing before the draw has run", () => {
    const plan = remindersDue({ deadline: DEADLINE, state: "setup" }, people, daysBefore(2), TZ);
    expect(plan.nudge).toEqual([]);
  });

  it("sends nothing once the exchange is locked", () => {
    const plan = remindersDue({ deadline: DEADLINE, state: "locked" }, people, daysBefore(2), TZ);
    expect(plan.nudge).toEqual([]);
  });

  it("reports the same plan for two runs on the same day", () => {
    // The cron can fire more than once; the plan must not drift between runs
    // within a day, or the second run would nudge a different set.
    const morning = remindersDue(OPEN, people, atTimeIn("2026-11-29", { hour: 8 }, TZ), TZ);
    const evening = remindersDue(OPEN, people, atTimeIn("2026-11-29", { hour: 20 }, TZ), TZ);

    expect(morning.nudge.map((p) => p.participantId)).toEqual(
      evening.nudge.map((p) => p.participantId),
    );
  });

});

describe("planReminderRun", () => {
  const people = [person("Alex", false), person("Bailey", true), person("Casey", false, true)];
  const event = { deadline: DEADLINE, revealAt: REVEAL, state: "open", lastReminderDay: null };

  it("still nudges on the deadline day itself, and only locks the day after", () => {
    // The bug this exists to prevent. The run advances state and then plans
    // reminders from the *new* state, so with a midnight-UTC deadline the
    // event was already "locked" by the time remindersDue saw it, and the
    // day-0 "today's the deadline" nudge could never fire. The old unit tests
    // passed anyway, because they handed remindersDue a state the route never
    // produced - so this drives the whole decision instead.
    const morning = planReminderRun(event, people, atTimeIn(DEADLINE_DAY, { hour: 11 }, TZ), TZ);

    expect(morning.nextState).toBeNull();
    expect(morning.plan.daysLeft).toBe(0);
    expect(morning.plan.nudge.map((p) => p.displayName).sort()).toEqual(["Alex", "Casey"]);

    // Late that evening people can still submit - the deadline is the end of
    // the day, which is what everyone assumes it means.
    const evening = planReminderRun(
      event,
      people,
      atTimeIn(DEADLINE_DAY, { hour: 23, minute: 30 }, TZ),
      TZ,
    );
    expect(evening.nextState).toBeNull();

    // The next run locks it, and stops nudging.
    const after = planReminderRun(
      event,
      people,
      atTimeIn(shiftDays(DEADLINE_DAY, 1), { hour: 11 }, TZ),
      TZ,
    );
    expect(after.nextState).toBe("locked");
    expect(after.plan.nudge).toEqual([]);
  });

  it("refuses to nudge twice on the same local day", () => {
    // Vercel retries a failed cron and the endpoint can be triggered by hand.
    // Being nagged twice about the same deadline reads as a broken app.
    const at = daysBefore(2);
    const first = planReminderRun(event, people, at, TZ);

    expect(first.alreadySentToday).toBe(false);
    expect(first.plan.nudge.length).toBeGreaterThan(0);

    const second = planReminderRun({ ...event, lastReminderDay: first.today }, people, at, TZ);
    expect(second.alreadySentToday).toBe(true);
  });

  it("counts the day in the group's zone, not the server's", () => {
    // A run just after local midnight is a new day and may nudge again; one
    // late the previous evening is not, even though UTC has already rolled
    // over. Keying this on the UTC day would send twice on one local day and
    // skip another entirely.
    const lateEvening = atTimeIn(shiftDays(DEADLINE_DAY, -3), { hour: 23 }, TZ);
    const afterMidnight = atTimeIn(shiftDays(DEADLINE_DAY, -2), { hour: 1 }, TZ);

    // Both instants fall on the same UTC day, and on different local days.
    expect(lateEvening.toISOString().slice(0, 10)).toBe(afterMidnight.toISOString().slice(0, 10));

    const evening = planReminderRun(event, people, lateEvening, TZ);
    const next = planReminderRun({ ...event, lastReminderDay: evening.today }, people, afterMidnight, TZ);

    expect(next.today).not.toBe(evening.today);
    expect(next.alreadySentToday).toBe(false);
  });

  it("still advances state on a day whose reminders already went out", () => {
    // The two jobs are independent: skipping a duplicate nudge must not leave
    // the exchange open past its deadline.
    const run = planReminderRun(
      { ...event, lastReminderDay: dayKeyIn(REVEAL, TZ), state: "locked" },
      people,
      atTimeIn(shiftDays("2026-12-20", 1), { hour: 11 }, TZ),
      TZ,
    );

    expect(run.nextState).toBe("revealed");
  });
});

describe("stateFor", () => {
  const event = { deadline: DEADLINE, revealAt: REVEAL, state: "open" };

  const dayAfterDeadline = atTimeIn("2026-12-02", { hour: 11 }, TZ);
  const dayAfterReveal = atTimeIn("2026-12-21", { hour: 11 }, TZ);

  it("leaves an open exchange alone before the deadline", () => {
    expect(stateFor(event, atTimeIn("2026-11-20", { hour: 11 }, TZ))).toBeNull();
  });

  it("locks it once the deadline passes", () => {
    expect(stateFor(event, dayAfterDeadline)).toBe("locked");
  });

  it("reveals it once the reveal date passes", () => {
    expect(stateFor({ ...event, state: "locked" }, dayAfterReveal)).toBe("revealed");
  });

  it("does not rewind a state that is already correct", () => {
    expect(stateFor({ ...event, state: "locked" }, dayAfterDeadline)).toBeNull();
    expect(stateFor({ ...event, state: "revealed" }, dayAfterReveal)).toBeNull();
  });

  it("never advances an exchange whose draw has not run", () => {
    // An event still in setup has no assignments; locking it would be
    // meaningless and would hide the admin's draw button.
    expect(stateFor({ ...event, state: "setup" }, dayAfterReveal)).toBeNull();
  });
});
