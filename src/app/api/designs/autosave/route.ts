import { NextResponse } from "next/server";
import { db } from "@/db";
import { requireSession } from "@/lib/auth";
import { autosaveDesign } from "@/lib/submit";

export async function POST(request: Request) {
  let session;
  try {
    session = await requireSession();
  } catch {
    return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  }

  const body = (await request.json()) as { canvas?: unknown };
  if (!body.canvas) return NextResponse.json({ error: "Nothing to save." }, { status: 400 });

  try {
    await autosaveDesign(db, session.participantId, body.canvas);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Autosave failed." },
      { status: 400 },
    );
  }
}
