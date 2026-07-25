import { redirect } from "next/navigation";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { participants } from "@/db/schema";
import { requireSession } from "@/lib/auth";
import { loadCatalog } from "@/lib/garments";
import { GarmentPicker, type CatalogEntry } from "./picker";

export default async function JoinPage() {
  const session = await requireSession();
  const catalog = (await loadCatalog(db)) as CatalogEntry[];

  const [participant] = await db
    .select()
    .from(participants)
    .where(eq(participants.id, session.participantId));

  // Once the draw has run, a change would break work already in progress.
  if (participant?.garmentLockedAt) redirect("/dashboard");

  return (
    <main className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Pick your shirt</h1>
        <p className="mt-2 text-ink/70">
          Someone else will design this for you — you won&rsquo;t know who. Choose what you&rsquo;d
          actually wear; the colour you pick is the background they design against.
        </p>
      </div>

      <GarmentPicker
        catalog={catalog}
        initial={{
          garmentId: participant?.garmentId ?? undefined,
          colourId: participant?.garmentColourId ?? undefined,
          size: participant?.size ?? undefined,
          fit: participant?.fit ?? undefined,
          notes: participant?.notes ?? undefined,
        }}
      />
    </main>
  );
}
