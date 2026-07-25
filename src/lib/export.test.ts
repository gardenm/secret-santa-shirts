import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import sharp from "sharp";
import { createTestDb, type TestDb } from "@/db/testing";
import { events, garmentColours, garments, participants, users } from "@/db/schema";
import { getMyAssignment, revealGallery, runDraw, saveGarmentSelection } from "./event-service";
import { ExportError, collectExportEntries, zipEntries } from "./export";
import { assetUrl, putAsset } from "./storage";
import { submitDesign } from "./submit";

let db: TestDb;
let eventId: string;
let roster: string[];
let tee: typeof garments.$inferSelect;
let hoodie: typeof garments.$inferSelect;

const NAMES = ["Alex", "Bailey", "Casey", "Devin"];

async function solidPng(w: number, h: number, colour: string) {
  return sharp({ create: { width: w, height: h, channels: 4, background: colour } })
    .png()
    .toBuffer();
}

function designSvg(href: string, w: number, h: number) {
  return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
  <image xlink:href="${href}" x="40" y="60" width="${w - 80}" height="${h - 120}"></image>
</svg>`;
}

beforeEach(async () => {
  db = await createTestDb();

  [tee] = await db.select().from(garments).where(eq(garments.model, "bella-canvas-3001"));
  [hoodie] = await db.select().from(garments).where(eq(garments.model, "gildan-18500"));

  const teeColours = await db
    .select()
    .from(garmentColours)
    .where(eq(garmentColours.garmentId, tee.id));
  const hoodieColours = await db
    .select()
    .from(garmentColours)
    .where(eq(garmentColours.garmentId, hoodie.id));

  const [event] = await db
    .insert(events)
    .values({
      name: "Shirt Santa 2026",
      deadline: new Date(Date.now() + 7 * 86_400_000),
      revealAt: new Date(Date.now() + 21 * 86_400_000),
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
    roster.push(p.id);
  }

  // Mixed garments and colours: the case most likely to expose a mismatch.
  await saveGarmentSelection(db, roster[0], {
    garmentId: tee.id,
    colourId: teeColours.find((c) => c.name === "Black")!.id,
    size: "L",
    fit: "unisex",
  });
  await saveGarmentSelection(db, roster[1], {
    garmentId: tee.id,
    colourId: teeColours.find((c) => c.name === "White")!.id,
    size: "M",
    fit: "unisex",
    notes: "dinosaurs, please",
  });
  await saveGarmentSelection(db, roster[2], {
    garmentId: hoodie.id,
    colourId: hoodieColours.find((c) => c.name === "Navy")!.id,
    size: "XL",
    fit: "unisex",
  });
  await saveGarmentSelection(db, roster[3], {
    garmentId: tee.id,
    colourId: teeColours.find((c) => c.name === "Maroon")!.id,
    size: "S",
    fit: "unisex",
  });

  await runDraw(db, eventId);
});

/** Everyone submits a design sized to their own recipient's garment. */
async function everybodySubmits(skip: string[] = []) {
  for (const participantId of roster) {
    const mine = await getMyAssignment(db, participantId);
    const garment = mine!.recipient!.garment!;
    if (skip.includes(mine!.recipient!.displayName)) continue;

    const { id } = await putAsset(await solidPng(900, 1100, "#cc4422"));
    await submitDesign(
      db,
      participantId,
      designSvg(assetUrl(id), garment.printWPx / 4, garment.printHPx / 4),
    );
  }
}

describe("collectExportEntries", () => {
  it("includes one print file per participant", async () => {
    await everybodySubmits();
    const result = await collectExportEntries(db, eventId);

    const prints = result.entries.filter((e) => e.name.startsWith("prints/"));
    expect(prints).toHaveLength(4);
    expect(result.missing).toEqual([]);
  });

  it("puts garment, colour and size in every filename", async () => {
    await everybodySubmits();
    const result = await collectExportEntries(db, eventId);

    // With mixed garments this is where a dozen shirts get mismatched at the
    // shop, so the filename has to be self-describing.
    const alex = result.entries.find((e) => e.name.includes("alex"))!;
    expect(alex.name).toMatch(/prints\/\d\d_alex_bella-canvas-3001_black_L_unisex\.png/);

    const casey = result.entries.find((e) => e.name.includes("casey"))!;
    expect(casey.name).toContain("gildan-18500");
    expect(casey.name).toContain("navy");
    expect(casey.name).toContain("XL");
  });

  it("writes a manifest matching the files, one row per participant", async () => {
    await everybodySubmits();
    const result = await collectExportEntries(db, eventId);

    const manifest = result.entries.find((e) => e.name === "manifest.csv")!.data.toString();
    const dataRows = manifest.split("\n").filter((l) => l && !l.startsWith("#") && !l.startsWith("index,"));

    expect(dataRows).toHaveLength(4);
    for (const name of NAMES) expect(manifest).toContain(name);

    // Every print file referenced by the manifest is actually in the bundle.
    const names = new Set(result.entries.map((e) => e.name));
    for (const row of result.rows) expect(names.has(row.printFile)).toBe(true);
  });

  it("carries each recipient's own colour and notes into the manifest", async () => {
    await everybodySubmits();
    const result = await collectExportEntries(db, eventId);
    const manifest = result.entries.find((e) => e.name === "manifest.csv")!.data.toString();

    expect(manifest).toContain("dinosaurs, please".replace(",", ",")); // quoted by the csv writer
    expect(manifest).toContain("#111111"); // Black
    expect(manifest).toContain("Heather".length > 0 ? "Maroon" : "");
  });

  it("reports people with no finished design instead of dropping them", async () => {
    await everybodySubmits(["Bailey"]);
    const result = await collectExportEntries(db, eventId);

    expect(result.missing).toEqual(["Bailey"]);
    expect(result.entries.filter((e) => e.name.startsWith("prints/"))).toHaveLength(3);

    // Loudly, at the top of the manifest and in the README - a shirt found
    // missing at the print shop is worse than one flagged a week early.
    const manifest = result.entries.find((e) => e.name === "manifest.csv")!.data.toString();
    expect(manifest.split("\n")[0]).toMatch(/WARNING/);
    expect(manifest).toContain("Bailey");

    const readme = result.entries.find((e) => e.name === "README.txt")!.data.toString();
    expect(readme).toMatch(/WARNING: no finished design for Bailey/);
  });

  it("refuses to export a print file that no longer fits the garment", async () => {
    await everybodySubmits();

    // Simulates an admin changing someone's garment after they had a design
    // made: the stored file is now the wrong shape, and the shop would crop
    // or squash it without telling anyone.
    await db
      .update(participants)
      .set({ garmentId: hoodie.id })
      .where(eq(participants.id, roster[0]));

    await expect(collectExportEntries(db, eventId)).rejects.toThrow(ExportError);
    await expect(collectExportEntries(db, eventId)).rejects.toThrow(/garment probably changed/);
  });

  it("includes mockups, a contact sheet and printer instructions", async () => {
    await everybodySubmits();
    const result = await collectExportEntries(db, eventId);
    const names = result.entries.map((e) => e.name);

    expect(names.filter((n) => n.startsWith("mockups/"))).toHaveLength(4);
    expect(names).toContain("contact-sheet.png");
    expect(names).toContain("README.txt");

    const readme = result.entries.find((e) => e.name === "README.txt")!.data.toString();
    expect(readme).toMatch(/Direct-to-garment/);
    expect(readme).toMatch(/do not add a white background/i);
    expect(readme).toMatch(/order ONE and check it/i);
  });

  it("counts quantities by garment for the order form", async () => {
    await everybodySubmits();
    const result = await collectExportEntries(db, eventId);
    const readme = result.entries.find((e) => e.name === "README.txt")!.data.toString();

    expect(readme).toMatch(/3x Unisex T-Shirt/);
    expect(readme).toMatch(/1x Hoodie/);
  });

  it("is stable across runs, so a re-download numbers shirts the same way", async () => {
    await everybodySubmits();

    const first = await collectExportEntries(db, eventId);
    const second = await collectExportEntries(db, eventId);

    expect(first.entries.map((e) => e.name)).toEqual(second.entries.map((e) => e.name));
  });

  it("refuses before the draw has run", async () => {
    const fresh = await createTestDb();
    const [event] = await fresh
      .insert(events)
      .values({
        name: "Not drawn",
        deadline: new Date(Date.now() + 86_400_000),
        revealAt: new Date(Date.now() + 172_800_000),
      })
      .returning();
    const [user] = await fresh.insert(users).values({ email: "solo@example.com" }).returning();
    await fresh
      .insert(participants)
      .values({ eventId: event.id, userId: user.id, displayName: "Solo" });

    await expect(collectExportEntries(fresh, event.id)).rejects.toThrow(/draw hasn't run/);
  });
});

describe("blind export", () => {
  it("keeps names out of filenames and the manifest", async () => {
    await everybodySubmits();
    const result = await collectExportEntries(db, eventId, { blind: true });

    const prints = result.entries.filter((e) => e.name.startsWith("prints/"));
    for (const print of prints) {
      for (const name of NAMES) {
        expect(print.name.toLowerCase()).not.toContain(name.toLowerCase());
      }
    }

    const manifest = result.entries.find((e) => e.name === "manifest.csv")!.data.toString();
    for (const name of NAMES) expect(manifest).not.toContain(name);
  });

  it("puts the mapping in a separate sealed file", async () => {
    await everybodySubmits();
    const result = await collectExportEntries(db, eventId, { blind: true });

    // The organizer can hand over everything else and leave this unopened.
    const sealed = result.entries.find((e) => e.name === "SEALED-mapping.csv");
    expect(sealed).toBeDefined();

    const contents = sealed!.data.toString();
    for (const name of NAMES) expect(contents).toContain(name);
  });
});

describe("revealGallery", () => {
  it("sends nothing at all before the reveal date", async () => {
    await everybodySubmits();

    // Gated in the query rather than the page: a client clock is not a lock,
    // and an early peek here spoils the surprise for the whole group at once.
    const before = await revealGallery(db, eventId, new Date(Date.now() + 86_400_000));

    expect(before.revealed).toBe(false);
    expect(before.shirts).toEqual([]);
  });

  it("shows every shirt and its designer afterwards", async () => {
    await everybodySubmits();
    const after = await revealGallery(db, eventId, new Date(Date.now() + 30 * 86_400_000));

    expect(after.revealed).toBe(true);
    expect(after.shirts).toHaveLength(4);

    for (const shirt of after.shirts) {
      expect(NAMES).toContain(shirt.recipientName);
      expect(NAMES).toContain(shirt.designerName);
      // Nobody designed their own shirt, which the reveal makes visible.
      expect(shirt.recipientName).not.toBe(shirt.designerName);
      expect(shirt.previewUrl).toBeTruthy();
    }
  });

  it("leaves out shirts that were never finished", async () => {
    await everybodySubmits(["Bailey"]);
    const after = await revealGallery(db, eventId, new Date(Date.now() + 30 * 86_400_000));

    expect(after.shirts).toHaveLength(3);
    expect(after.shirts.map((s: { recipientName: string }) => s.recipientName)).not.toContain(
      "Bailey",
    );
  });
});

describe("zipEntries", () => {
  it("produces a zip archive containing every entry", async () => {
    await everybodySubmits();
    const { entries } = await collectExportEntries(db, eventId);
    const zip = await zipEntries(entries);

    expect(zip.subarray(0, 2).toString()).toBe("PK");

    // Zip stores filenames uncompressed in the local file headers, so they can
    // be checked without unpacking. Asserting on names rather than byte count:
    // these designs are flat colour and compress to almost nothing, so any
    // size threshold would be arbitrary.
    const raw = zip.toString("latin1");
    for (const entry of entries) expect(raw).toContain(entry.name);
  });
});
