import { NextResponse } from "next/server";
import { db } from "@/db";
import { requireSession } from "@/lib/auth";
import { prepareUpload } from "@/lib/imagegen";
import { printAreaForDesigner } from "@/lib/submit";
import { assetUrl, putAsset } from "@/lib/storage";

export const maxDuration = 60;

const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

/**
 * Uploads an image and prepares it for print.
 *
 * Uploads go through the same pipeline as generated images - optional
 * background removal, upscale to the print area - so a phone screenshot and an
 * AI image reach the canvas in the same state, and preflight only has one
 * shape of input to reason about.
 */
export async function POST(request: Request) {
  let session;
  try {
    session = await requireSession();
  } catch {
    return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  }

  const printArea = await printAreaForDesigner(db, session.participantId);
  if (!printArea) {
    return NextResponse.json(
      { error: "You don't have an assignment yet." },
      { status: 400 },
    );
  }

  const form = await request.formData();
  const file = form.get("file");
  if (!(file instanceof File)) {
    return NextResponse.json({ error: "No file was uploaded." }, { status: 400 });
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    return NextResponse.json(
      { error: `That file is ${(file.size / 1024 / 1024).toFixed(1)} MB; the limit is 25 MB.` },
      { status: 400 },
    );
  }

  const removeBg = form.get("removeBackground") === "true";

  try {
    const { buffer, steps } = await prepareUpload(Buffer.from(await file.arrayBuffer()), {
      printArea,
      removeBg,
    });

    const sharpModule = await import("sharp");
    const meta = await sharpModule.default(buffer).metadata();
    const stored = await putAsset(buffer);

    return NextResponse.json({
      url: assetUrl(stored.id),
      width: meta.width,
      height: meta.height,
      steps,
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "That image could not be processed." },
      { status: 400 },
    );
  }
}
