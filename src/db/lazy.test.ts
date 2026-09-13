import { describe, expect, it } from "vitest";

/**
 * The database must not connect at import time.
 *
 * Every Vercel deployment of this project failed because it did. `next build`
 * imports each route module - and, through the root layout's nav, the 404 page
 * - to collect page data, so a module-scope throw on a missing DATABASE_URL
 * turned a missing env var into a build failure. The build never talks to the
 * database; it only loads the code.
 *
 * These run with no DATABASE_URL set, which is exactly the build's situation.
 */
describe("importing the database module", () => {
  it("does not throw, even with no DATABASE_URL", async () => {
    expect(process.env.DATABASE_URL).toBeUndefined();
    await expect(import("./index")).resolves.toBeDefined();
  });

  it("still fails loudly, and with the same message, on first use", async () => {
    // Laziness must not turn a misconfigured deployment into a quiet null.
    const { db } = await import("./index");
    expect(() => db.select()).toThrow(/DATABASE_URL is not set/);
  });
});

describe("importing the auth module", () => {
  it("does not throw either", async () => {
    // betterAuth() constructs the drizzle adapter, which reads the handle
    // immediately - so this file has to be lazy for the same reason.
    await expect(import("@/lib/auth")).resolves.toBeDefined();
  });
});
