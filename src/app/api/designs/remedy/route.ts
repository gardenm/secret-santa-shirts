import { NextResponse } from "next/server";
import { db } from "@/db";
import { requireSession } from "@/lib/auth";
import { allowanceFor, recordPaidCalls } from "@/lib/event-service";
import {
  blackToTransparent,
  createCallLog,
  flattenAlpha,
  removeBackground,
  upscaleToFit,
} from "@/lib/imagegen";
import { printAreaForDesigner } from "@/lib/submit";
import { assetUrl, getAsset, isValidAssetId, putAsset } from "@/lib/storage";

export const maxDuration = 120;

/**
 * Applies a preflight remedy to one image layer.
 *
 * Remedies act on the source asset rather than the flattened output, because
 * that is where the problems come from: soft alpha and low resolution belong
 * to raster layers, while brush strokes and text are vector and never produce
 * an underbase halo.
 *
 * Each returns a new asset id; the editor swaps the layer's src, re-renders
 * and re-runs preflight, so the person watches the fix land.
 */
export async function POST(request: Request) {
  let session;
  try {
    session = await requireSession();
  } catch {
    return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  }

  const body = (await request.json()) as { assetId?: string; remedy?: string };
  const assetId = (body.assetId ?? "").replace("/api/assets/", "");

  if (!isValidAssetId(assetId)) {
    return NextResponse.json({ error: "Unknown image." }, { status: 400 });
  }

  const printArea = await printAreaForDesigner(db, session.participantId);
  if (!printArea) {
    return NextResponse.json({ error: "You don't have an assignment yet." }, { status: 400 });
  }

  // Two of these four remedies call a paid model, and nothing used to count
  // them - "remove background" could be clicked all afternoon at about a cent
  // a time. The local fixes below stay free and uncapped.
  const paid = body.remedy === "upscale" || body.remedy === "remove-background";
  if (paid) {
    const allowance = await allowanceFor(db, session.participantId);
    if (allowance.assists <= 0) {
      return NextResponse.json(
        {
          error:
            `You've used up the automatic image fixes. "Harden soft edges" and "make black ` +
            `transparent" still work - they run here rather than costing anything.`,
        },
        { status: 429 },
      );
    }
  }

  try {
    const source = await getAsset(assetId);
    const log = createCallLog();
    let result: Buffer;

    switch (body.remedy) {
      case "upscale":
        result = await upscaleToFit(source, printArea, { forceHosted: false, log });
        break;
      case "remove-background":
        result = await removeBackground(source, log);
        break;
      case "flatten-alpha":
        // Snaps near-transparent pixels on or off, so a dark garment's white
        // underbase has nothing partial to sit under.
        result = await flattenAlpha(source);
        break;
      case "make-transparent":
        // Clears near-black so the shirt shows through: black ink over a white
        // underbase reads grey.
        result = await blackToTransparent(source);
        break;
      default:
        return NextResponse.json({ error: "Unknown fix." }, { status: 400 });
    }

    const stored = await putAsset(result);
    const sharpModule = await import("sharp");
    const meta = await sharpModule.default(result).metadata();

    // Whatever actually happened, which is not always what was asked for: an
    // upscale under 1.5x is resampled locally for free and records nothing.
    await recordPaidCalls(db, session.participantId, log.calls, {
      imageUrl: assetUrl(stored.id),
    });

    return NextResponse.json({
      url: assetUrl(stored.id),
      width: meta.width,
      height: meta.height,
      assistsLeft: (await allowanceFor(db, session.participantId)).assists,
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "That fix couldn't be applied." },
      { status: 400 },
    );
  }
}
