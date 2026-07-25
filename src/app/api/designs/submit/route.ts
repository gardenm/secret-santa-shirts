import { NextResponse } from "next/server";
import { db } from "@/db";
import { requireSession } from "@/lib/auth";
import { submitDesign } from "@/lib/submit";

export const maxDuration = 120;

/**
 * Renders and checks a design.
 *
 * There is no design id in the request: the assignment is resolved from the
 * session, so ownership is structural rather than something to validate.
 */
export async function POST(request: Request) {
  let session;
  try {
    session = await requireSession();
  } catch {
    return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  }

  const body = (await request.json()) as { svg?: string };
  if (!body.svg || !body.svg.includes("<svg")) {
    return NextResponse.json({ error: "That design couldn't be read." }, { status: 400 });
  }

  try {
    const result = await submitDesign(db, session.participantId, body.svg);
    return NextResponse.json(result);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Submission failed." },
      { status: 400 },
    );
  }
}
