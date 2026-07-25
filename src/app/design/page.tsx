import Link from "next/link";
import { db } from "@/db";
import { requireSession } from "@/lib/auth";
import { getMyAssignment } from "@/lib/event-service";
import { DESIGN_SCALE } from "@/lib/print";
import { Editor } from "./editor";

export default async function DesignPage() {
  const session = await requireSession();

  // No id in the URL: the assignment comes from the session, so there is
  // nothing to tamper with and no ownership check to get wrong.
  const mine = await getMyAssignment(db, session.participantId);

  if (!mine) {
    return (
      <main className="space-y-4">
        <h1 className="text-2xl font-semibold">Nothing to design yet</h1>
        <p className="text-ink/70">The draw hasn&rsquo;t happened, so you have no one to design for.</p>
        <Link href="/dashboard" className="btn-secondary">
          Back to dashboard
        </Link>
      </main>
    );
  }

  const { recipient, design } = mine;
  if (!recipient?.garment || !recipient?.colour) {
    return (
      <main className="space-y-4">
        <h1 className="text-2xl font-semibold">Waiting on a shirt choice</h1>
        <p className="text-ink/70">
          {recipient?.displayName} hasn&rsquo;t picked their shirt yet, so there&rsquo;s nothing to
          size a design against. The organizer has been told.
        </p>
        <Link href="/dashboard" className="btn-secondary">
          Back to dashboard
        </Link>
      </main>
    );
  }

  const printArea = { widthPx: recipient.garment.printWPx, heightPx: recipient.garment.printHPx };

  return (
    <Editor
      recipientName={recipient.displayName}
      garmentName={recipient.garment.displayName}
      colourName={recipient.colour.name}
      colourHex={recipient.colour.hex}
      isDark={recipient.colour.isDark}
      notes={recipient.notes}
      printArea={printArea}
      // Design space is exactly a quarter of print scale, so scaling up is a
      // clean multiply and the browser never holds a print-sized canvas.
      canvas={{
        width: Math.round(printArea.widthPx / DESIGN_SCALE),
        height: Math.round(printArea.heightPx / DESIGN_SCALE),
      }}
      initialCanvasJson={design?.canvasJson ?? null}
      status={design?.status ?? "draft"}
      aiEnabled={Boolean(process.env.OPENAI_API_KEY)}
    />
  );
}
