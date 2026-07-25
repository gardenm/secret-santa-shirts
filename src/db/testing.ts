import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import path from "node:path";
import * as schema from "./schema";
import { seedCatalog } from "./seed-catalog";

export type TestDb = ReturnType<typeof drizzle<typeof schema>>;

/**
 * An in-process Postgres for integration tests.
 *
 * PGlite is real Postgres compiled to WASM, not an emulation - which is the
 * whole point. The no-self-assignment guarantee is a CHECK constraint, and the
 * one-in/one-out guarantee is a pair of unique indexes; testing them against
 * SQLite or a mock would prove nothing about what the production database
 * actually does.
 *
 * No daemon and no Docker required, neither of which is available in CI here.
 */
export async function createTestDb(): Promise<TestDb & { $client: PGlite }> {
  const client = new PGlite();
  const db = drizzle(client, { schema });

  await migrate(db, { migrationsFolder: path.join(process.cwd(), "src/db/migrations") });
  await seedCatalog(db);

  return Object.assign(db, { $client: client });
}

export { schema };
