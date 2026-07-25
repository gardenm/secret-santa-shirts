import Link from "next/link";
import { auth } from "@/lib/auth";
import { db } from "@/db";
import { currentEvent } from "@/lib/invites";

export default async function Home() {
  const session = await auth();
  const event = await currentEvent(db).catch(() => null);

  if (session?.user) {
    return (
      <main className="space-y-6">
        <h1 className="text-3xl font-semibold">{event?.name ?? "Secret Santa Shirts"}</h1>
        <Link href="/dashboard" className="btn-primary">
          Go to your dashboard
        </Link>
      </main>
    );
  }

  return (
    <main className="space-y-6">
      <h1 className="text-3xl font-semibold">{event?.name ?? "Secret Santa Shirts"}</h1>
      <p className="text-ink/70">
        Everyone is matched with one other person and designs a t-shirt for them. Sign in with the
        email address you were invited on.
      </p>
      <Link href="/signin" className="btn-primary">
        Sign in
      </Link>
    </main>
  );
}
