import { beforeAll, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "./testing";
import { assignments, events, garments, participants, users } from "./schema";
import { eq } from "drizzle-orm";

/**
 * The database is the last line of defence for the two properties that matter:
 * nobody draws themselves, and nobody gives or receives twice.
 *
 * Those are a CHECK constraint and two unique indexes. The application also
 * enforces them, which is exactly why they need testing directly - a bug in
 * the application layer is precisely the situation where these have to hold,
 * and until now nothing has ever confirmed they fire.
 */

let db: TestDb;
let eventId: string;
let people: string[];

beforeAll(async () => {
  db = await createTestDb();

  const [event] = await db
    .insert(events)
    .values({
      name: "Test Exchange",
      deadline: new Date("2026-12-01"),
      revealAt: new Date("2026-12-20"),
    })
    .returning();
  eventId = event.id;

  const inserted = [];
  for (const name of ["Alex", "Bailey", "Casey"]) {
    const [user] = await db
      .insert(users)
      .values({ email: `${name.toLowerCase()}@example.com`, name })
      .returning();
    const [participant] = await db
      .insert(participants)
      .values({ eventId, userId: user.id, displayName: name })
      .returning();
    inserted.push(participant.id);
  }
  people = inserted;
});

describe("assignment constraints", () => {
  it("rejects an assignment where the giver is the recipient", async () => {
    await expect(
      db.insert(assignments).values({
        eventId,
        giverId: people[0],
        recipientId: people[0],
      }),
    ).rejects.toThrow(/assignments_no_self/);
  });

  it("rejects a second assignment for the same giver", async () => {
    await db.insert(assignments).values({
      eventId,
      giverId: people[0],
      recipientId: people[1],
    });

    await expect(
      db.insert(assignments).values({
        eventId,
        giverId: people[0],
        recipientId: people[2],
      }),
    ).rejects.toThrow(/assignments_event_giver_uniq/);
  });

  it("rejects two people being assigned the same recipient", async () => {
    await expect(
      db.insert(assignments).values({
        eventId,
        giverId: people[2],
        recipientId: people[1], // already taken by people[0] above
      }),
    ).rejects.toThrow(/assignments_event_recipient_uniq/);
  });
});

describe("catalog seeding", () => {
  it("loads garments with their real print areas", async () => {
    const rows = await db.select().from(garments);
    expect(rows.length).toBe(4);

    const tee = rows.find((g) => g.model === "bella-canvas-3001")!;
    const hoodie = rows.find((g) => g.model === "gildan-18500")!;

    // Print area varies by model - this is what stops anything downstream
    // hardcoding a canvas size.
    expect([tee.printWPx, tee.printHPx]).toEqual([3300, 4200]);
    expect([hoodie.printWPx, hoodie.printHPx]).toEqual([3000, 3600]);
  });

  it("records which sizes each colour is actually stocked in", async () => {
    const [tee] = await db.select().from(garments).where(eq(garments.model, "bella-canvas-3001"));
    const colours = await db.query.garmentColours.findMany({
      where: (c, { eq: equals }) => equals(c.garmentId, tee.id),
    });

    const heather = colours.find((c) => c.name === "Athletic Heather")!;
    const black = colours.find((c) => c.name === "Black")!;

    // A genuinely unorderable combination, not a synthetic one.
    expect(heather.availableSizes).not.toContain("4XL");
    expect(black.availableSizes).toContain("4XL");
  });
});
