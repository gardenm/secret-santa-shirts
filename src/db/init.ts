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

  const deadlineDate = new Date(deadline);
  const revealDate = new Date(revealAt);
  if (Number.isNaN(deadlineDate.getTime()) || Number.isNaN(revealDate.getTime())) {
    console.error("Dates must be parseable, e.g. 2026-12-01.");
    process.exit(1);
  }
  if (revealDate < deadlineDate) {
    console.error("The reveal date should be on or after the design deadline.");
    process.exit(1);
  }

  const existing = await currentEvent(db);
  if (existing) {
    console.error(
      `An exchange already exists ("${existing.name}"). This deployment runs one at a time.`,
    );
    process.exit(1);
  }

  const [event] = await db
    .insert(events)
    .values({ name, deadline: deadlineDate, revealAt: revealDate })
    .returning();

  const { added } = await addInvites(db, event.id, emails);

  console.log(`Created "${event.name}".`);
  console.log(`Invited ${added} ${added === 1 ? "person" : "people"}.`);
  console.log(`\nThe first to sign in becomes the organizer. Invite the rest from /admin.`);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
