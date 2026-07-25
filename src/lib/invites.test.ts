import { beforeEach, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "@/db/testing";
import { events, participants, users } from "@/db/schema";
import { eq } from "drizzle-orm";
import {
  acceptInvite,
  addInvites,
  InviteError,
  isInvited,
  normaliseEmail,
  rosterFor,
} from "./invites";

let db: TestDb;
let eventId: string;

beforeEach(async () => {
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
});

async function makeUser(email: string, name?: string) {
  const [user] = await db.insert(users).values({ email, name: name ?? null }).returning();
  return user;
}

describe("invite list as access control", () => {
  it("refuses someone who was never invited", async () => {
    await addInvites(db, eventId, ["alex@example.com"]);

    // The whole access-control story: no invite, no entry. Someone who finds
    // the URL cannot join the exchange.
    expect(await isInvited(db, "stranger@example.com")).toBe(false);
  });

  it("admits someone on the list", async () => {
    await addInvites(db, eventId, ["alex@example.com"]);
    expect(await isInvited(db, "alex@example.com")).toBe(true);
  });

  it("ignores case and surrounding whitespace", async () => {
    await addInvites(db, eventId, ["  Alex@Example.COM "]);

    expect(await isInvited(db, "alex@example.com")).toBe(true);
    expect(await isInvited(db, "ALEX@EXAMPLE.COM")).toBe(true);
    expect(normaliseEmail(" Foo@Bar.com ")).toBe("foo@bar.com");
  });

  it("does not duplicate an email invited twice", async () => {
    await addInvites(db, eventId, ["alex@example.com"]);
    const second = await addInvites(db, eventId, ["alex@example.com", "ALEX@example.com"]);

    expect(second.added).toBe(0);
  });

  it("skips entries that are not email addresses", async () => {
    const result = await addInvites(db, eventId, ["not-an-email", "bailey@example.com"]);
    expect(result.added).toBe(1);
  });
});

describe("acceptInvite", () => {
  it("creates a participant on first sign-in", async () => {
    await addInvites(db, eventId, ["alex@example.com"]);
    const user = await makeUser("alex@example.com", "Alex");

    const participant = await acceptInvite(db, { id: user.id, email: user.email, name: user.name });

    expect(participant.displayName).toBe("Alex");
    expect(participant.eventId).toBe(eventId);
  });

  it("is idempotent, because magic links get clicked twice", async () => {
    await addInvites(db, eventId, ["alex@example.com"]);
    const user = await makeUser("alex@example.com", "Alex");

    const first = await acceptInvite(db, { id: user.id, email: user.email, name: user.name });
    const second = await acceptInvite(db, { id: user.id, email: user.email, name: user.name });

    expect(second.id).toBe(first.id);
    const all = await db.select().from(participants).where(eq(participants.eventId, eventId));
    expect(all).toHaveLength(1);
  });

  it("refuses an email that is not on the list", async () => {
    const user = await makeUser("stranger@example.com");

    await expect(
      acceptInvite(db, { id: user.id, email: user.email, name: null }),
    ).rejects.toThrow(InviteError);
  });

  it("makes the first person to join the admin, and nobody after", async () => {
    await addInvites(db, eventId, ["alex@example.com", "bailey@example.com"]);

    const alex = await makeUser("alex@example.com", "Alex");
    const bailey = await makeUser("bailey@example.com", "Bailey");

    const first = await acceptInvite(db, { id: alex.id, email: alex.email, name: "Alex" });
    const second = await acceptInvite(db, { id: bailey.id, email: bailey.email, name: "Bailey" });

    expect(first.isAdmin).toBe(true);
    expect(second.isAdmin).toBe(false);
  });

  it("falls back to the email local part when there is no name", async () => {
    await addInvites(db, eventId, ["casey@example.com"]);
    const user = await makeUser("casey@example.com");

    const participant = await acceptInvite(db, { id: user.id, email: user.email, name: null });
    expect(participant.displayName).toBe("casey");
  });
});

describe("rosterFor", () => {
  it("shows who has joined and who has chosen a shirt", async () => {
    await addInvites(db, eventId, ["alex@example.com", "bailey@example.com"]);
    const alex = await makeUser("alex@example.com", "Alex");
    await acceptInvite(db, { id: alex.id, email: alex.email, name: "Alex" });

    const roster = await rosterFor(db, eventId);

    const alexRow = roster.find((r: { email: string }) => r.email === "alex@example.com")!;
    const baileyRow = roster.find((r: { email: string }) => r.email === "bailey@example.com")!;

    expect(alexRow.joined).toBe(true);
    expect(alexRow.chosenShirt).toBe(false);
    expect(baileyRow.joined).toBe(false);
  });
});
