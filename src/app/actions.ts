"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { events, exclusions } from "@/db/schema";
import { requireAdmin, requireSession, signIn as authSignIn } from "@/lib/auth";
import { runDraw, saveGarmentSelection } from "@/lib/event-service";
import { addInvites, currentEvent } from "@/lib/invites";

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

  try {
    await authSignIn("resend", { email, redirect: false });
    return { ok: true as const };
  } catch {
    // Deliberately vague: confirming whether an address is on the invite list
    // would leak the guest list to anyone who can guess an email.
    return { ok: true as const };
  }
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

export async function invitepeople(_prev: unknown, formData: FormData): Promise<ActionResult> {
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

export async function addExclusion(_prev: unknown, formData: FormData): Promise<ActionResult> {
  const result = await attempt(async () => {
    await requireAdmin();
    const event = await currentEvent(db);
    if (!event) throw new Error("No exchange has been set up yet.");

    const a = String(formData.get("participantA") ?? "");
    const b = String(formData.get("participantB") ?? "");
    if (!a || !b || a === b) throw new Error("Pick two different people.");

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

    const deadline = new Date(String(formData.get("deadline") ?? ""));
    if (Number.isNaN(deadline.getTime())) throw new Error("That is not a valid date.");

    await db.update(events).set({ deadline }).where(eq(events.id, event.id));
  });

  if (result.ok) revalidatePath("/admin");
  return result;
}
