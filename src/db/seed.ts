/**
 * Seeds the garment catalog.
 *
 * Colours are a curated catalog rather than a colour picker on purpose: not
 * every colour is stocked in every size, and a participant who picks something
 * unorderable only finds out at order time, when it is too late to fix.
 *
 * `isDark` is not cosmetic - it decides which DTG underbase warnings preflight
 * raises for anyone designing for that shirt.
 */
import "dotenv/config";
import { db } from "./index";
import { garmentColours, garments } from "./schema";

const TEE_SIZES = ["XS", "S", "M", "L", "XL", "2XL", "3XL", "4XL"];
const FITTED_SIZES = ["XS", "S", "M", "L", "XL", "2XL"];
const HOODIE_SIZES = ["S", "M", "L", "XL", "2XL", "3XL"];

/** Colours stocked across the full size run. */
const SHARED_COLOURS: Array<{ name: string; hex: string; isDark: boolean }> = [
  { name: "White", hex: "#FFFFFF", isDark: false },
  { name: "Natural", hex: "#E8E0D0", isDark: false },
  { name: "Ash", hex: "#D6D6CE", isDark: false },
  { name: "Athletic Heather", hex: "#B5B5B5", isDark: false },
  { name: "Dusty Blue", hex: "#8FA9C4", isDark: false },
  { name: "Heather Prism Peach", hex: "#F0C8B4", isDark: false },
  { name: "Storm", hex: "#6B7B87", isDark: true },
  { name: "Heather Forest", hex: "#4A5D4E", isDark: true },
  { name: "Military Green", hex: "#5A5C48", isDark: true },
  { name: "Maroon", hex: "#6B2737", isDark: true },
  { name: "Team Purple", hex: "#4B3168", isDark: true },
  { name: "True Royal", hex: "#1F4E96", isDark: true },
  { name: "Navy", hex: "#232F3E", isDark: true },
  { name: "Dark Grey Heather", hex: "#3E3E3E", isDark: true },
  { name: "Black", hex: "#111111", isDark: true },
];

const CATALOG = [
  {
    model: "bella-canvas-3001",
    displayName: "Unisex T-Shirt",
    // 11" x 14" at 300 DPI. Deliberately inside every vendor's 12"x16" maximum
    // so no vendor-specific re-crop is needed, and so AI art needs only a
    // gentle upscale to fill it.
    printWPx: 3300,
    printHPx: 4200,
    sizes: TEE_SIZES,
    fits: ["unisex"],
    sortOrder: 1,
    colours: SHARED_COLOURS,
  },
  {
    model: "bella-canvas-6400",
    displayName: "Relaxed Fit T-Shirt",
    printWPx: 3300,
    printHPx: 4200,
    sizes: FITTED_SIZES,
    fits: ["fitted"],
    sortOrder: 2,
    colours: SHARED_COLOURS.filter((c) => !["Natural", "Storm"].includes(c.name)),
  },
  {
    model: "bella-canvas-3501",
    displayName: "Long Sleeve T-Shirt",
    printWPx: 3300,
    printHPx: 4200,
    sizes: TEE_SIZES.filter((s) => s !== "4XL"),
    fits: ["unisex"],
    sortOrder: 3,
    colours: SHARED_COLOURS.filter((c) =>
      ["White", "Athletic Heather", "Navy", "Black", "Maroon", "True Royal"].includes(c.name),
    ),
  },
  {
    model: "gildan-18500",
    displayName: "Hoodie",
    // A hoodie's printable area is smaller and squarer than a tee's - the
    // pouch pocket eats the bottom of the print field. 10" x 12" at 300 DPI.
    printWPx: 3000,
    printHPx: 3600,
    sizes: HOODIE_SIZES,
    fits: ["unisex"],
    sortOrder: 4,
    colours: SHARED_COLOURS.filter((c) =>
      ["White", "Athletic Heather", "Navy", "Black", "Maroon", "Military Green"].includes(c.name),
    ),
  },
];

async function seed() {
  console.log("Seeding garment catalog...");

  for (const entry of CATALOG) {
    const [garment] = await db
      .insert(garments)
      .values({
        model: entry.model,
        displayName: entry.displayName,
        printWPx: entry.printWPx,
        printHPx: entry.printHPx,
        sizes: entry.sizes,
        fits: entry.fits,
        sortOrder: entry.sortOrder,
      })
      .onConflictDoUpdate({
        target: garments.model,
        set: {
          displayName: entry.displayName,
          printWPx: entry.printWPx,
          printHPx: entry.printHPx,
          sizes: entry.sizes,
          fits: entry.fits,
          sortOrder: entry.sortOrder,
        },
      })
      .returning();

    for (const colour of entry.colours) {
      await db
        .insert(garmentColours)
        .values({
          garmentId: garment.id,
          name: colour.name,
          hex: colour.hex,
          isDark: colour.isDark,
          // 4XL is thinly stocked across the industry; exclude it from the
          // heathers, which is where it is most often unavailable.
          availableSizes: colour.name.includes("Heather")
            ? entry.sizes.filter((s) => s !== "4XL")
            : entry.sizes,
        })
        .onConflictDoUpdate({
          target: [garmentColours.garmentId, garmentColours.name],
          set: { hex: colour.hex, isDark: colour.isDark },
        });
    }

    console.log(`  ${entry.displayName}: ${entry.colours.length} colours`);
  }

  console.log("Done.");
  process.exit(0);
}

seed().catch((err) => {
  console.error(err);
  process.exit(1);
});
