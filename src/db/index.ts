import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error("DATABASE_URL is not set. Copy .env.example to .env and fill it in.");
}

// Reuse the client across hot reloads in dev so we don't exhaust connections.
const globalForDb = globalThis as unknown as { client?: postgres.Sql };

// `prepare: false` is not optional behind Neon's pooled URL, which is a
// transaction-mode pooler: each transaction can land on a different backend, so
// a statement prepared on one is missing on the next. Leaving postgres-js's
// prepared statements on produces alternating 'prepared statement "s1" already
// exists' / 'does not exist' errors - but only under concurrency, so it passes
// a solo click-through and breaks when the whole group is uploading at once.
const client = globalForDb.client ?? postgres(connectionString, { max: 5, prepare: false });
if (process.env.NODE_ENV !== "production") globalForDb.client = client;

export const db = drizzle(client, { schema });
export { schema };
