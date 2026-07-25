import sharp from "sharp";
import { ImageGenError } from "./types";

/**
 * Background removal.
 *
 * Transparency is a pipeline step, not a model capability. Decoupling it means
 * the generation model can be chosen purely on quality rather than on whether
 * it happens to support a transparent background - and it makes uploads from
 * ChatGPT or a phone camera usable too.
 *
 * T-shirt art is close to the easiest case for a matting model: sticker-like
 * subjects on flat or simple backgrounds.
 */

const FAL_ENDPOINT = "https://fal.run/fal-ai/birefnet/v2";

export async function removeBackground(image: Buffer): Promise<Buffer> {
  const key = process.env.FAL_KEY;
  if (!key) throw new ImageGenError("FAL_KEY is not set.", "config");

  const dataUri = `data:image/png;base64,${image.toString("base64")}`;

  const response = await fetch(FAL_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Key ${key}`,
    },
    body: JSON.stringify({ image_url: dataUri, output_format: "png" }),
  });

  if (!response.ok) {
    throw new ImageGenError(
      `Background removal failed (${response.status}): ${await response.text()}`,
    );
  }

  const json = (await response.json()) as { image?: { url?: string } };
  const url = json.image?.url;
  if (!url) throw new ImageGenError("Background removal returned no image.");

  const imageResponse = await fetch(url);
  if (!imageResponse.ok) {
    throw new ImageGenError(`Could not fetch matted image (${imageResponse.status}).`);
  }

  return Buffer.from(await imageResponse.arrayBuffer());
}

/**
 * Snaps near-transparent pixels fully on or off.
 *
 * This is the remedy for the dark-garment underbase problem: a pixel at 30%
 * opacity still receives a solid white underbase dot, so soft edges print as a
 * chalky halo. Hard alpha prints clean.
 *
 * Runs locally - no API call, no cost - so it is cheap to offer as a one-click
 * fix in the editor.
 */
export async function flattenAlpha(image: Buffer, threshold = 128): Promise<Buffer> {
  const { data, info } = await sharp(image)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  for (let i = 3; i < data.length; i += 4) {
    data[i] = data[i] >= threshold ? 255 : 0;
  }

  return sharp(data, {
    raw: { width: info.width, height: info.height, channels: 4 },
  })
    .png()
    .toBuffer();
}

/**
 * Makes near-black pixels fully transparent.
 *
 * On a dark garment, black ink printed over a white underbase comes out grey.
 * Letting the shirt itself show through gives a truer black than any ink can.
 */
export async function blackToTransparent(image: Buffer, cutoff = 30): Promise<Buffer> {
  const { data, info } = await sharp(image)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  for (let i = 0; i < data.length; i += 4) {
    if (data[i] <= cutoff && data[i + 1] <= cutoff && data[i + 2] <= cutoff) {
      data[i + 3] = 0;
    }
  }

  return sharp(data, {
    raw: { width: info.width, height: info.height, channels: 4 },
  })
    .png()
    .toBuffer();
}
