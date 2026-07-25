/** CLI entry point: `npm run db:seed`. Catalog data lives in seed-catalog.ts. */
import "dotenv/config";
import { db } from "./index";
import { CATALOG, seedCatalog } from "./seed-catalog";

async function main() {
  console.log("Seeding garment catalog...");
  await seedCatalog(db);

  for (const entry of CATALOG) {
    console.log(`  ${entry.displayName}: ${entry.colours.length} colours`);
  }
  console.log("Done.");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
