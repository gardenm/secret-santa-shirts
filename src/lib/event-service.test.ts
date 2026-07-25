import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb, type TestDb } from "@/db/testing";
import {
  assignments,
  designs,
  events,
  exclusions,
  garmentColours,
  garments,
  participants,
  users,
} from "@/db/schema";
import {
  EventError,
  getMyAssignment,
  outstandingSelections,
  runDraw,
  saveGarmentSelection,
} from "./event-service";
import { SelectionError, validateSelection } from "./garments";

let db: TestDb;
let eventId: string;
let roster: Array<{ id: string; name: string }>;
let tee: typeof garments.$inferSelect;
let hoodie: typeof garments.$inferSelect;
let colours: Array<typeof garmentColours.$inferSelect>;

const NAMES = ["Alex", "Bailey", "Casey", "Devin"];

beforeEach(async () => {
  db = await createTestDb();

  [tee] = await db.select().from(garments).where(eq(garments.model, "bella-canvas-3001"));
  [hoodie] = await db.select().from(garments).where(eq(garments.model, "gildan-18500"));
  colours = await db.select().from(garmentColours).where(eq(garmentColours.garmentId, tee.id));

  const [event] = await db
    .insert(events)
    .values({
      name: "Test Exchange",
      deadline: new Date("2026-12-01"),
      revealAt: new Date("2026-12-20"),
    })
    .returning();
  eventId = event.id;

  roster = [];
  for (const name of NAMES) {
    const [user] = await db
      .insert(users)
      .values({ email: `${name.toLowerCase()}@example.com`, name })
      .returning();
    const [p] = await db
      .insert(participants)
      .values({ eventId, userId: user.id, displayName: name })
      .returning();
    roster.push({ id: p.id, name });
  }
});

/** Give everyone a valid shirt so the draw is not blocked. */
async function everyonePicksAShirt() {
  const black = colours.find((c) => c.name === "Black")!;
  for (const person of roster) {
    await saveGarmentSelection(db, person.id, {
      garmentId: tee.id,
      colourId: black.id,
      size: "L",
      fit: "unisex",
    });
  }
}

describe("garment selection", () => {
  it("rejects a colour that belongs to a different garment", async () => {
    const teeColour = colours.find((c) => c.name === "Dusty Blue")!;

    await expect(
      validateSelection(db, {
        garmentId: hoodie.id, // hoodie does not come in Dusty Blue
        colourId: teeColour.id,
        size: "L",
        fit: "unisex",
      }),
    ).rejects.toThrow(SelectionError);
  });

  it("rejects a size the colour is not stocked in", async () => {
    // A real unorderable combination from the catalog, not a synthetic one:
    // heathers are not made in 4XL, though the tee itself is.
    const heather = colours.find((c) => c.name === "Athletic Heather")!;
    expect(tee.sizes).toContain("4XL");

    await expect(
      validateSelection(db, {
        garmentId: tee.id,
        colourId: heather.id,
        size: "4XL",
        fit: "unisex",
      }),
    ).rejects.toThrow(/not stocked in 4XL/);
  });

  it("rejects a fit the garment does not come in", async () => {
    const black = colours.find((c) => c.name === "Black")!;

    await expect(
      validateSelection(db, {
        garmentId: tee.id,
        colourId: black.id,
        size: "L",
        fit: "fitted", // the 3001 is unisex only
      }),
    ).rejects.toThrow(SelectionError);
  });

  it("accepts a valid combination and records it", async () => {
    const navy = colours.find((c) => c.name === "Navy")!;
    await saveGarmentSelection(db, roster[0].id, {
      garmentId: tee.id,
      colourId: navy.id,
      size: "M",
      fit: "unisex",
      notes: "dinosaurs please",
    });

    const [p] = await db.select().from(participants).where(eq(participants.id, roster[0].id));
    expect(p.size).toBe("M");
    expect(p.notes).toBe("dinosaurs please");
    expect(p.sizeConfirmedAt).not.toBeNull();
  });
});

