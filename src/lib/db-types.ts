import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import type * as schema from "@/db/schema";

/**
 * The database, as the lib modules see it.
 *
 * Everything below `lib/` takes `db` as a parameter rather than importing the
 * singleton, so tests can hand it PGlite. This is the type both drivers
 * satisfy - postgres-js in production, PGlite in tests - and a transaction
 * handle satisfies it too, which is what lets `runDraw` pass its `tx` straight
 * through.
 *
 * It replaces a `type Db = any` that was repeated in five modules and quietly
 * cost every query in them its types.
 */
export type Db = PgDatabase<PgQueryResultHKT, typeof schema>;
