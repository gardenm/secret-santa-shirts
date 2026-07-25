import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import sharp from "sharp";
import { createTestDb, type TestDb } from "@/db/testing";
import {
  designs,
  events,
  garmentColours,
  garments,
  participants,
  users,
} from "@/db/schema";
import { runDraw, saveGarmentSelection, getMyAssignment } from "./event-service";
import { SubmitError, autosaveDesign, submitDesign } from "./submit";
import { assetUrl, putAsset } from "./storage";
import { SvgAssetError } from "./svg-assets";

let db: TestDb;
let eventId: string;
let roster: string[];
let tee: typeof garments.$inferSelect;
let hoodie: typeof garments.$inferSelect;
let teeColours: Array<typeof garmentColours.$inferSelect>;
let hoodieColours: Array<typeof garmentColours.$inferSelect>;

async function solidPng(w: number, h: number, colour: string) {
  return sharp({ create: { width: w, height: h, channels: 4, background: colour } })
    .png()
    .toBuffer();
}

function designSvg(href: string, w = 825, h = 1050) {
  return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
  <image xlink:href="${href}" x="60" y="80" width="${w - 120}" height="${h - 160}"></image>
</svg>`;
}

beforeEach(async () => {
  db = await createTestDb();

  [tee] = await db.select().from(garments).where(eq(garments.model, "bella-canvas-3001"));
  [hoodie] = await db.select().from(garments).where(eq(garments.model, "gildan-18500"));
  teeColours = await db.select().from(garmentColours).where(eq(garmentColours.garmentId, tee.id));
  hoodieColours = await db
    .select()
    .from(garmentColours)
    .where(eq(garmentColours.garmentId, hoodie.id));

  const [event] = await db
    .insert(events)
    .values({
      name: "Test Exchange",
      deadline: new Date(Date.now() + 7 * 86_400_000),
      revealAt: new Date(Date.now() + 21 * 86_400_000),
    })
    .returning();
  eventId = event.id;

  roster = [];
  for (const name of ["Alex", "Bailey", "Casey", "Devin"]) {
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
});

/**
 * Everyone picks a shirt, then the draw runs. Deliberately mixes garments:
 * a hoodie has a different print area from a tee, which is the case most
 * likely to expose a hardcoded size.
 */
async function drawWithMixedGarments() {
  const black = teeColours.find((c) => c.name === "Black")!;
  const white = teeColours.find((c) => c.name === "White")!;
  const hoodieNavy = hoodieColours.find((c) => c.name === "Navy")!;

  await saveGarmentSelection(db, roster[0], {
    garmentId: tee.id, colourId: black.id, size: "L", fit: "unisex",
  });
  await saveGarmentSelection(db, roster[1], {
    garmentId: tee.id, colourId: white.id, size: "M", fit: "unisex",
  });
  await saveGarmentSelection(db, roster[2], {
    garmentId: hoodie.id, colourId: hoodieNavy.id, size: "XL", fit: "unisex",
  });
  await saveGarmentSelection(db, roster[3], {
    garmentId: tee.id, colourId: black.id, size: "S", fit: "unisex",
  });

  await runDraw(db, eventId);
}

/**
 * The designer assigned to someone wearing `model`, with a canvas sized to
 * that garment. The draw is random, so tests must look up who got whom rather
 * than assume - and the canvas must match the recipient's garment, exactly as
 * the editor does.
 */
async function designerFor(model: string) {
  for (const id of roster) {
    const mine = await getMyAssignment(db, id);
    const garment = mine?.recipient?.garment;
    if (garment?.model === model) {
      return {
        participantId: id,
        // Design space is a quarter of print scale, matching the editor.
        canvas: { w: garment.printWPx / 4, h: garment.printHPx / 4 },
        isDark: mine!.recipient!.colour!.isDark,
      };
    }
  }
  throw new Error(`Nobody was assigned a ${model}`);
}

describe("submitDesign", () => {
  it("renders at the recipient's print size, not a fixed one", async () => {
    await drawWithMixedGarments();

    const designer = await designerFor("gildan-18500");
    const { id: assetId } = await putAsset(await solidPng(600, 720, "#ff5533"));

    const result = await submitDesign(
      db,
      designer.participantId,
      designSvg(assetUrl(assetId), designer.canvas.w, designer.canvas.h),
    );

    const meta = await sharp(await fetchAsset(result.printFileUrl)).metadata();
    expect(meta.width).toBe(3000);
    expect(meta.height).toBe(3600);
  });

  it("produces a print file with the artwork actually in it", async () => {
    await drawWithMixedGarments();
    const designer = await designerFor("bella-canvas-3001");
    const { id: assetId } = await putAsset(await solidPng(600, 720, "#2244cc"));

    const result = await submitDesign(
      db,
      designer.participantId,
      designSvg(assetUrl(assetId), designer.canvas.w, designer.canvas.h),
    );
    const png = await fetchAsset(result.printFileUrl);

    const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    let opaque = 0;
    for (let i = 3; i < data.length; i += 4) if (data[i] > 200) opaque++;

    // A blank render would still have the right dimensions, so check pixels.
    expect(opaque).toBeGreaterThan(0.3 * info.width * info.height);
    expect(meta(info)).toBeTruthy();
  });

  it("keeps the print file transparent", async () => {
    await drawWithMixedGarments();
    const designer = await designerFor("bella-canvas-3001");
    const { id: assetId } = await putAsset(await solidPng(400, 400, "#22aa44"));

    const result = await submitDesign(
      db,
      designer.participantId,
      designSvg(assetUrl(assetId), designer.canvas.w, designer.canvas.h),
    );
    const png = await fetchAsset(result.printFileUrl);

    const meta2 = await sharp(png).metadata();
    expect(meta2.hasAlpha).toBe(true);

    // Corners sit outside the artwork and must let the shirt show through.
    const { data } = await sharp(png)
      .extract({ left: 0, top: 0, width: 8, height: 8 })
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    for (let i = 3; i < data.length; i += 4) expect(data[i]).toBe(0);
  });

  it("records preflight findings and marks a clean design submitted", async () => {
    await drawWithMixedGarments();
    const designer = await designerFor("bella-canvas-3001");
    const { id: assetId } = await putAsset(await solidPng(2000, 2400, "#cc3311"));

    const result = await submitDesign(
      db,
      designer.participantId,
      designSvg(assetUrl(assetId), designer.canvas.w, designer.canvas.h),
    );

    expect(result.status).toBe("submitted");

    // Select this designer's own row: there is one design per assignment, so
    // taking the first row of the table would be an arbitrary participant's.
    const mine = await getMyAssignment(db, designer.participantId);
    const [row] = await db
      .select()
      .from(designs)
      .where(eq(designs.assignmentId, mine!.assignment.id));
    expect(row.status).toBe("submitted");
    expect(row.submittedAt).not.toBeNull();
    expect(row.printFileUrl).toBeTruthy();
    expect(row.previewUrl).toBeTruthy();
  });

  it("refuses a design pointing at an image outside the app", async () => {
    await drawWithMixedGarments();
    const designer = await designerFor("bella-canvas-3001");

    // Would otherwise render as a blank shirt with no error at all.
    await expect(
      submitDesign(
        db,
        designer.participantId,
        designSvg("https://example.com/cat.png", designer.canvas.w, designer.canvas.h),
      ),
    ).rejects.toThrow(SvgAssetError);
  });

  it("rejects a submission after the deadline", async () => {
    await drawWithMixedGarments();
    await db
      .update(events)
      .set({ deadline: new Date(Date.now() - 86_400_000) })
      .where(eq(events.id, eventId));

    const designer = await designerFor("bella-canvas-3001");
    const { id: assetId } = await putAsset(await solidPng(400, 400, "#333333"));

    // Enforced server-side, so a direct request cannot get around a disabled
    // button in the UI.
    await expect(
      submitDesign(
        db,
        designer.participantId,
        designSvg(assetUrl(assetId), designer.canvas.w, designer.canvas.h),
      ),
    ).rejects.toThrow(/deadline passed/);
  });

  it("rejects submissions once the exchange is locked", async () => {
    await drawWithMixedGarments();
    const designer = await designerFor("bella-canvas-3001");
    await db.update(events).set({ state: "locked" }).where(eq(events.id, eventId));

    const { id: assetId } = await putAsset(await solidPng(400, 400, "#333333"));
    await expect(
      submitDesign(
        db,
        designer.participantId,
        designSvg(assetUrl(assetId), designer.canvas.w, designer.canvas.h),
      ),
    ).rejects.toThrow(/closed/);
  });

  it("refuses when the caller has no assignment", async () => {
    const { id: assetId } = await putAsset(await solidPng(400, 400, "#333333"));
    await expect(submitDesign(db, roster[0], designSvg(assetUrl(assetId)))).rejects.toThrow(
      SubmitError,
    );
  });
});

describe("autosaveDesign", () => {
  it("stores canvas state against the caller's own design", async () => {
    await drawWithMixedGarments();
    await autosaveDesign(db, roster[0], { version: "6", objects: [{ type: "path" }] });

    const mine = await getMyAssignment(db, roster[0]);
    const [row] = await db
      .select()
      .from(designs)
      .where(eq(designs.assignmentId, mine!.assignment.id));

    expect(row.canvasJson).toEqual({ version: "6", objects: [{ type: "path" }] });
  });
});

/** Assets are addressed by id; in tests we read them straight back from storage. */
async function fetchAsset(url: string): Promise<Buffer> {
  const { getAsset } = await import("./storage");
  return getAsset(url.replace("/api/assets/", ""));
}

function meta(info: { width: number; height: number }) {
  return info.width > 0 && info.height > 0;
}
