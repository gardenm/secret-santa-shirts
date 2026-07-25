import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { generations } from "@/db/schema";
import { requireSession } from "@/lib/auth";
import { generationsRemaining } from "@/lib/event-service";
import { ImageGenError, generateForPrint, type Aspect } from "@/lib/imagegen";
import { printAreaForDesigner } from "@/lib/submit";
import { assetUrl, putAsset } from "@/lib/storage";

export const maxDuration = 120;

export async function POST(request: Request) {
  let session;
  try {
    session = await requireSession();
  } catch {
    return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  }

  if (!process.env.OPENAI_API_KEY) {
    // A clear message rather than a stack trace: the editor hides the panel,
    // but a stale tab could still get here.
    return NextResponse.json(
      { error: "AI image generation isn't configured for this exchange." },
      { status: 501 },
    );
  }

  const body = (await request.json()) as { prompt?: string; aspect?: Aspect };
  const prompt = (body.prompt ?? "").trim();
  if (prompt.length < 3) {
    return NextResponse.json({ error: "Describe what you'd like to make." }, { status: 400 });
  }

  const printArea = await printAreaForDesigner(db, session.participantId);
  if (!printArea) {
    return NextResponse.json({ error: "You don't have an assignment yet." }, { status: 400 });
  }

  // Counted server-side, so a refreshed page cannot reset the allowance.
  const remaining = await generationsRemaining(db, session.participantId);
  if (remaining <= 0) {
    return NextResponse.json(
      {
        error:
          `You've used all your image generations. You can still upload your own artwork, ` +
          `or draw one.`,
      },
      { status: 429 },
    );
  }

  try {
    const result = await generateForPrint(prompt, {
      printArea,
      aspect: body.aspect ?? "portrait",
    });

    const stored = await putAsset(result.buffer);

    await db.insert(generations).values({
      participantId: session.participantId,
      prompt,
      provider: "openai",
      model: result.model,
      imageUrl: assetUrl(stored.id),
      costCents: result.costCents,
    });

    return NextResponse.json({
      url: assetUrl(stored.id),
      steps: result.steps,
      remaining: remaining - 1,
    });
  } catch (error) {
    if (error instanceof ImageGenError && error.kind === "moderation") {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Generation failed." },
      { status: 502 },
    );
  }
}
