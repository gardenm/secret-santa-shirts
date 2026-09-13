/**
 * Creates the exchange: `npm run db:init -- "Name" 2026-12-01 2026-12-20 you@example.com`
 *
 * There is deliberately no UI for this. Someone has to exist before anyone can
 * sign in - the invite list is the access control - so the first organizer is
 * bootstrapped from the command line, and becomes admin on first sign-in.
 */
import "dotenv/config";
import { db } from "./index";
import { events } from "./schema";
import { endOfDayIn, eventTimeZone, formatEventDate } from "@/lib/dates";
import { addInvites, currentEvent } from "@/lib/invites";

async function main() {
  const [name, deadline, revealAt, ...emails] = process.argv.slice(2);

  if (!name || !deadline || !revealAt || emails.length === 0) {
    console.error(
      'Usage: npm run db:init -- "Exchange name" <deadline> <reveal date> <organizer email> [more emails...]\n' +
        'Example: npm run db:init -- "Shirt Santa 2026" 2026-12-01 2026-12-20 you@example.com',
    );
    process.exit(1);
  }

  // Both dates are the END of their day in the group's timezone. "2026-12-01"
  // means people have all of December 1st, not until the stroke of midnight
  // that starts it - which in Toronto would be 7pm on November 30th.
  const timeZone = eventTimeZone();
  let deadlineDate: Date;
  let revealDate: Date;
  try {
    deadlineDate = endOfDayIn(deadline, timeZone);
    revealDate = endOfDayIn(revealAt, timeZone);
  } catch {
    console.error("Dates must be written as YYYY-MM-DD, e.g. 2026-12-01.");
    process.exit(1);
  }
  if (revealDate < deadlineDate) {
    console.error("The reveal date should be on or after the design deadline.");
    process.exit(1);
  }

  // This guard is a correctness boundary, not a product preference.
  //
  // The schema is genuinely multi-event - everything is keyed on eventId - but
  // three functions in lib/invites.ts assume there is only ever one:
  // currentEvent() takes the first row unfiltered, isInvited() matches an email
  // against ALL invites, and participantForUser() returns the first participant
  // row for a user. With a second event present, someone invited to one
  // exchange could sign in and land in the other's dashboard. That is a privacy
  // bug, not a missing feature.
  //
  // Do not remove this to run a second exchange. Deploy a second copy of the
  // app instead - see the README - or fix those three functions first.
  const existing = await currentEvent(db);
  if (existing) {
    console.error(
      `An exchange already exists ("${existing.name}").\n\n` +
        `This deployment runs one exchange at a time, and that limit is doing real work: the\n` +
        `sign-in and participant lookups do not filter by event, so a second exchange here would\n` +
        `let people see each other's. To run one for another group, deploy a second copy of the\n` +
        `app with its own database - it takes about ten minutes, see the README.`,
    );
    process.exit(1);
  }

  const [event] = await db
    .insert(events)
    .values({ name, deadline: deadlineDate, revealAt: revealDate })
    .returning();

  const { added } = await addInvites(db, event.id, emails);

  console.log(`Created "${event.name}".`);
  // Echoed back so a timezone surprise is caught here rather than in December.
  console.log(`Designs due end of ${formatEventDate(deadlineDate, timeZone)} (${timeZone}).`);
  console.log(`Reveal on ${formatEventDate(revealDate, timeZone)}.`);
  console.log(`Invited ${added} ${added === 1 ? "person" : "people"}.`);
  console.log(`\nThe first to sign in becomes the organizer. Invite the rest from /admin.`);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
