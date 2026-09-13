import { dayKeyIn, daysUntilIn, eventTimeZone } from "./dates";

/**
 * Who gets nudged, and when.
 *
 * Deliberately pure: no database, no email, no clock of its own. This is where
 * an off-by-one silently means nobody is reminded and the organizer finds out
 * on deadline day, so it is the part worth testing properly. Sending is a thin
 * wrapper around someone else's SDK and gets none.
 *
 * Days are counted in the group's timezone. They have to be: a deadline is the
 * end of a local day, so UTC-day arithmetic reads "1 day left" for the whole of
 * the deadline day and the day-0 nudge never fires.
 */

/** Days before the deadline on which a nudge goes out. */
export const REMINDER_DAYS = [7, 2, 1, 0];

export type ReminderPerson = {
  participantId: string;
  displayName: string;
  email: string;
  /** Has this person finished the design they owe someone else? */
  hasSubmitted: boolean;
  isAdmin: boolean;
};

export type ReminderPlan = {
  /** Days remaining, for the message copy. */
  daysLeft: number;
  nudge: ReminderPerson[];
  /** Digest for the organizer; empty when nobody is outstanding. */
  digestFor: ReminderPerson[];
  outstanding: string[];
};

/** Whole calendar days from `today` to `deadline`, counted in the group's zone. */
export function daysUntil(
  deadline: Date,
  today: Date,
  timeZone: string = eventTimeZone(),
): number {
  return daysUntilIn(deadline, today, timeZone);
}

export function remindersDue(
  event: { deadline: Date; state: string },
  people: ReminderPerson[],
  today: Date,
  timeZone: string = eventTimeZone(),
): ReminderPlan {
  const daysLeft = daysUntil(event.deadline, today, timeZone);
  const outstanding = people.filter((p) => !p.hasSubmitted);

  const empty: ReminderPlan = {
    daysLeft,
    nudge: [],
    digestFor: [],
    outstanding: outstanding.map((p) => p.displayName),
  };

  // Past the deadline, or the exchange has moved on: chasing people now would
  // only annoy them, and the organizer has the extend button if they want more
  // time.
  if (daysLeft < 0) return empty;
  if (event.state !== "open") return empty;

  // Only on the scheduled days. Running the cron twice in one day therefore
  // sends the same set twice, which is why the caller records what it sent -
  // but running it on an unscheduled day sends nothing at all.
  if (!REMINDER_DAYS.includes(daysLeft)) return empty;

  if (outstanding.length === 0) return empty;

  return {
    daysLeft,
    nudge: outstanding,
    digestFor: people.filter((p) => p.isAdmin),
    outstanding: outstanding.map((p) => p.displayName),
  };
}

/**
 * What the event's state should be, given the clock. Returned rather than
 * applied so the caller decides whether to write.
 */
export function stateFor(
  event: { deadline: Date; revealAt: Date; state: string },
  now: Date,
): "open" | "locked" | "revealed" | null {
  if (event.state === "setup") return null; // the draw has not run yet

  if (now >= event.revealAt) return event.state === "revealed" ? null : "revealed";
  if (now >= event.deadline) return event.state === "locked" ? null : "locked";
  return null;
}

export type ReminderRun = {
  /** The local day this run belongs to, for the once-a-day record. */
  today: string;
  /** State to write, or null to leave it alone. */
  nextState: "open" | "locked" | "revealed" | null;
  plan: ReminderPlan;
  /** True when this day's nudges have already gone out. */
  alreadySentToday: boolean;
};

/**
 * Everything the cron run decides, in one pure function.
 *
 * Worth pulling out of the route: the ordering between advancing state and
 * planning reminders is load-bearing, and getting it wrong is invisible. The
 * previous version locked the event first and then planned from the *new*
 * state, so on deadline day `remindersDue` saw "locked" and the day-0 nudge
 * could never fire. The unit tests passed anyway, because they handed
 * `remindersDue` a state the route never actually produced.
 *
 * Deadlines are the end of a local day, so this now works out: on the morning
 * of the deadline nothing is locked yet, the last-chance nudge goes out, and
 * the following run does the locking.
 */
export function planReminderRun(
  event: {
    deadline: Date;
    revealAt: Date;
    state: string;
    lastReminderDay?: string | null;
  },
  people: ReminderPerson[],
  now: Date,
  timeZone: string = eventTimeZone(),
): ReminderRun {
  const nextState = stateFor(event, now);
  const plan = remindersDue(
    { deadline: event.deadline, state: nextState ?? event.state },
    people,
    now,
    timeZone,
  );

  const today = dayKeyIn(now, timeZone);

  return {
    today,
    nextState,
    plan,
    // Only nudges are once-a-day; a run that sends nothing has nothing to
    // repeat, and state still needs advancing either way.
    alreadySentToday: plan.nudge.length > 0 && event.lastReminderDay === today,
  };
}

export function nudgeSubject(daysLeft: number, eventName: string): string {
  if (daysLeft === 0) return `Today's the deadline for ${eventName}`;
  if (daysLeft === 1) return `One day left to finish your ${eventName} design`;
  return `${daysLeft} days left for ${eventName}`;
}

export function nudgeBody(person: ReminderPerson, daysLeft: number, url: string): string {
  const when =
    daysLeft === 0
      ? "today"
      : daysLeft === 1
        ? "tomorrow"
        : `in ${daysLeft} days`;

  return [
    `Hi ${person.displayName},`,
    "",
    `Your shirt design is due ${when} and it isn't finished yet. Someone is going to open a`,
    `box with your artwork on a t-shirt, so it would be a shame to miss it.`,
    "",
    `Pick it back up here: ${url}`,
    "",
    `You can draw something, describe one and have it generated, or upload anything you've`,
    `already made.`,
  ].join("\n");
}

export function digestBody(outstanding: string[], daysLeft: number, url: string): string {
  return [
    daysLeft === 0
      ? `Today is the deadline. Still waiting on ${outstanding.length}:`
      : `${daysLeft} days to go. Still waiting on ${outstanding.length}:`,
    "",
    ...outstanding.map((name) => `  - ${name}`),
    "",
    `Organizer tools: ${url}`,
    "",
    `If they need longer, you can move the deadline there.`,
  ].join("\n");
}
