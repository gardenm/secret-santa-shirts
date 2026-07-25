import NextAuth from "next-auth";
import Resend from "next-auth/providers/resend";
import { DrizzleAdapter } from "@auth/drizzle-adapter";
import { db } from "@/db";
import { accounts, sessions, users, verificationTokens } from "@/db/schema";
import { acceptInvite, isInvited, participantForUser } from "./invites";

/**
 * Passwordless sign-in, gated on the invite list.
 *
 * The invite list *is* the authorization: the `signIn` callback rejects any
 * address that is not on it, so there is no second allowlist to maintain and
 * someone who finds the URL cannot join the exchange. The logic itself lives
 * in lib/invites.ts, where it is directly tested.
 */
export const { handlers, auth, signIn, signOut } = NextAuth({
  adapter: DrizzleAdapter(db, {
    usersTable: users,
    accountsTable: accounts,
    sessionsTable: sessions,
    verificationTokensTable: verificationTokens,
  }),
  providers: [
    Resend({
      apiKey: process.env.RESEND_API_KEY,
      // Resend only sends from a verified domain. `onboarding@resend.dev`
      // works for testing but delivers only to your own address - a confusing
      // failure mode if you do not know it going in.
      from: process.env.EMAIL_FROM ?? "onboarding@resend.dev",
    }),
  ],
  pages: {
    signIn: "/signin",
    verifyRequest: "/signin?sent=1",
    error: "/signin",
  },
  session: { strategy: "database" },
  callbacks: {
    async signIn({ user }) {
      if (!user.email) return false;
      return isInvited(db, user.email);
    },

    async session({ session, user }) {
      // Attach the participant so every page can do an ownership check without
      // a second round trip.
      const participant = await participantForUser(db, user.id);
      return {
        ...session,
        participantId: participant?.id ?? null,
        isAdmin: participant?.isAdmin ?? false,
        hasChosenShirt: Boolean(participant?.sizeConfirmedAt),
      };
    },
  },
  events: {
    // Runs after the adapter has created the user record, so there is an id to
    // link the participant to.
    async signIn({ user }) {
      if (!user.email || !user.id) return;
      await acceptInvite(db, { id: user.id, email: user.email, name: user.name });
    },
  },
});

/**
 * Declared standalone rather than derived from `auth()`, whose return type is
 * overloaded to cover its use as middleware and does not narrow usefully.
 */
export type AppSession = {
  user?: { id?: string; email?: string | null; name?: string | null };
  participantId?: string | null;
  isAdmin?: boolean;
  hasChosenShirt?: boolean;
};

/** Session, or throw. For pages and actions that require a signed-in user. */
export async function requireSession() {
  const session = (await auth()) as AppSession | null;
  if (!session?.user || !session.participantId) {
    throw new Error("You need to be signed in.");
  }
  return session as AppSession & { participantId: string };
}

export async function requireAdmin() {
  const session = await requireSession();
  if (!session.isAdmin) throw new Error("That is an organizer-only action.");
  return session;
}
