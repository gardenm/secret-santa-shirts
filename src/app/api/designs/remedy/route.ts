import { NextResponse } from "next/server";
import { db } from "@/db";
import { requireSession } from "@/lib/auth";
import { blackToTransparent, flattenAlpha, removeBackground, upscaleToFit } from "@/lib/imagegen";
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

  try {
    const source = await getAsset(assetId);
    let result: Buffer;

    switch (body.remedy) {
      case "upscale":
        result = await upscaleToFit(source, printArea, { forceHosted: false });
        break;
      case "remove-background":
        result = await removeBackground(source);
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

    return NextResponse.json({
      url: assetUrl(stored.id),
      width: meta.width,
      height: meta.height,
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "That fix couldn't be applied." },
      { status: 400 },
    );
  }
}
