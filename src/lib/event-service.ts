import { and, eq, isNull } from "drizzle-orm";
import { assignments, designs, events, exclusions, generations, participants } from "@/db/schema";
import { drawAssignments, validatePairings } from "./draw";
import { validateSelection, type Selection } from "./garments";
import type { Db } from "./db-types";
import type { PaidCall } from "./imagegen/meter";

/**
 * Event operations that must hold together transactionally.
 *
 * Takes `db` rather than importing the singleton so tests can inject PGlite.
 */

export class EventError extends Error {}

// ---------------------------------------------------------------------------
// Profile
// ---------------------------------------------------------------------------

/**
 * Saves a participant's garment choice.
 *
 * Refuses once the garment is locked. The lock is stamped by the draw: after
 * that point, switching from black to white would ruin whatever the person's
 * designer has already made - light art vanishes, and regions left transparent
 * for a black shirt become a white void.
 */
export async function saveGarmentSelection(
  db: Db,
  participantId: string,
  selection: Selection & { notes?: string | null },
) {
  const [participant] = await db
    .select()
    .from(participants)
    .where(eq(participants.id, participantId));
  if (!participant) throw new EventError("You are not part of this exchange.");

  if (participant.garmentLockedAt) {
    throw new EventError(
      "Shirt choices are locked now that the draw has happened - your designer is already " +
        "working from this. Ask the organizer if you need to change it.",
    );
  }

  // Validated server-side: the picker's filtering is a convenience, not a guard.
  await validateSelection(db, selection);

  await db
    .update(participants)
    .set({
      garmentId: selection.garmentId,
      garmentColourId: selection.colourId,
      size: selection.size,
      fit: selection.fit,
      notes: selection.notes ?? participant.notes,
      sizeConfirmedAt: new Date(),
    })
    .where(eq(participants.id, participantId));
}

/**
 * Admin override for a garment change after the lock. Returns the designer who
 * needs telling, so the caller can email them to re-check their work.
 */
export async function adminChangeGarment(
  db: Db,
  participantId: string,
  selection: Selection,
): Promise<{ designerParticipantId: string | null }> {
  await validateSelection(db, selection);

  await db
    .update(participants)
    .set({
      garmentId: selection.garmentId,
      garmentColourId: selection.colourId,
      size: selection.size,
      fit: selection.fit,
    })
    .where(eq(participants.id, participantId));

  const [assignment] = await db
    .select()
    .from(assignments)
    .where(eq(assignments.recipientId, participantId));

  return { designerParticipantId: assignment?.giverId ?? null };
}

// ---------------------------------------------------------------------------
// The draw
// ---------------------------------------------------------------------------

export type DrawOptions = {
  /** Proceed even if some people never chose a garment. */
  allowIncomplete?: boolean;
};

/**
 * Runs the draw for an event, in a single transaction.
 *
 * Everything here either happens together or not at all: a partial draw would
 * leave some people with assignments and others without, which is unrecoverable
 * without manual surgery on the database.
 */
