import { asc, eq } from "drizzle-orm";
import { garmentColours, garments } from "@/db/schema";

/**
 * Garment catalog loading and validation.
 *
 * Every function takes `db` rather than importing the singleton, so tests can
 * inject an in-process PGlite instance and exercise the real queries.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
type Db = any;

export class SelectionError extends Error {}

export type Selection = {
  garmentId: string;
  colourId: string;
  size: string;
  fit: string;
};

export async function loadCatalog(db: Db) {
  const models = await db.select().from(garments).where(eq(garments.active, true)).orderBy(asc(garments.sortOrder));

  const colours = await db.select().from(garmentColours);

  return models.map((garment: typeof garments.$inferSelect) => ({
    ...garment,
    colours: colours
      .filter((c: typeof garmentColours.$inferSelect) => c.garmentId === garment.id)
      .sort(
        (a: typeof garmentColours.$inferSelect, b: typeof garmentColours.$inferSelect) =>
          Number(a.isDark) - Number(b.isDark) || a.name.localeCompare(b.name),
      ),
  }));
}

/**
 * Validates a garment/colour/size/fit combination against the catalog.
 *
 * The picker filtering its dropdowns is a convenience, not the guard. This
 * runs in the server action because the catalog contains genuinely
 * unorderable combinations - heathers are not stocked in 4XL - and a request
 * can always be made by hand. Picking something that cannot be ordered is only
 * discovered at order time, when it is too late to fix.
 *
 * Returns the resolved rows so callers do not have to re-query.
 */
export async function validateSelection(db: Db, selection: Selection) {
  const [garment] = await db.select().from(garments).where(eq(garments.id, selection.garmentId));
  if (!garment) throw new SelectionError("That garment is not in the catalog.");
  if (!garment.active) throw new SelectionError(`${garment.displayName} is no longer available.`);

  const [colour] = await db
    .select()
    .from(garmentColours)
    .where(eq(garmentColours.id, selection.colourId));
  if (!colour) throw new SelectionError("That colour is not in the catalog.");

  if (colour.garmentId !== garment.id) {
    throw new SelectionError(`${colour.name} is not available on the ${garment.displayName}.`);
  }

  if (!garment.sizes.includes(selection.size)) {
    throw new SelectionError(
      `${garment.displayName} does not come in ${selection.size}. Available: ${garment.sizes.join(", ")}.`,
    );
  }

  if (!colour.availableSizes.includes(selection.size)) {
    throw new SelectionError(
      `${colour.name} is not stocked in ${selection.size}. ` +
        `It comes in ${colour.availableSizes.join(", ")}.`,
    );
  }

  if (!garment.fits.includes(selection.fit)) {
    throw new SelectionError(
      `${garment.displayName} does not come in a ${selection.fit} fit.`,
    );
  }

  return { garment, colour };
}

/** Print area for a participant's chosen garment. Never hardcode this. */
export async function printAreaFor(db: Db, garmentId: string) {
  const [garment] = await db.select().from(garments).where(eq(garments.id, garmentId));
  if (!garment) throw new SelectionError("Unknown garment.");
  return { widthPx: garment.printWPx, heightPx: garment.printHPx };
}
