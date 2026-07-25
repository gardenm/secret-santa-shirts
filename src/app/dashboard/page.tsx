import Link from "next/link";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { participants } from "@/db/schema";
import { requireSession } from "@/lib/auth";
import { getMyAssignment, outstandingSelections } from "@/lib/event-service";
import { currentEvent } from "@/lib/invites";

function daysUntil(date: Date): number {
  return Math.ceil((date.getTime() - Date.now()) / 86_400_000);
}

export default async function DashboardPage() {
  const session = await requireSession();
  const event = await currentEvent(db);

  const [me] = await db
    .select()
    .from(participants)
    .where(eq(participants.id, session.participantId));

  // The only path that reads an assignment, and it is always filtered to the
  // caller's own. No page fetches one by an id from the URL.
  const mine = await getMyAssignment(db, session.participantId);

  return (
    <main className="space-y-6">
      <header className="flex items-baseline justify-between">
        <h1 className="text-2xl font-semibold">{event?.name ?? "Secret Santa Shirts"}</h1>
        {session.isAdmin && (
          <Link href="/admin" className="text-sm underline">
            Organizer tools
          </Link>
        )}
      </header>

      {!me?.sizeConfirmedAt && (
        <div className="card border-cranberry/30 bg-cranberry/5">
          <p className="font-medium">You haven&rsquo;t picked your shirt yet.</p>
          <p className="mt-1 text-sm text-ink/70">
            Whoever is designing for you needs this before they can start.
          </p>
          <Link href="/join" className="btn-primary mt-4">
            Pick my shirt
          </Link>
        </div>
      )}

      {mine ? (
        <section className="card space-y-4">
          <div>
            <p className="text-sm uppercase tracking-wide text-ink/50">You&rsquo;re designing for</p>
            <h2 className="text-xl font-semibold">{mine.recipient?.displayName}</h2>
          </div>

          <dl className="grid gap-3 sm:grid-cols-2">
            <div>
              <dt className="text-sm text-ink/60">Garment</dt>
              <dd>{mine.recipient?.garment?.displayName}</dd>
            </div>
            <div>
              <dt className="text-sm text-ink/60">Colour</dt>
              <dd className="flex items-center gap-2">
                <span
                  className="inline-block h-5 w-5 rounded-full border border-black/20"
                  style={{ backgroundColor: mine.recipient?.colour?.hex }}
                />
                {mine.recipient?.colour?.name}
              </dd>
            </div>
            <div>
              <dt className="text-sm text-ink/60">Size</dt>
              <dd>
                {mine.recipient?.size} ({mine.recipient?.fit})
              </dd>
            </div>
            <div>
              <dt className="text-sm text-ink/60">Print area</dt>
              <dd>
                {mine.recipient?.garment
                  ? `${mine.recipient.garment.printWPx / 300}" x ${mine.recipient.garment.printHPx / 300}"`
                  : "—"}
              </dd>
            </div>
          </dl>

          {mine.recipient?.notes && (
            <div>
              <p className="text-sm text-ink/60">They said</p>
              <p className="italic">&ldquo;{mine.recipient.notes}&rdquo;</p>
            </div>
          )}

          {mine.recipient?.colour?.isDark && (
            <p className="rounded-lg bg-ink/5 p-3 text-sm text-ink/70">
              This is a dark shirt. The printer lays white ink underneath the design, so soft glows,
              drop shadows and faded edges come out as a chalky halo — and anything black prints
              grey. Leave areas you want to read as black fully transparent so the shirt shows
              through.
            </p>
          )}

          <div className="flex items-center gap-3 border-t border-black/10 pt-4">
            <Link href="/design" className="btn-primary">
              {mine.design?.status === "submitted" ? "Edit your design" : "Make their design"}
            </Link>
            {mine.design?.status === "submitted" && (
              <span className="text-sm text-pine">Saved and print-ready.</span>
            )}
          </div>
        </section>
      ) : (
        <section className="card">
          <p className="font-medium">The draw hasn&rsquo;t happened yet.</p>
          <p className="mt-1 text-sm text-ink/70">
            You&rsquo;ll find out who you&rsquo;re designing for once everyone has joined and the
            organizer runs it.
          </p>
          <Outstanding eventId={event?.id} />
        </section>
      )}

      {event && (
        <p className="text-sm text-ink/60">
          {daysUntil(event.deadline) >= 0
            ? `Designs are due ${event.deadline.toLocaleDateString()} — ${daysUntil(event.deadline)} days away.`
            : `The deadline was ${event.deadline.toLocaleDateString()}.`}
        </p>
      )}

      {event?.state === "revealed" && (
        <Link href="/reveal" className="btn-primary">
          See everyone&rsquo;s shirts
        </Link>
      )}
    </main>
  );
}

/** Safe to show everyone: who still needs to choose reveals no pairings. */
async function Outstanding({ eventId }: { eventId?: string }) {
  if (!eventId) return null;
  const waiting = await outstandingSelections(db, eventId);
  if (waiting.length === 0) return null;

  return (
    <p className="mt-3 text-sm text-ink/60">
      Still to pick a shirt: {waiting.map((p: { displayName: string }) => p.displayName).join(", ")}.
    </p>
  );
}
