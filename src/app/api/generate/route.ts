import { NextResponse } from "next/server";
import { db } from "@/db";
import { requireSession } from "@/lib/auth";
import { allowanceFor, recordPaidCalls } from "@/lib/event-service";
import {
  ImageGenError,
  aiConfigured,
  generateForPrint,
  isAspect,
  isPrintStyle,
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

  if (!aiConfigured()) {
    // A clear message rather than a stack trace: the editor hides the panel,
    // but a stale tab could still get here.
    return NextResponse.json(
      { error: "AI image generation isn't configured for this exchange." },
      { status: 501 },
    );
  }

  const body = (await request.json()) as {
    prompt?: string;
    aspect?: unknown;
    style?: unknown;
  };
  const subject = (body.prompt ?? "").trim();
  if (subject.length < 3) {
    return NextResponse.json({ error: "Describe what you'd like to make." }, { status: 400 });
  }

  // Validated rather than trusted: an unknown style would otherwise be
  // interpolated straight into the prompt, and an unknown aspect would index
  // the provider's size table with nothing there and throw on `.width`.
  const style: PrintStyle = isPrintStyle(body.style) ? body.style : "screenprint";
  const aspect = isAspect(body.aspect) ? body.aspect : "portrait";

  const context = await generationContextFor(db, session.participantId);
  if (!context) {
    return NextResponse.json({ error: "You don't have an assignment yet." }, { status: 400 });
  }

  // Counted server-side, so a refreshed page cannot reset the allowance.
  const allowance = await allowanceFor(db, session.participantId);
  const remaining = allowance.generations;
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
      aspect,
      // The recipient's shirt colour shapes the prompt: bright opaque ink for
      // a dark garment, deep colour and dark outlines for a light one.
      promptContext: {
        isDark: context.isDark,
        colourName: context.colourName,
        style,
      },
    });

    const stored = await putAsset(result.buffer);

    // Every paid call the pipeline made, not just the generation: it also
    // mattes and upscales, and both of those are billed.
    await recordPaidCalls(db, session.participantId, result.calls, {
      prompt: subject,
      imageUrl: assetUrl(stored.id),
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
