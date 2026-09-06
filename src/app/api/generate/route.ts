import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { generations } from "@/db/schema";
import { requireSession } from "@/lib/auth";
import { generationsRemaining } from "@/lib/event-service";
import {
  ImageGenError,
  generateForPrint,
  isPrintStyle,
  type Aspect,
  type PrintStyle,
} from "@/lib/imagegen";
import { generationContextFor } from "@/lib/submit";
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

  const body = (await request.json()) as {
    prompt?: string;
    aspect?: Aspect;
    style?: unknown;
  };
  const subject = (body.prompt ?? "").trim();
  if (subject.length < 3) {
    return NextResponse.json({ error: "Describe what you'd like to make." }, { status: 400 });
  }

  // Validated rather than trusted: an unknown style would otherwise be
  // interpolated straight into the prompt.
  const style: PrintStyle = isPrintStyle(body.style) ? body.style : "screenprint";

  const context = await generationContextFor(db, session.participantId);
  if (!context) {
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
    const result = await generateForPrint(subject, {
      printArea: context.printArea,
      aspect: body.aspect ?? "portrait",
      // The recipient's shirt colour shapes the prompt: bright opaque ink for
      // a dark garment, deep colour and dark outlines for a light one.
      promptContext: {
        isDark: context.isDark,
        colourName: context.colourName,
        style,
      },
    });

    const stored = await putAsset(result.buffer);

    await db.insert(generations).values({
      participantId: session.participantId,
      // The person's own words, not the expanded prompt - this is the audit
      // trail, and their subject is what is worth reading back.
      prompt: subject,
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
