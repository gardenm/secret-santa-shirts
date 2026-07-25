import { eq } from "drizzle-orm";
import { db } from "@/db";
import { assignments, participants } from "@/db/schema";
import { requireAdmin } from "@/lib/auth";
import { currentEvent, rosterFor } from "@/lib/invites";
import { AdminForms } from "./forms";

export default async function AdminPage() {
  await requireAdmin();
  const event = await currentEvent(db);

  if (!event) {
    return (
      <main className="space-y-4">
        <h1 className="text-2xl font-semibold">Organizer tools</h1>
        <p className="text-ink/70">No exchange has been set up yet.</p>
      </main>
    );
  }

  const roster = await rosterFor(db, event.id);
  const drawn = await db.select().from(assignments).where(eq(assignments.eventId, event.id));
  const people = await db
    .select({ id: participants.id, displayName: participants.displayName })
    .from(participants)
    .where(eq(participants.eventId, event.id));

  const missing = roster.filter((r: { chosenShirt: boolean }) => !r.chosenShirt);

  return (
    <main className="space-y-6">
      <h1 className="text-2xl font-semibold">Organizer tools</h1>

      <section className="card space-y-3">
        <h2 className="font-medium">Who&rsquo;s in</h2>
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-ink/60">
              <th className="pb-2">Email</th>
              <th className="pb-2">Joined</th>
              <th className="pb-2">Shirt chosen</th>
            </tr>
          </thead>
          <tbody>
            {roster.map((row: { email: string; joined: boolean; chosenShirt: boolean }) => (
              <tr key={row.email} className="border-t border-black/5">
                <td className="py-2">{row.email}</td>
                <td>{row.joined ? "yes" : "—"}</td>
                <td>{row.chosenShirt ? "yes" : "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {roster.length === 0 && <p className="text-sm text-ink/60">Nobody invited yet.</p>}
      </section>

      <AdminForms
        people={people}
        alreadyDrawn={drawn.length > 0}
        missingCount={missing.length}
        deadline={event.deadline.toISOString().slice(0, 10)}
      />

      {drawn.length > 0 && (
        <section className="card space-y-3">
          <h2 className="font-medium">Export the order</h2>
          <p className="text-sm text-ink/70">
            Print-ready files, a manifest to paste into the vendor&rsquo;s form, mockups and a
            contact sheet. Anyone without a finished design is listed at the top rather than quietly
            left out.
          </p>
          <div className="flex flex-wrap gap-2">
            <a href="/api/admin/export" className="btn-primary">
              Download bundle
            </a>
            <a href="/api/admin/export?blind=1" className="btn-secondary">
              Download blind
            </a>
          </div>
          <p className="text-xs text-ink/50">
            &ldquo;Blind&rdquo; names files by code and puts the name mapping in a separate sealed
            file, so you can place the order without seeing whose shirt is whose.
          </p>
        </section>
      )}

      {drawn.length > 0 && (
        <p className="text-sm text-ink/60">
          The draw is done — {drawn.length} assignments, and everyone&rsquo;s shirt choice is now
          locked. Re-running it would invalidate any designs already in progress, so it can&rsquo;t
          be repeated.
        </p>
      )}
    </main>
  );
}
