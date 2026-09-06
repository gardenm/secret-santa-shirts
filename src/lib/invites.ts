import { and, eq } from "drizzle-orm";
import { events, invites, participants, users } from "@/db/schema";

/**
 * The invite list is the access-control list.
 *
 * Kept out of the Auth.js callback itself so it can be tested directly - the
 * rule that a stranger with the URL cannot join is worth more than a comment
 * saying so.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
type Db = any;

export class InviteError extends Error {}

/** Emails are stored and compared lowercased; mail is case-insensitive in practice. */
export function normaliseEmail(email: string): string {
  return email.trim().toLowerCase();
}

export async function addInvites(db: Db, eventId: string, emails: string[]) {
  const cleaned = [...new Set(emails.map(normaliseEmail).filter((e) => e.includes("@")))];
  if (cleaned.length === 0) return { added: 0 };

  const rows = await db
    .insert(invites)
    .values(cleaned.map((email) => ({ eventId, email })))
    .onConflictDoNothing()
    .returning();

  return { added: rows.length };
}

/**
 * True if this email may sign in at all.
 *
 * SINGLE-EVENT ASSUMPTION: matches against every invite in the table, not
 * against one exchange's. Safe only because db:init refuses to create a second
 * event - with two, an invite to either would open the door to both. Lifting
 * that limit means taking an eventId here first.
 */
export async function isInvited(db: Db, email: string): Promise<boolean> {
  const [row] = await db.select().from(invites).where(eq(invites.email, normaliseEmail(email)));
  return Boolean(row);
}

/**
 * Called after a successful sign-in: links the user to their event and creates
 * the participant row if this is their first visit.
 *
 * Idempotent, because magic links get clicked more than once.
 */
export async function acceptInvite(
  db: Db,
  user: { id: string; email: string; name?: string | null },
) {
  const email = normaliseEmail(user.email);
  const [invite] = await db.select().from(invites).where(eq(invites.email, email));
  if (!invite) throw new InviteError("That email is not on the invite list.");

  const [existing] = await db
    .select()
    .from(participants)
    .where(and(eq(participants.eventId, invite.eventId), eq(participants.userId, user.id)));

  if (existing) return existing;

  // First participant to join becomes the admin - someone has to assemble the
  // order, and it is whoever set the exchange up.
  const roster = await db
    .select()
    .from(participants)
    .where(eq(participants.eventId, invite.eventId));

  const [created] = await db
    .insert(participants)
    .values({
      eventId: invite.eventId,
      userId: user.id,
      displayName: user.name || email.split("@")[0],
      isAdmin: roster.length === 0,
    })
    .returning();

  await db.update(invites).set({ acceptedAt: new Date() }).where(eq(invites.id, invite.id));

  return created;
}

/**
 * The participant record for a signed-in user, or null.
 *
 * SINGLE-EVENT ASSUMPTION: returns the first participant row for the user
 * regardless of which exchange it belongs to. With two events, someone in both
 * would get an arbitrary one - and the session, dashboard and design editor all
 * hang off this. Lifting the limit means taking an eventId here first.
 */
export async function participantForUser(db: Db, userId: string) {
  const [row] = await db.select().from(participants).where(eq(participants.userId, userId));
  return row ?? null;
}

/** Roster for the admin view: who has joined, who has chosen, who is missing. */
export async function rosterFor(db: Db, eventId: string) {
  const invited = await db.select().from(invites).where(eq(invites.eventId, eventId));
  const joined = await db
    .select({
      id: participants.id,
      displayName: participants.displayName,
      userId: participants.userId,
      sizeConfirmedAt: participants.sizeConfirmedAt,
      isAdmin: participants.isAdmin,
    })
    .from(participants)
    .where(eq(participants.eventId, eventId));

  const emails = await db.select({ id: users.id, email: users.email }).from(users);
  const emailById = new Map(emails.map((u: { id: string; email: string }) => [u.id, u.email]));

  return invited.map((invite: typeof invites.$inferSelect) => {
    const participant = joined.find(
      (p: { userId: string }) => emailById.get(p.userId) === invite.email,
    );
    return {
      email: invite.email,
      joined: Boolean(participant),
      chosenShirt: Boolean(participant?.sizeConfirmedAt),
      displayName: participant?.displayName ?? null,
      participantId: participant?.id ?? null,
    };
  });
}

/**
 * The single event this deployment runs.
 *
 * SINGLE-EVENT ASSUMPTION, and the most load-bearing one: takes the first row
 * with no filter, and around seventeen call sites across the app treat whatever
 * comes back as "the" exchange. The row order is not even defined, so with two
 * events this would be arbitrary rather than merely wrong.
 *
 * The whole app is otherwise multi-event ready - every table is keyed on
 * eventId, and runDraw, revealGallery, outstandingSelections and
 * collectExportEntries all take one. Supporting multiple groups means routing
 * an event through to here (scoped URLs like /e/[slug]/...), fixing isInvited
 * and participantForUser below, and deciding who may create an exchange, since
 * the AI generation keys belong to whoever deploys this.
 */
export async function currentEvent(db: Db) {
  const [event] = await db.select().from(events);
  return event ?? null;
}
