import { describe, expect, it } from "vitest";
import sharp from "sharp";
import { renderDesign } from "./render";

const TEE = { widthPx: 3300, heightPx: 4200 };
const HOODIE = { widthPx: 3000, heightPx: 3600 };

/** Roughly what Fabric's toSVG() emits: a vector path over a transparent field. */
const svg = (w = 825, h = 1050) => `
<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
  <path d="M 100 200 Q 300 60 500 240 T 720 400" stroke="#ff5533" stroke-width="18"
        fill="none" stroke-linecap="round"/>
  <circle cx="400" cy="700" r="180" fill="#2244cc"/>
</svg>`;

describe("renderDesign", () => {
  it("rasterises to the garment's print dimensions", async () => {
    const png = await renderDesign(svg(), { printArea: TEE });
    const meta = await sharp(png).metadata();

    expect(meta.width).toBe(3300);
    expect(meta.height).toBe(4200);
  });

  it("uses the recipient's garment, not a fixed size", async () => {
    const onHoodie = await sharp(await renderDesign(svg(750, 900), { printArea: HOODIE })).metadata();

    expect(onHoodie.width).toBe(3000);
    expect(onHoodie.height).toBe(3600);
  });

  it("keeps the background transparent, so it does not print as a rectangle", async () => {
    const png = await renderDesign(svg(), { printArea: TEE });
    const meta = await sharp(png).metadata();
    expect(meta.hasAlpha).toBe(true);

    // Corners are outside the artwork and must be fully transparent.
    const { data } = await sharp(png)
      .extract({ left: 0, top: 0, width: 8, height: 8 })
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });

    for (let i = 3; i < data.length; i += 4) expect(data[i]).toBe(0);
  });

  it("scales vector strokes without softening them", async () => {
    // The point of rendering from SVG rather than upscaling a raster export:
    // a stroke authored at design scale is rasterised at print scale, so its
    // edges stay hard. A blurry edge would show up as a wide band of
    // partially transparent pixels.
    const png = await renderDesign(svg(), { printArea: TEE });
    const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });

    let partial = 0;
    let opaque = 0;
    for (let i = 3; i < data.length; i += 4) {
      if (data[i] >= 247) opaque++;
      else if (data[i] > 8) partial++;
    }

    expect(opaque).toBeGreaterThan(0);
    // Antialiasing only - well under the 6% that triggers a soft-edge warning.
    expect(partial / (info.width * info.height)).toBeLessThan(0.02);
  });
});
