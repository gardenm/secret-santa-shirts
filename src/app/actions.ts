"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { events, exclusions, participants } from "@/db/schema";
import { headers } from "next/headers";
import { auth, requireAdmin, requireSession } from "@/lib/auth";
import { endOfDayIn } from "@/lib/dates";
import { runDraw, saveGarmentSelection } from "@/lib/event-service";
import { addInvites, currentEvent, removeInvite } from "@/lib/invites";
import { claimSignInSend } from "@/lib/signin-policy";

export type ActionResult = { ok: true } | { ok: false; error: string };

/** Server actions surface failures as text rather than throwing at the user. */
async function attempt(fn: () => Promise<void>): Promise<ActionResult> {
  try {
    await fn();
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "Something went wrong." };
  }
}

export async function sendMagicLink(_prev: unknown, formData: FormData) {
  const email = String(formData.get("email") ?? "");
  if (!email.includes("@")) return { ok: false as const, error: "Enter an email address." };

  // One per address per minute. Checked here rather than inside Better Auth
  // because its own limiter only runs in the HTTP handler, and this calls the
  // API directly. The response is the same either way - saying "slow down"
  // would confirm the address is real.
  if (!(await claimSignInSend(db, email))) return { ok: true as const };

  try {
    await auth.api.signInMagicLink({
      body: { email, callbackURL: "/dashboard" },
      headers: await headers(),
    });
  } catch (error) {
    // Deliberately vague to the user: confirming whether an address is on the
    // invite list would leak the guest list to anyone who can guess an email.
    // Logged in full, because a genuinely broken email setup looks identical
    // to an uninvited address from out here.
    console.error(`[signin] magic link not sent to ${email}:`, error);
  }

  return { ok: true as const };
}

export async function signOut(): Promise<void> {
  await auth.api.signOut({ headers: await headers() });
  redirect("/signin");
}

export async function saveShirt(_prev: unknown, formData: FormData): Promise<ActionResult> {
  const result = await attempt(async () => {
    const session = await requireSession();
    await saveGarmentSelection(db, session.participantId, {
      garmentId: String(formData.get("garmentId") ?? ""),
      colourId: String(formData.get("colourId") ?? ""),
      size: String(formData.get("size") ?? ""),
      fit: String(formData.get("fit") ?? ""),
      notes: (formData.get("notes") as string) || null,
    });
  });

  if (result.ok) {
    revalidatePath("/dashboard");
    redirect("/dashboard");
  }
  return result;
}

export async function invitePeople(_prev: unknown, formData: FormData): Promise<ActionResult> {
  const result = await attempt(async () => {
    await requireAdmin();
    const event = await currentEvent(db);
    if (!event) throw new Error("No exchange has been set up yet.");

    const emails = String(formData.get("emails") ?? "")
      .split(/[\s,;]+/)
      .filter(Boolean);

    await addInvites(db, event.id, emails);
  });

  if (result.ok) revalidatePath("/admin");
  return result;
}

export async function drawNames(_prev: unknown, formData: FormData): Promise<ActionResult> {
  const result = await attempt(async () => {
    await requireAdmin();
    const event = await currentEvent(db);
    if (!event) throw new Error("No exchange has been set up yet.");

    await runDraw(db, event.id, {
      allowIncomplete: formData.get("allowIncomplete") === "on",
    });
  });

  if (result.ok) {
    revalidatePath("/admin");
    revalidatePath("/dashboard");
  }
  return result;
}

export async function removePerson(_prev: unknown, formData: FormData): Promise<ActionResult> {
  const result = await attempt(async () => {
    await requireAdmin();
    const event = await currentEvent(db);
    if (!event) throw new Error("No exchange has been set up yet.");

    const email = String(formData.get("email") ?? "");
    if (!(await removeInvite(db, event.id, email))) {
      throw new Error("That address is not on the invite list.");
    }
  });

  if (result.ok) revalidatePath("/admin");
  return result;
}

export async function addExclusion(_prev: unknown, formData: FormData): Promise<ActionResult> {
  const result = await attempt(async () => {
    await requireAdmin();
    const event = await currentEvent(db);
    if (!event) throw new Error("No exchange has been set up yet.");

    const a = String(formData.get("participantA") ?? "");
    const b = String(formData.get("participantB") ?? "");
    if (!a || !b || a === b) throw new Error("Pick two different people.");

    // Both must belong to this exchange. Redundant while there is only one,
    // but the ids come from a form and this is the kind of check that is much
    // harder to add convincingly after the fact.
    const roster = await db
      .select({ id: participants.id })
      .from(participants)
      .where(eq(participants.eventId, event.id));
    const ids = new Set(roster.map((p) => p.id));
    if (!ids.has(a) || !ids.has(b)) throw new Error("Those people are not in this exchange.");

    await db.insert(exclusions).values({ eventId: event.id, participantA: a, participantB: b });
  });

  if (result.ok) revalidatePath("/admin");
  return result;
}

export async function extendDeadline(_prev: unknown, formData: FormData): Promise<ActionResult> {
  const result = await attempt(async () => {
    await requireAdmin();
    const event = await currentEvent(db);
    if (!event) throw new Error("No exchange has been set up yet.");

    // The date input gives a bare YYYY-MM-DD. Stored as the end of that day in
    // the group's timezone, so "extend to Dec 3" means people have all of it.
    let deadline: Date;
    try {
      deadline = endOfDayIn(String(formData.get("deadline") ?? ""));
    } catch {
      throw new Error("That is not a valid date.");
    }

    await db.update(events).set({ deadline }).where(eq(events.id, event.id));
  });

  if (result.ok) revalidatePath("/admin");
  return result;
}
