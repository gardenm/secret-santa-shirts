import type { Config } from "drizzle-kit";

export default {
  schema: "./src/db/schema.ts",
  out: "./src/db/migrations",
  dialect: "postgresql",
  dbCredentials: {
    // Migrations run DDL, which does not belong in a transaction pool. Vercel's
    // Neon integration sets DATABASE_URL_UNPOOLED to the direct endpoint for
    // exactly this; anyone on a plain local Postgres just has DATABASE_URL.
    // `||` rather than `??`: an env var set to the empty string is how a var
    // usually arrives "unset", and that must fall through, not win.
    url: process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL!,
  },
} satisfies Config;
