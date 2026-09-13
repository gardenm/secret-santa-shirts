import { signOut } from "../actions";

/**
 * Signed in, but not part of this exchange.
 *
 * Reached when someone's address has been taken off the invite list, or when
 * they have an account but no participant row. Not an error page: removing
 * someone is a thing the organizer can deliberately do, and the person
 * deserves a sentence explaining it rather than a crash.
 *
 * Deliberately does not require a session itself, or turning someone away
 * would loop.
 */
export default function NoAccessPage() {
  return (
    <main className="space-y-4">
      <h1 className="text-2xl font-semibold">You&rsquo;re not in this exchange</h1>
      <p className="text-ink/70">
        You&rsquo;re signed in, but your email isn&rsquo;t on the invite list for this exchange. If
        that&rsquo;s a surprise, ask whoever organised it to add you.
      </p>
      <form action={signOut}>
        <button type="submit" className="btn-secondary">
          Sign out
        </button>
      </form>
    </main>
  );
}
