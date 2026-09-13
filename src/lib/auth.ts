import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { magicLink } from "better-auth/plugins";
import { APIError } from "better-auth/api";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { db } from "@/db";
import { accounts, sessions, users, verifications } from "@/db/schema";
import { sendAll } from "./email";
import { acceptInvite, isInvited, participantForUser } from "./invites";
import { MAGIC_LINK_TTL_LABEL, MAGIC_LINK_TTL_SECONDS } from "./signin-policy";

/**
 * Passwordless sign-in, gated on the invite list.
 *
 * The invite list *is* the authorization: an address that is not on it cannot
 * get an account, and cannot keep one. The rules themselves live in
 * lib/invites.ts, where they are directly tested - this file is the wiring.
 */

/** Vercel sets these; AUTH_* are read as a fallback so an existing .env keeps working. */
const baseURL =
  process.env.BETTER_AUTH_URL ??
  process.env.AUTH_URL ??
  (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : "http://localhost:3000");

export const auth = betterAuth({
  baseURL,
  secret: process.env.BETTER_AUTH_SECRET ?? process.env.AUTH_SECRET,

  database: drizzleAdapter(db, {
    provider: "pg",
    // Our constants are plural; Better Auth's models are singular.
    schema: { user: users, session: sessions, account: accounts, verification: verifications },
  }),

  plugins: [
    magicLink({
      // Better Auth defaults this to 300 seconds. Anyone who opens the email
      // after lunch would get an unexplained "invalid link" on their very
      // first contact with the app. An hour is the promise the email makes.
      expiresIn: MAGIC_LINK_TTL_SECONDS,

      async sendMagicLink({ email, url }) {
        // Reuses the Resend wrapper, so "no RESEND_API_KEY means a logged
        // no-op" behaves the same here as it does for deadline reminders.
        const result = await sendAll([
          {
            to: email,
            subject: "Your sign-in link",
            text: [
              "Here's your link to sign in:",
              "",
              url,
              "",
              `It works once and expires in ${MAGIC_LINK_TTL_LABEL}. If you didn't ask`,
              "for it, you can ignore this.",
            ].join("\n"),
          },
        ]);

        // Throwing rather than returning quietly. The sign-in form always says
        // "check your email" - it has to, or it would confirm who is on the
        // invite list - so an unverified Resend domain would otherwise fail
        // completely silently and nobody would ever be able to sign in.
        if (result.errors.length > 0 || result.skipped > 0) {
          const why = result.errors.join("; ") || "RESEND_API_KEY is not set";
          console.error(`[auth] could not send a sign-in link to ${email}: ${why}`);
          throw new APIError("INTERNAL_SERVER_ERROR", {
            message: "The sign-in email could not be sent.",
          });
        }
      },
    }),
  ],

  databaseHooks: {
    user: {
      create: {
        /**
         * The gate. An uninvited address never gets an account.
         *
         * This fires only at account creation, which is why requireSession
         * below re-checks on every request - see the comment there.
         */
        before: async (user) => {
          if (!user.email || !(await isInvited(db, user.email))) {
            throw new APIError("FORBIDDEN", {
              message: "That email isn't on the invite list for this exchange.",
            });
          }
          return { data: user };
        },
        /**
         * Links the new user to the exchange. Idempotent, because magic links
         * get clicked more than once.
         */
        after: async (user) => {
          if (user.email) {
            await acceptInvite(db, { id: user.id, email: user.email, name: user.name });
          }
        },
      },
    },
  },
});

export type AppSession = {
  user: { id: string; email: string; name?: string | null };
  participantId: string;
  isAdmin: boolean;
};

/**
 * Session, or throw. For pages and actions that require a signed-in user.
 *
 * Re-checks the invite list on every request rather than trusting that the
 * sign-in gate ran once. Two reasons: the create hook fires only when an
 * account is first made, so someone removed from the list afterwards would
 * otherwise keep their access indefinitely - and unlike a framework hook, this
 * layer is reachable from tests.
 */
export async function requireSession(): Promise<AppSession> {
  const result = await auth.api.getSession({ headers: await headers() });
  if (!result?.user?.id || !result.user.email) {
    throw new Error("You need to be signed in.");
  }

  if (!(await isInvited(db, result.user.email))) {
    throw new Error("That email is no longer on the invite list for this exchange.");
  }

  const participant = await participantForUser(db, result.user.id);
  if (!participant) throw new Error("You are not part of this exchange.");

  return {
    user: { id: result.user.id, email: result.user.email, name: result.user.name },
    participantId: participant.id,
    isAdmin: participant.isAdmin,
  };
}

export async function requireAdmin(): Promise<AppSession> {
  const session = await requireSession();
  if (!session.isAdmin) throw new Error("That is an organizer-only action.");
  return session;
}

/**
 * Session for a *page*, or a redirect to somewhere that makes sense.
 *
 * Pages need this rather than `requireSession`. A thrown error from a server
 * component renders as "Application error: a server-side exception has
 * occurred" in production, because Next strips the message - so bookmarking
 * /dashboard while signed out, or just coming back after a session expired,
 * looked like the app was broken.
 *
 * Redirects rather than error pages for the same reason: the message we would
 * want to show is exactly the thing production throws away. Each destination
 * can say what happened in its own words.
 */
export async function requirePageSession(): Promise<AppSession> {
  const result = await auth.api.getSession({ headers: await headers() });
  if (!result?.user?.id || !result.user.email) redirect("/signin");

  // Signed in but no longer welcome. Sending them back to /signin would be an
  // infinite loop - they already have a valid session, it just isn't enough.
  if (!(await isInvited(db, result.user.email))) redirect("/no-access");

  const participant = await participantForUser(db, result.user.id);
  if (!participant) redirect("/no-access");

  return {
    user: { id: result.user.id, email: result.user.email, name: result.user.name },
    participantId: participant.id,
    isAdmin: participant.isAdmin,
  };
}

/** Admin-only page. Everyone else goes to the dashboard, which is theirs. */
export async function requirePageAdmin(): Promise<AppSession> {
  const session = await requirePageSession();
  if (!session.isAdmin) redirect("/dashboard");
  return session;
}

/** Non-throwing variant, for pages that render differently when signed out. */
export async function currentSession(): Promise<AppSession | null> {
  try {
    return await requireSession();
  } catch {
    return null;
  }
}