export async function runDraw(db: Db, eventId: string, options: DrawOptions = {}) {
  return db.transaction(async (tx: Db) => {
    const [event] = await tx.select().from(events).where(eq(events.id, eventId));
    if (!event) throw new EventError("Event not found.");

    if (event.state !== "setup") {
      throw new EventError(
        `The draw has already been run for this exchange (it is ${event.state}). ` +
          `Re-drawing would invalidate any designs already in progress.`,
      );
    }

    // Belt and braces against a double-clicked button: the state check above
    // should cover it, but a re-draw is unrecoverable so it is worth two checks.
    const existing = await tx.select().from(assignments).where(eq(assignments.eventId, eventId));
    if (existing.length > 0) {
      throw new EventError("Assignments already exist for this exchange.");
    }

    const roster = await tx.select().from(participants).where(eq(participants.eventId, eventId));
    if (roster.length < 2) {
      throw new EventError("You need at least 2 participants to run the draw.");
    }

    // Designers genuinely need the garment and size, so this blocks by default.
    const incomplete = roster.filter(
      (p) => !p.garmentId || !p.garmentColourId || !p.size || !p.fit,
    );
    if (incomplete.length > 0 && !options.allowIncomplete) {
      throw new EventError(
        `${incomplete.length} ${incomplete.length === 1 ? "person has" : "people have"} not chosen ` +
          `a shirt yet: ${incomplete.map((p) => p.displayName).join(", ")}. ` +
          `Their designer would have nothing to work from. Run with "draw anyway" to override.`,
      );
    }

    const pairs = await tx.select().from(exclusions).where(eq(exclusions.eventId, eventId));

    const ids: string[] = roster.map((p) => p.id);
    const pairings = drawAssignments<string>(ids, {
      exclusions: pairs.map(
        (e) => [e.participantA, e.participantB] as [string, string],
      ),
    });

    // Third check of the same property, before anything is written.
    validatePairings(ids, pairings);

    const inserted = await tx
      .insert(assignments)
      .values(
        pairings.map((p) => ({
          eventId,
          giverId: p.giver,
          recipientId: p.recipient,
        })),
      )
      .returning();

    // Lock garment choices: from here a change would break work in progress.
    const lockedAt = new Date();
    for (const id of ids) {
      await tx.update(participants).set({ garmentLockedAt: lockedAt }).where(eq(participants.id, id));
    }

    await tx
      .insert(designs)
      .values(inserted.map((a) => ({ assignmentId: a.id })));

    await tx.update(events).set({ state: "open" }).where(eq(events.id, eventId));

    return { assignmentCount: inserted.length, lockedAt };
  });
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/**
 * The ONLY path that reads an assignment for a participant.
 *
 * Always filtered on the caller's own participant id - never on an id taken
 * from a URL. This is the one bug class that ruins the surprise for everyone
 * at once, so there is deliberately no general-purpose "get assignment by id"
 * for pages to reach for.
 */
export async function getMyAssignment(db: Db, participantId: string) {
  const [row] = await db
    .select()
    .from(assignments)
    .where(eq(assignments.giverId, participantId));

  if (!row) return null;

  const recipient = await db.query.participants.findFirst({
    where: (p, { eq: equals }) => equals(p.id, row.recipientId),
    with: { garment: true, colour: true },
  });

  const [design] = await db.select().from(designs).where(eq(designs.assignmentId, row.id));

  return { assignment: row, recipient, design };
}

/**
 * Every finished shirt, for the reveal gallery.
 *
 * Returns nothing at all before `revealAt`. Gated here rather than in the page
 * because a client clock is not a lock, and this is the one query where an
 * early peek spoils the surprise for the whole group at once - so the data
 * simply does not leave the server until the date has passed.
 */
export async function revealGallery(db: Db, eventId: string, now: Date = new Date()) {
  const [event] = await db.select().from(events).where(eq(events.id, eventId));
  if (!event) return { revealed: false, revealAt: null, shirts: [] };

  if (now < event.revealAt) {
    return { revealed: false, revealAt: event.revealAt, shirts: [] };
  }

  const rows = await db.select().from(assignments).where(eq(assignments.eventId, eventId));
  const people = await db.query.participants.findMany({
    where: (p, { eq: equals }) => equals(p.eventId, eventId),
    with: { garment: true, colour: true },
  });
  const byId = new Map(people.map((p) => [p.id, p]));
  const allDesigns = await db.select().from(designs);
  const designByAssignment = new Map(allDesigns.map((d) => [d.assignmentId, d]));

  const shirts = rows
    .map((row) => {
      const design = designByAssignment.get(row.id);
      const recipient = byId.get(row.recipientId);
      const designer = byId.get(row.giverId);

      return {
        recipientName: recipient?.displayName ?? "",
        designerName: designer?.displayName ?? "",
        garmentName: recipient?.garment?.displayName ?? "",
        colourName: recipient?.colour?.name ?? "",
        colourHex: recipient?.colour?.hex ?? "#ffffff",
        previewUrl: design?.previewUrl ?? null,
        status: design?.status ?? "draft",
      };
    })
    .filter((shirt) => Boolean(shirt.previewUrl))
    .sort((a, b) =>
      a.recipientName.localeCompare(b.recipientName),
    );

  return { revealed: true, revealAt: event.revealAt, shirts };
}

export type Allowance = {
  /** New images, which is what a person understands as their allowance. */
  generations: number;
  /** Background removals and hosted upscales. */
  assists: number;
};

/**
 * What a participant has left of each paid allowance.
 *
 * Counted from stored rows rather than tracked client-side, so a refreshed page
 * cannot reset anyone's allowance.
 *
 * Both numbers matter. Only generations used to be counted, which left three
 * paid paths unmetered - the two remedy buttons and the upscale behind every
 * upload - so the editor's "remove background" could be clicked all afternoon
 * at roughly a cent a time. Kept as two numbers rather than one because a
 * single generation makes up to two assists internally, and charging someone
 * three of their thirty images for one picture would be a strange thing to
 * explain.
 */
export async function allowanceFor(db: Db, participantId: string): Promise<Allowance> {
  const [participant] = await db
    .select()
    .from(participants)
    .where(eq(participants.id, participantId));
  if (!participant) return { generations: 0, assists: 0 };

  const [event] = await db.select().from(events).where(eq(events.id, participant.eventId));
  const used = await db
    .select()
    .from(generations)
    .where(eq(generations.participantId, participantId));

  const spent = (kind: "generate" | "assist") => used.filter((row) => row.kind === kind).length;

  return {
    generations: Math.max(0, (event?.generationCap ?? 0) - spent("generate")),
    assists: Math.max(0, (event?.assistCap ?? 0) - spent("assist")),
  };
}

/** How many new images a participant may still generate. */
export async function generationsRemaining(db: Db, participantId: string): Promise<number> {
  return (await allowanceFor(db, participantId)).generations;
}

/**
 * Writes the paid calls a request made.
 *
 * Takes whatever the pipeline metered rather than the route's guess, because
 * only the pipeline knows whether an upscale went to a hosted model or was
 * resampled locally for free.
 */
export async function recordPaidCalls(
  db: Db,
  participantId: string,
  calls: PaidCall[],
  context: { prompt?: string; imageUrl?: string } = {},
): Promise<void> {
  if (calls.length === 0) return;

  await db.insert(generations).values(
    calls.map((call) => ({
      participantId,
      kind: call.kind,
      // The person's own words, not the expanded prompt - this is the audit
      // trail, and their subject is what is worth reading back.
      prompt: call.kind === "generate" ? (context.prompt ?? "") : "",
      provider: call.provider,
      model: call.model,
      imageUrl: context.imageUrl ?? null,
      costCents: call.costCents,
    })),
  );
}

/** Who still has not chosen a shirt. Safe to show everyone - reveals no pairings. */
export async function outstandingSelections(db: Db, eventId: string) {
  return db
    .select({ id: participants.id, displayName: participants.displayName })
    .from(participants)
    .where(and(eq(participants.eventId, eventId), isNull(participants.sizeConfirmedAt)));
}