describe("runDraw", () => {
  it("blocks the draw when someone has not chosen a shirt", async () => {
    // Their designer would have nothing to work from.
    await expect(runDraw(db, eventId)).rejects.toThrow(/not chosen a shirt/);
  });

  it("names who is missing, so the organizer knows who to chase", async () => {
    await saveGarmentSelection(db, roster[0].id, {
      garmentId: tee.id,
      colourId: colours.find((c) => c.name === "Black")!.id,
      size: "L",
      fit: "unisex",
    });

    await expect(runDraw(db, eventId)).rejects.toThrow(/Bailey/);
  });

  it("can be overridden deliberately", async () => {
    const result = await runDraw(db, eventId, { allowIncomplete: true });
    expect(result.assignmentCount).toBe(4);
  });

  it("produces a valid derangement", async () => {
    await everyonePicksAShirt();
    await runDraw(db, eventId);

    const rows = await db.select().from(assignments).where(eq(assignments.eventId, eventId));
    expect(rows.length).toBe(4);

    for (const row of rows) expect(row.giverId).not.toBe(row.recipientId);
    expect(new Set(rows.map((r) => r.giverId)).size).toBe(4);
    expect(new Set(rows.map((r) => r.recipientId)).size).toBe(4);
  });

  it("locks garment choices and creates a design per assignment", async () => {
    await everyonePicksAShirt();
    await runDraw(db, eventId);

    const people = await db.select().from(participants).where(eq(participants.eventId, eventId));
    for (const p of people) expect(p.garmentLockedAt).not.toBeNull();

    const designRows = await db.select().from(designs);
    expect(designRows.length).toBe(4);
    expect(designRows.every((d) => d.status === "draft")).toBe(true);

    const [event] = await db.select().from(events).where(eq(events.id, eventId));
    expect(event.state).toBe("open");
  });

  it("refuses to run twice, leaving the first draw untouched", async () => {
    await everyonePicksAShirt();
    await runDraw(db, eventId);

    const before = await db.select().from(assignments).where(eq(assignments.eventId, eventId));

    await expect(runDraw(db, eventId)).rejects.toThrow(EventError);

    const after = await db.select().from(assignments).where(eq(assignments.eventId, eventId));
    // A re-draw would invalidate work already in progress, so the original
    // pairings must survive the attempt completely unchanged.
    expect(after.map((a) => `${a.giverId}->${a.recipientId}`).sort()).toEqual(
      before.map((a) => `${a.giverId}->${a.recipientId}`).sort(),
    );
  });

  it("honours exclusions", async () => {
    await everyonePicksAShirt();
    await db.insert(exclusions).values({
      eventId,
      participantA: roster[0].id,
      participantB: roster[1].id,
    });

    await runDraw(db, eventId);

    const rows = await db.select().from(assignments).where(eq(assignments.eventId, eventId));
    const pair = rows.find(
      (r) =>
        (r.giverId === roster[0].id && r.recipientId === roster[1].id) ||
        (r.giverId === roster[1].id && r.recipientId === roster[0].id),
    );
    expect(pair).toBeUndefined();
  });

  it("rolls back completely if the draw cannot be satisfied", async () => {
    await everyonePicksAShirt();
    // Exclude so heavily that no valid single-cycle draw exists.
    for (const a of roster) {
      for (const b of roster) {
        if (a.id !== b.id) {
          await db.insert(exclusions).values({
            eventId,
            participantA: a.id,
            participantB: b.id,
          });
        }
      }
    }

    await expect(runDraw(db, eventId)).rejects.toThrow();

    // Nothing half-written: no assignments, no designs, event still in setup.
    expect(await db.select().from(assignments)).toHaveLength(0);
    expect(await db.select().from(designs)).toHaveLength(0);
    const [event] = await db.select().from(events).where(eq(events.id, eventId));
    expect(event.state).toBe("setup");

    const people = await db.select().from(participants).where(eq(participants.eventId, eventId));
    for (const p of people) expect(p.garmentLockedAt).toBeNull();
  });
});

describe("garment lock", () => {
  it("refuses a change once the draw has locked choices", async () => {
    await everyonePicksAShirt();
    await runDraw(db, eventId);

    await expect(
      saveGarmentSelection(db, roster[0].id, {
        garmentId: tee.id,
        colourId: colours.find((c) => c.name === "White")!.id,
        size: "L",
        fit: "unisex",
      }),
    ).rejects.toThrow(/locked/);
  });
});

describe("secrecy", () => {
  it("returns only the caller's own assignment", async () => {
    await everyonePicksAShirt();
    await runDraw(db, eventId);

    const mine = await getMyAssignment(db, roster[0].id);
    expect(mine).not.toBeNull();
    expect(mine!.assignment.giverId).toBe(roster[0].id);
    expect(mine!.assignment.recipientId).not.toBe(roster[0].id);
  });

  it("never leaks another participant's assignment", async () => {
    await everyonePicksAShirt();
    await runDraw(db, eventId);

    // Each person sees exactly one pairing, and it is always their own. This
    // is the bug that would ruin the surprise for everyone simultaneously.
    for (const person of roster) {
      const result = await getMyAssignment(db, person.id);
      expect(result!.assignment.giverId).toBe(person.id);
    }
  });

  it("gives the designer the recipient's garment, colour and notes", async () => {
    const navy = colours.find((c) => c.name === "Navy")!;
    for (const person of roster) {
      await saveGarmentSelection(db, person.id, {
        garmentId: tee.id,
        colourId: navy.id,
        size: "XL",
        fit: "unisex",
        notes: "no politics",
      });
    }
    await runDraw(db, eventId);

    const mine = await getMyAssignment(db, roster[0].id);
    // The designer needs all of this: colour drives the canvas backdrop and
    // the dark-garment warnings, size goes on the order.
    expect(mine!.recipient!.colour!.name).toBe("Navy");
    expect(mine!.recipient!.colour!.isDark).toBe(true);
    expect(mine!.recipient!.garment!.printWPx).toBe(3300);
    expect(mine!.recipient!.size).toBe("XL");
    expect(mine!.recipient!.notes).toBe("no politics");
  });

  it("returns null before the draw", async () => {
    expect(await getMyAssignment(db, roster[0].id)).toBeNull();
  });
});

describe("outstandingSelections", () => {
  it("lists who still needs to choose, without revealing pairings", async () => {
    await saveGarmentSelection(db, roster[0].id, {
      garmentId: tee.id,
      colourId: colours.find((c) => c.name === "Black")!.id,
      size: "L",
      fit: "unisex",
    });

    const outstanding = await outstandingSelections(db, eventId);
    expect(outstanding.map((p: { displayName: string }) => p.displayName).sort()).toEqual(["Bailey", "Casey", "Devin"]);
  });
});
