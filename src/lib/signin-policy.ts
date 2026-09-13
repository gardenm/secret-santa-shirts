import { lt, sql } from "drizzle-orm";
import { signInAttempts } from "@/db/schema";
import { normaliseEmail } from "./invites";
import type { Db } from "./db-types";

/**
 * How long a sign-in link stays valid.
 *
 * Better Auth defaults this to 300 seconds. Anyone who opened the email after
 * lunch got an unexplained "invalid link" on their very first contact with the
 * app, because the email promised 24 hours. The label lives beside the number
 * so the two cannot drift apart again.
 *
 * Here rather than in lib/auth.ts so a test can read it without importing the
 * whole auth stack, which needs a live database connection.
 */
export const MAGIC_LINK_TTL_SECONDS = 60 * 60;
export const MAGIC_LINK_TTL_LABEL = "an hour";

/**
 * One sign-in email per address per minute.
 *
 * Better Auth has a rate limiter, but it runs inside its HTTP handler and we
 * call `auth.api.signInMagicLink` directly from a server action, so nothing
 * was limiting anything: the form could be used to fire unlimited mail at any
 * invited address.
 *
 * Deliberately at the action, before the link is generated - a limiter that
 * runs after the token exists has already done the expensive part.
 */
export const SIGN_IN_THROTTLE_MS = 60_000;

/**
 * Claims the right to send a link to this address, or returns false.
 *
 * One atomic upsert rather than a read followed by a write: two requests
 * arriving together would both pass a read-then-write check and both send.
 * Postgres applies the conflict clause under lock, so exactly one of them
 * comes back with a row.
 */
export async function claimSignInSend(
  db: Db,
  email: string,
  now: Date = new Date(),
  windowMs: number = SIGN_IN_THROTTLE_MS,
): Promise<boolean> {
  const cutoff = new Date(now.getTime() - windowMs);

  const rows = await db
    .insert(signInAttempts)
    .values({ email: normaliseEmail(email), lastSentAt: now })
    .onConflictDoUpdate({
      target: signInAttempts.email,
      set: { lastSentAt: now },
      // No row comes back when this fails, which is the throttled case.
      setWhere: lt(signInAttempts.lastSentAt, cutoff),
    })
    .returning({ email: sql<string>`${signInAttempts.email}` });

  return rows.length > 0;
}
