import { NextResponse } from "next/server";
import { db } from "@/db";
import { requireAdmin } from "@/lib/auth";
import { collectExportEntries, zipEntries } from "@/lib/export";
import { currentEvent } from "@/lib/invites";

export const maxDuration = 300;

/**
 * The order bundle: print files, mockups, manifest, contact sheet.
 *
 * Refuses rather than exporting a print file that no longer matches its
 * recipient's garment - see collectExportEntries.
 */
export async function GET(request: Request) {
  try {
    await requireAdmin();
  } catch {
    return NextResponse.json({ error: "Organizers only." }, { status: 403 });
  }

  const event = await currentEvent(db);
  if (!event) return NextResponse.json({ error: "No exchange set up." }, { status: 400 });

  const blind = new URL(request.url).searchParams.get("blind") === "1";

  try {
    const { entries } = await collectExportEntries(db, event.id, { blind });
    const zip = await zipEntries(entries);

    const stamp = new Date().toISOString().slice(0, 10);
    const filename = `${event.name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${stamp}.zip`;

    return new NextResponse(new Uint8Array(zip), {
      headers: {
        "Content-Type": "application/zip",
        "Content-Disposition": `attachment; filename="${filename}"`,
      },
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Export failed." },
      { status: 400 },
    );
  }
}
