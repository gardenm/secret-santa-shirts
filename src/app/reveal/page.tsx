import Link from "next/link";
import { db } from "@/db";
import { requireSession } from "@/lib/auth";
import { revealGallery } from "@/lib/event-service";
import { currentEvent } from "@/lib/invites";

export default async function RevealPage() {
  await requireSession();
  const event = await currentEvent(db);

  if (!event) {
    return (
      <main>
        <h1 className="text-2xl font-semibold">Nothing to reveal</h1>
      </main>
    );
  }

  // Gated in the query, not here: before the date, the shirts never leave the
  // server at all.
  const { revealed, revealAt, shirts } = await revealGallery(db, event.id);

  if (!revealed) {
    return (
      <main className="space-y-4">
        <h1 className="text-2xl font-semibold">Not yet</h1>
        <p className="text-ink/70">
          Everything stays hidden until {revealAt?.toLocaleDateString()}. No peeking — and no, the
          page isn&rsquo;t hiding them from you in the browser, they genuinely aren&rsquo;t sent.
        </p>
        <Link href="/dashboard" className="btn-secondary">
          Back to dashboard
        </Link>
      </main>
    );
  }

  return (
    <main className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold">{event.name}</h1>
        <p className="text-ink/70">
          {shirts.length} {shirts.length === 1 ? "shirt" : "shirts"}, and who made them.
        </p>
      </header>

      <div className="grid gap-6 sm:grid-cols-2">
        {shirts.map(
          (shirt: {
            recipientName: string;
            designerName: string;
            garmentName: string;
            colourName: string;
            colourHex: string;
            previewUrl: string | null;
          }) => (
            <figure key={shirt.recipientName} className="card space-y-3">
              {shirt.previewUrl && (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={shirt.previewUrl}
                  alt={`Shirt for ${shirt.recipientName}`}
                  className="w-full rounded-lg"
                  style={{ backgroundColor: shirt.colourHex }}
                />
              )}
              <figcaption>
                <p className="font-medium">{shirt.recipientName}</p>
                <p className="text-sm text-ink/60">
                  {shirt.colourName} {shirt.garmentName} — designed by {shirt.designerName}
                </p>
              </figcaption>
            </figure>
          ),
        )}
      </div>

      <Link href="/dashboard" className="btn-secondary">
        Back to dashboard
      </Link>
    </main>
  );
}
