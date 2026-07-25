import sharp from "sharp";
import type { PrintArea } from "../print";
import { MIN_DPI, effectiveDpi } from "../print";
import { ImageGenError } from "./types";

/**
 * Upscaling to print resolution.
 *
 * No current image model fills a 3300x4200 print area natively, so this step
 * runs on every generated image. The saving grace is that the gap is small:
 * 2480x3312 -> 3300x4200 is about 1.33x, which is the easy regime for any
 * upscaler, quite unlike the 4x stretch from 1024px that gives AI art on
 * fabric its reputation for looking mushy.
 *
 * Choosing an 11"x14" print area rather than the 12"x16" maximum is what keeps
 * the factor that low.
 */

const FAL_ENDPOINT = "https://fal.run/fal-ai/esrgan";

/** Beyond this factor, a hosted model is worth the call; below it, Lanczos is fine. */
const HOSTED_UPSCALE_THRESHOLD = 1.5;

export function upscaleFactorFor(
  source: { widthPx: number; heightPx: number },
  target: PrintArea,
): number {
  return Math.max(target.widthPx / source.widthPx, target.heightPx / source.heightPx);
}

/**
 * Below the quality floor - the file is not usable at this print size at all,
 * and preflight blocks submission. Distinct from `coversPrintArea` below:
 * these answer different questions and conflating them silently skips the
 * upscale step.
 */
export function isBelowMinimumDpi(
  source: { widthPx: number; heightPx: number },
  target: PrintArea,
): boolean {
  return effectiveDpiFor(source, target) < MIN_DPI;
}

/**
 * True when the image already has enough pixels to fill the print area at the
 * full 300 DPI target.
 *
 * Worth being precise about what upscaling buys here: gpt-image-2's 2480x3312
 * across an 11"x14" print is ~225 DPI, which is comfortably above the 150 DPI
 * floor and genuinely printable as-is. The upscale closes the gap to 300 DPI;
 * it is not rescuing an unusable file. That is why the factor stays gentle and
 * the results hold up.
 */
export function coversPrintArea(
  source: { widthPx: number; heightPx: number },
  target: PrintArea,
): boolean {
  return source.widthPx >= target.widthPx && source.heightPx >= target.heightPx;
}

export function effectiveDpiFor(
  source: { widthPx: number; heightPx: number },
  target: PrintArea,
): number {
  return Math.min(
    effectiveDpi(source.widthPx, target.widthPx),
    effectiveDpi(source.heightPx, target.heightPx),
  );
}

/**
 * Scales an image up to cover the print area.
 *
 * Small factors go through Lanczos locally, which is free, instant, and
 * visually indistinguishable at 1.33x. Larger factors - an upload from a phone
 * screenshot, say - go to a hosted model, where the extra detail is worth the
 * round trip.
 */
export async function upscaleToFit(
  image: Buffer,
  target: PrintArea,
  options: { forceHosted?: boolean } = {},
): Promise<Buffer> {
  const meta = await sharp(image).metadata();
  const source = { widthPx: meta.width ?? 0, heightPx: meta.height ?? 0 };
  if (!source.widthPx || !source.heightPx) {
    throw new ImageGenError("Could not read image dimensions.");
  }

  const factor = upscaleFactorFor(source, target);
  if (factor <= 1) return image;

  if (options.forceHosted || factor > HOSTED_UPSCALE_THRESHOLD) {
    try {
      return await hostedUpscale(image, factor, target);
    } catch {
      // A soft upscale beats a failed submission on deadline day.
      return localUpscale(image, target);
    }
  }

  return localUpscale(image, target);
}

function localUpscale(image: Buffer, target: PrintArea): Promise<Buffer> {
  return sharp(image)
    .resize(target.widthPx, target.heightPx, {
      fit: "inside",
      kernel: "lanczos3",
      withoutEnlargement: false,
    })
    .png()
    .toBuffer();
}

async function hostedUpscale(image: Buffer, factor: number, target: PrintArea): Promise<Buffer> {
  const key = process.env.FAL_KEY;
  if (!key) throw new ImageGenError("FAL_KEY is not set.", "config");

  const response = await fetch(FAL_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Key ${key}` },
    body: JSON.stringify({
      image_url: `data:image/png;base64,${image.toString("base64")}`,
      scale: Math.min(4, Math.ceil(factor)),
    }),
  });

  if (!response.ok) throw new ImageGenError(`Upscale failed (${response.status}).`);

  const json = (await response.json()) as { image?: { url?: string } };
  if (!json.image?.url) throw new ImageGenError("Upscale returned no image.");

  const fetched = await fetch(json.image.url);
  const upscaled = Buffer.from(await fetched.arrayBuffer());

  // Hosted upscalers work in integer steps, so trim to the exact print area.
  return localUpscale(upscaled, target);
}
