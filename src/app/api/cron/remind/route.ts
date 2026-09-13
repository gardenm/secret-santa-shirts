import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { assignments, designs, events, participants, users } from "@/db/schema";
import { eventTimeZone } from "@/lib/dates";
import { sendAll, type Message } from "@/lib/email";
import { currentEvent } from "@/lib/invites";
import {
  digestBody,
  nudgeBody,
  nudgeSubject,
  planReminderRun,
  type ReminderPerson,
} from "@/lib/reminders";

export const maxDuration = 60;

/**
 * Daily reminder run.
 *
 * Two jobs: nudge anyone whose design is still unfinished on a scheduled day,
 * and advance the event's state as the deadline and reveal date pass. Which
 * people get nudged is decided by `remindersDue`, which is pure and tested;
 * this route is the plumbing around it.
 */
export async function GET(request: Request) {
  // Vercel Cron sends this header; without the secret anyone could trigger a
  // send and spam the group.
  const secret = process.env.CRON_SECRET;

  // Fail closed in production. Treating "no secret configured" as "everyone is
  // authorised" meant a deployment that simply forgot to set CRON_SECRET left
  // the endpoint open to the internet, which is the exact case where nobody
  // would notice.
  if (!secret) {
    if (process.env.NODE_ENV === "production") {
      console.error("[cron] CRON_SECRET is not set; refusing to run.");
      return NextResponse.json({ error: "Not configured." }, { status: 503 });
    }
  } else if (request.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Not authorised." }, { status: 401 });
  }

  const event = await currentEvent(db);
  if (!event) return NextResponse.json({ ok: true, note: "No exchange set up." });

  const now = new Date();
  const timeZone = eventTimeZone();
  // Same resolution order as lib/auth.ts, so emailed links and magic links
  // always point at the same host.
  const baseUrl = process.env.BETTER_AUTH_URL ?? process.env.AUTH_URL ?? "";

  const roster = await db.select().from(participants).where(eq(participants.eventId, event.id));
  const allAssignments = await db
    .select()
    .from(assignments)
    .where(eq(assignments.eventId, event.id));
  const allDesigns = await db.select().from(designs);
  const allUsers = await db.select().from(users);

  const emailById = new Map(allUsers.map((u) => [u.id, u.email]));
  const designByAssignment = new Map(allDesigns.map((d) => [d.assignmentId, d]));

  const people: ReminderPerson[] = roster.map((p) => {
    // "Submitted" means the design they owe someone else, not the shirt they
    // are receiving.
    const mine = allAssignments.find((a) => a.giverId === p.id);
    const design = mine ? designByAssignment.get(mine.id) : undefined;

    return {
      participantId: p.id,
      displayName: p.displayName,
      email: emailById.get(p.userId) ?? "",
      hasSubmitted: design?.status === "submitted",
      isAdmin: p.isAdmin,
    };
  });

  const { today, nextState, plan, alreadySentToday } = planReminderRun(event, people, now, timeZone);

  // State is advanced whether or not anything is sent - it is what closes
  // submissions and opens the reveal.
  if (nextState) {
    await db.update(events).set({ state: nextState }).where(eq(events.id, event.id));
  }

  // Once per local day, whatever fires the run. Vercel retries a failed cron,
  // and the endpoint can be triggered by hand, so without this a reminder day
  // nudges everyone twice - and being nagged twice reads as a broken app.
  if (alreadySentToday) {
    return NextResponse.json({
      ok: true,
      daysLeft: plan.daysLeft,
      stateChangedTo: nextState,
      skipped: "Reminders already went out today.",
    });
  }

  const messages: Message[] = [
    ...plan.nudge
      .filter((p) => p.email)
      .map((p) => ({
        to: p.email,
        subject: nudgeSubject(plan.daysLeft, event.name),
        text: nudgeBody(p, plan.daysLeft, `${baseUrl}/design`),
      })),
    ...plan.digestFor
      .filter((p) => p.email)
      .map((p) => ({
        to: p.email,
        subject: `${plan.outstanding.length} still to finish - ${event.name}`,
        text: digestBody(plan.outstanding, plan.daysLeft, `${baseUrl}/admin`),
      })),
  ];

  const result = await sendAll(messages);

  // Recorded after the send, so a run that failed to send anything is free to
  // try again rather than marking the day done.
  if (plan.nudge.length > 0 && result.sent > 0) {
    await db.update(events).set({ lastReminderDay: today }).where(eq(events.id, event.id));
  }

  return NextResponse.json({
    ok: true,
    daysLeft: plan.daysLeft,
    stateChangedTo: nextState,
    outstanding: plan.outstanding,
    ...result,
  });
}
