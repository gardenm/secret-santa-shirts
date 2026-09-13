import { beforeEach, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "@/db/testing";
import {
  MAGIC_LINK_TTL_LABEL,
  MAGIC_LINK_TTL_SECONDS,
  SIGN_IN_THROTTLE_MS,
  claimSignInSend,
} from "./signin-policy";

let db: TestDb;

beforeEach(async () => {
  db = await createTestDb();
});

describe("claimSignInSend", () => {
  it("allows the first request and refuses the next one", async () => {
    const now = new Date("2026-11-20T12:00:00Z");

    expect(await claimSignInSend(db, "alex@example.com", now)).toBe(true);
    expect(await claimSignInSend(db, "alex@example.com", now)).toBe(false);
  });

  it("allows it again once the window has passed", async () => {
    const now = new Date("2026-11-20T12:00:00Z");
    const later = new Date(now.getTime() + SIGN_IN_THROTTLE_MS + 1);

    expect(await claimSignInSend(db, "alex@example.com", now)).toBe(true);
    expect(await claimSignInSend(db, "alex@example.com", later)).toBe(true);
  });

  it("throttles per address, not globally", async () => {
    // Twelve people signing in at once on the first evening is the normal
    // case, and must not look like abuse.
    const now = new Date("2026-11-20T12:00:00Z");

    expect(await claimSignInSend(db, "alex@example.com", now)).toBe(true);
    expect(await claimSignInSend(db, "bailey@example.com", now)).toBe(true);
  });

  it("treats an address as one address however it is typed", async () => {
    // Otherwise the limit is bypassed by changing the capitalisation, which is
    // not much of a limit.
    const now = new Date("2026-11-20T12:00:00Z");

    expect(await claimSignInSend(db, "alex@example.com", now)).toBe(true);
    expect(await claimSignInSend(db, "  Alex@Example.COM ", now)).toBe(false);
  });

  it("lets exactly one of several simultaneous requests through", async () => {
    // The reason this is one upsert rather than a read then a write: a
    // read-then-write check passes for every request that reads before any of
    // them writes, and they all send.
    const now = new Date("2026-11-20T12:00:00Z");

    const results = await Promise.all(
      Array.from({ length: 5 }, () => claimSignInSend(db, "alex@example.com", now)),
    );

    expect(results.filter(Boolean)).toHaveLength(1);
  });
});

describe("magic link lifetime", () => {
  it("keeps the configured expiry and the sentence in the email in step", () => {
    // These drifted apart once already: Better Auth defaults to 300 seconds
    // while the email promised 24 hours, so a link opened after lunch failed
    // with no explanation on someone's first contact with the app.
    expect(MAGIC_LINK_TTL_SECONDS).toBe(3600);
    expect(MAGIC_LINK_TTL_LABEL).toBe("an hour");
  });

  it("is long enough to survive an email round trip", () => {
    // The floor that matters. Better Auth's default sits below it.
    expect(MAGIC_LINK_TTL_SECONDS).toBeGreaterThan(15 * 60);
  });
});
