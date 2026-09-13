import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { magicLink } from "better-auth/plugins";
import { APIError } from "better-auth/api";
import { headers } from "next/headers";
import { db } from "@/db";
import { accounts, sessions, users, verifications } from "@/db/schema";
import { sendAll } from "./email";
import { acceptInvite, isInvited, participantForUser } from "./invites";

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
      async sendMagicLink({ email, url }) {
        // Reuses the Resend wrapper, so "no RESEND_API_KEY means a logged
        // no-op" behaves the same here as it does for deadline reminders.
        await sendAll([
          {
            to: email,
            subject: "Your sign-in link",
            text: [
              "Here's your link to sign in:",
              "",
              url,
              "",
              "It works once and expires in 24 hours. If you didn't ask for it,",
              "you can ignore this.",
            ].join("\n"),
          },
        ]);
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

/** Non-throwing variant, for pages that render differently when signed out. */
export async function currentSession(): Promise<AppSession | null> {
  try {
    return await requireSession();
  } catch {
    return null;
  }
}
