import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

/**
 * The database handle.
 *
 * Connected on first *use*, not on import. That distinction is the whole point
 * of this file's shape: `next build` imports every route module - and, through
 * the root layout, the 404 page too - to collect page data. Throwing at import
 * turned a missing DATABASE_URL into a build failure rather than a runtime one,
 * so the build needed a live database it never actually talks to. Every Vercel
 * deployment of this project failed that way:
 *
 *     Failed to collect configuration for /_not-found
 *       cause: DATABASE_URL is not set.
 *
 * The error itself is unchanged and still loud - it just arrives at the first
 * query, where it names a request instead of killing a deploy.
 */

type Database = ReturnType<typeof drizzle<typeof schema>>;

// Reused across hot reloads in dev so we don't exhaust connections.
const globalForDb = globalThis as unknown as { client?: postgres.Sql; db?: Database };

function connect(): Database {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL is not set. Copy .env.example to .env and fill it in.");
  }

  // `prepare: false` is not optional behind Neon's pooled URL, which is a
  // transaction-mode pooler: each transaction can land on a different backend,
  // so a statement prepared on one is missing on the next. Leaving postgres-js's
  // prepared statements on produces alternating 'prepared statement "s1" already
  // exists' / 'does not exist' errors - but only under concurrency, so it passes
  // a solo click-through and breaks when the whole group is uploading at once.
  const client = globalForDb.client ?? postgres(connectionString, { max: 5, prepare: false });
  if (process.env.NODE_ENV !== "production") globalForDb.client = client;

  return drizzle(client, { schema });
}

function instance(): Database {
  if (!globalForDb.db) globalForDb.db = connect();
  return globalForDb.db;
}

/**
 * A stand-in that forwards to the real handle the first time anything touches
 * it. Callers keep writing `db.select()` and `db.query.participants` exactly as
 * before; a transaction handle passed to lib functions is unaffected, since it
 * comes from drizzle rather than from here.
 */
export const db = new Proxy({} as Database, {
  get(_target, property) {
    const real = instance() as unknown as Record<string | symbol, unknown>;
    const value = real[property];
    // Bound so drizzle's methods keep their own `this` rather than the proxy.
    return typeof value === "function"
      ? (value as (...args: unknown[]) => unknown).bind(real)
      : value;
  },
  has(_target, property) {
    return property in (instance() as unknown as object);
  },
});

export { schema };
