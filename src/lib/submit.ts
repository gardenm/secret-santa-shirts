import { eq } from "drizzle-orm";
import { designs, events } from "@/db/schema";
import { getMyAssignment } from "./event-service";
import { preflight, type PreflightResult } from "./preflight";
import { renderDesign, renderPreview } from "./render";
import { assetUrl, putAsset } from "./storage";
import { inlineAssets } from "./svg-assets";

/**
 * Turning a canvas into a print-ready file.
 *
 * Takes `db` rather than importing the singleton so tests can inject PGlite.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
type Db = any;

export class SubmitError extends Error {}

export type SubmitResult = {
  preflight: PreflightResult;
  printFileUrl: string;
  previewUrl: string;
  status: "draft" | "submitted";
};

/**
 * Renders, checks and stores a design.
 *
 * Ownership is structural: the assignment is resolved from the caller's own
 * participant id, so there is no design id to pass and none to tamper with.
 */
export async function submitDesign(
  db: Db,
  participantId: string,
  svg: string,
): Promise<SubmitResult> {
  const mine = await getMyAssignment(db, participantId);
  if (!mine) throw new SubmitError("You don't have an assignment yet.");

  const recipient = mine.recipient;
  if (!recipient?.garment || !recipient?.colour) {
    throw new SubmitError(
      `${recipient?.displayName ?? "Your person"} hasn't chosen a shirt yet, so there's nothing ` +
        `to size the design against.`,
    );
  }

  // A client clock is not a lock: the deadline is enforced here, not by a
  // disabled button.
  const [event] = await db.select().from(events).where(eq(events.id, recipient.eventId));
  if (event && event.deadline.getTime() < Date.now()) {
    throw new SubmitError(
      `The deadline passed on ${event.deadline.toLocaleDateString()}. Ask the organizer to extend ` +
        `it if you still need to submit.`,
    );
  }
  if (event && (event.state === "locked" || event.state === "revealed")) {
    throw new SubmitError("Designs are closed for this exchange.");
  }

  const printArea = { widthPx: recipient.garment.printWPx, heightPx: recipient.garment.printHPx };

  // Resolve image layers to data URIs. Without this the render succeeds and
  // produces a blank shirt - see svg-assets.ts.
  const resolved = await inlineAssets(svg);

  const printFile = await renderDesign(resolved, { printArea });

  const findings = await preflight(printFile, {
    printArea,
    isDark: recipient.colour.isDark,
    colourHex: recipient.colour.hex,
    colourName: recipient.colour.name,
  });

  const preview = await renderPreview(resolved, {
    printArea,
    widthPx: 700,
    background: recipient.colour.hex,
  });

  const stored = await putAsset(printFile);
  const storedPreview = await putAsset(preview);

  // Errors keep it a draft. Warnings do not - they are judgement calls the
  // designer is allowed to make.
  const status: "draft" | "submitted" = findings.ok ? "submitted" : "draft";

  await db
    .update(designs)
    .set({
      printFileUrl: assetUrl(stored.id),
      previewUrl: assetUrl(storedPreview.id),
      preflight: findings,
      status,
      submittedAt: findings.ok ? new Date() : null,
      updatedAt: new Date(),
    })
    .where(eq(designs.assignmentId, mine.assignment.id));

  return {
    preflight: findings,
    printFileUrl: assetUrl(stored.id),
    previewUrl: assetUrl(storedPreview.id),
    status,
  };
}

/** Debounced canvas autosave, so nobody loses work. */
export async function autosaveDesign(db: Db, participantId: string, canvasJson: unknown) {
  const mine = await getMyAssignment(db, participantId);
  if (!mine) throw new SubmitError("You don't have an assignment yet.");

  await db
    .update(designs)
    .set({ canvasJson, updatedAt: new Date() })
    .where(eq(designs.assignmentId, mine.assignment.id));
}

/** The print area the editor should use: always the recipient's garment. */
export async function printAreaForDesigner(db: Db, participantId: string) {
  const mine = await getMyAssignment(db, participantId);
  if (!mine?.recipient?.garment) return null;

  return {
    widthPx: mine.recipient.garment.printWPx,
    heightPx: mine.recipient.garment.printHPx,
  };
}
