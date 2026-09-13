import Link from "next/link";
import { currentSession } from "@/lib/auth";
import { signOut } from "./actions";

/**
 * The header, which exists mostly so there is somewhere to sign out from.
 *
 * There was no way to sign out at all - a problem for anyone sharing a laptop,
 * and for testing the invite gate with a second address.
 */
export async function Nav() {
  const session = await currentSession();
  if (!session) return null;

  return (
    <nav className="mb-8 flex items-center justify-between border-b border-black/10 pb-3 text-sm">
      <Link href="/dashboard" className="font-medium">
        Secret Santa Shirts
      </Link>
      <div className="flex items-center gap-4">
        <span className="text-ink/50">{session.user.email}</span>
        <form action={signOut}>
          <button type="submit" className="underline">
            Sign out
          </button>
        </form>
      </div>
    </nav>
  );
}
