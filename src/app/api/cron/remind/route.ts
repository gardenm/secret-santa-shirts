import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { assignments, designs, events, participants, users } from "@/db/schema";
import { sendAll, type Message } from "@/lib/email";
import { currentEvent } from "@/lib/invites";
import {
  digestBody,
  nudgeBody,
  nudgeSubject,
  remindersDue,
  stateFor,
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
  const authorised =
    !secret || request.headers.get("authorization") === `Bearer ${secret}`;
  if (!authorised) return NextResponse.json({ error: "Not authorised." }, { status: 401 });

  const event = await currentEvent(db);
  if (!event) return NextResponse.json({ ok: true, note: "No exchange set up." });

  const now = new Date();
  const baseUrl = process.env.AUTH_URL ?? "";

  // Advance state first, so a run on deadline day locks the event and the
  // reminder logic sees the state it will actually be in.
  const nextState = stateFor(event, now);
  if (nextState) {
    await db.update(events).set({ state: nextState }).where(eq(events.id, event.id));
  }

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

  const plan = remindersDue({ deadline: event.deadline, state: nextState ?? event.state }, people, now);

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

  return NextResponse.json({
    ok: true,
    daysLeft: plan.daysLeft,
    stateChangedTo: nextState,
    outstanding: plan.outstanding,
    ...result,
  });
}
