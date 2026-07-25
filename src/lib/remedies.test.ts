import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import sharp from "sharp";
import { createTestDb, type TestDb } from "@/db/testing";
import { events, generations, participants, users } from "@/db/schema";
import { generationsRemaining } from "./event-service";
import { blackToTransparent, flattenAlpha, upscaleToFit } from "./imagegen";
import { preflight } from "./preflight";

const TEE = { widthPx: 3300, heightPx: 4200 };
const BLACK = { printArea: TEE, isDark: true, colourHex: "#111111", colourName: "Black" };
const WHITE = { printArea: TEE, isDark: false, colourHex: "#FFFFFF", colourName: "White" };

async function shape(w: number, h: number, colour: string, inset = 0.25) {
  const iw = Math.round(w * (1 - inset * 2));
  const ih = Math.round(h * (1 - inset * 2));
  const inner = await sharp({ create: { width: iw, height: ih, channels: 4, background: colour } })
    .png()
    .toBuffer();

  return sharp({ create: { width: w, height: h, channels: 4, background: "#00000000" } })
    .composite([{ input: inner, left: Math.round(w * inset), top: Math.round(h * inset) }])
    .png()
    .toBuffer();
}

/** Soft-edged art - the dark-garment failure case. Blur must be a second pass. */
async function feathered(w: number, h: number, colour = "#ff8844") {
  const sw = Math.round(w / 10);
  const sh = Math.round(h / 10);
  const composited = await shape(sw, sh, colour);
  const blurred = await sharp(composited).blur(Math.max(4, sw * 0.06)).png().toBuffer();
  return sharp(blurred).resize(w, h).png().toBuffer();
}

describe("remedies produce files that pass", () => {
  it("upscale rescues art that was too small to print", async () => {
    const tooSmall = await shape(800, 1018, "#2244cc");

    const before = await preflight(tooSmall, WHITE);
    expect(before.ok).toBe(false);
    expect(before.findings.find((f) => f.code === "resolution-too-low")?.remedy).toBe("upscale");

    // The offered fix has to actually work, or the button is worse than no
    // button: it promises a way out and leaves the person where they started.
    const fixed = await upscaleToFit(tooSmall, TEE);
    const after = await preflight(fixed, WHITE);

    expect(after.findings.map((f) => f.code)).not.toContain("resolution-too-low");
    expect(after.ok).toBe(true);
  });

  it("flatten-alpha clears the soft edges that halo on a dark shirt", async () => {
    const soft = await feathered(3300, 4200);

    const before = await preflight(soft, BLACK);
    const finding = before.findings.find((f) => f.code === "soft-edges-on-dark");
    expect(finding?.remedy).toBe("flatten-alpha");

    const fixed = await flattenAlpha(soft);
    const after = await preflight(fixed, BLACK);

    expect(after.findings.map((f) => f.code)).not.toContain("soft-edges-on-dark");
    expect(after.meta.partialAlphaRatio).toBeLessThan(before.meta.partialAlphaRatio);
  });

  it("make-transparent clears the black that would print grey", async () => {
    const nearBlack = await shape(3300, 4200, "#050505");

    const before = await preflight(nearBlack, BLACK);
    expect(before.findings.find((f) => f.code === "black-ink-on-dark")?.remedy).toBe(
      "make-transparent",
    );

    const fixed = await blackToTransparent(nearBlack);
    const after = await preflight(fixed, BLACK);

    expect(after.findings.map((f) => f.code)).not.toContain("black-ink-on-dark");
  });
});

describe("generation cap", () => {
  let db: TestDb;
  let participantId: string;

  beforeEach(async () => {
    db = await createTestDb();
    const [event] = await db
      .insert(events)
      .values({
        name: "Capped",
        deadline: new Date(Date.now() + 86_400_000),
        revealAt: new Date(Date.now() + 172_800_000),
        generationCap: 3,
      })
      .returning();

    const [user] = await db.insert(users).values({ email: "alex@example.com" }).returning();
    const [p] = await db
      .insert(participants)
      .values({ eventId: event.id, userId: user.id, displayName: "Alex" })
      .returning();
    participantId = p.id;
  });

  it("starts at the event's cap", async () => {
    expect(await generationsRemaining(db, participantId)).toBe(3);
  });

  it("counts down as images are generated", async () => {
    await db.insert(generations).values({
      participantId,
      prompt: "a badger",
      provider: "openai",
      model: "test",
      costCents: 7,
    });

    expect(await generationsRemaining(db, participantId)).toBe(2);
  });

  it("reaches zero and does not go negative", async () => {
    for (let i = 0; i < 5; i++) {
      await db.insert(generations).values({
        participantId,
        prompt: `attempt ${i}`,
        provider: "openai",
        model: "test",
        costCents: 7,
      });
    }

    // Counted from stored rows, so refreshing the page cannot reset it - this
    // is the only thing bounding the image-generation bill.
    expect(await generationsRemaining(db, participantId)).toBe(0);
  });

  it("is per participant, not shared", async () => {
    const [other] = await db.insert(users).values({ email: "bailey@example.com" }).returning();
    const [me] = await db.select().from(participants).where(eq(participants.id, participantId));
    const [second] = await db
      .insert(participants)
      .values({ eventId: me.eventId, userId: other.id, displayName: "Bailey" })
      .returning();

    await db.insert(generations).values({
      participantId,
      prompt: "mine",
      provider: "openai",
      model: "test",
      costCents: 7,
    });

    expect(await generationsRemaining(db, participantId)).toBe(2);
    expect(await generationsRemaining(db, second.id)).toBe(3);
  });
});
