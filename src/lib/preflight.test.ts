import { describe, expect, it } from "vitest";
import sharp from "sharp";
import { preflight, type GarmentContext } from "./preflight";

const TEE: GarmentContext = {
  printArea: { widthPx: 3300, heightPx: 4200 },
  isDark: false,
  colourHex: "#FFFFFF",
  colourName: "White",
};

const BLACK_TEE: GarmentContext = { ...TEE, isDark: true, colourHex: "#111111", colourName: "Black" };

const HOODIE: GarmentContext = {
  ...TEE,
  printArea: { widthPx: 3000, heightPx: 3600 },
};

/** Solid rectangle of colour, fully opaque. */
async function opaque(w: number, h: number, colour = "#3355ff") {
  return sharp({
    create: { width: w, height: h, channels: 4, background: colour },
  })
    .png()
    .toBuffer();
}

/** A centred opaque shape on a transparent field. */
async function shape(w: number, h: number, colour = "#3355ff", inset = 0.25) {
  const iw = Math.round(w * (1 - inset * 2));
  const ih = Math.round(h * (1 - inset * 2));
  return sharp({
    create: { width: w, height: h, channels: 4, background: "#00000000" },
  })
    .composite([{ input: await opaque(iw, ih, colour), left: Math.round(w * inset), top: Math.round(h * inset) }])
    .png()
    .toBuffer();
}

/**
 * A shape with a wide feathered edge - the dark-garment failure case.
 *
 * Built small and then scaled up: blurring at full print resolution needs a
 * sigma in the hundreds and takes tens of seconds. Upscaling preserves the
 * soft alpha ramp, which is the only property the test cares about.
 */
async function feathered(w: number, h: number, colour = "#ff8844") {
  const sw = Math.round(w / 10);
  const sh = Math.round(h / 10);

  const inner = await sharp({
    create: { width: Math.round(sw * 0.5), height: Math.round(sh * 0.5), channels: 4, background: colour },
  })
    .png()
    .toBuffer();

  // Two stages on purpose: sharp applies blur *before* composite within a
  // single pipeline, so blurring inline would feather an empty layer and leave
  // the pasted shape hard-edged.
  const composited = await sharp({
    create: { width: sw, height: sh, channels: 4, background: "#00000000" },
  })
    .composite([{ input: inner, left: Math.round(sw * 0.25), top: Math.round(sh * 0.25) }])
    .png()
    .toBuffer();

  const small = await sharp(composited)
    .blur(Math.max(4, sw * 0.06)) // bleeds alpha into the partial band
    .png()
    .toBuffer();

  return sharp(small).resize(w, h).png().toBuffer();
}

describe("preflight: resolution", () => {
  it("blocks art that is too small for the print area and offers a remedy", async () => {
    const result = await preflight(await shape(800, 800), TEE);

    expect(result.ok).toBe(false);
    const finding = result.findings.find((f) => f.code === "resolution-too-low");
    expect(finding).toBeDefined();
    expect(finding!.remedy).toBe("upscale");
    // The remedy must be actionable: tell them the size it *is* good for.
    expect(finding!.message).toMatch(/stays sharp up to/);
  });

  it("accepts art at the full print resolution", async () => {
    const result = await preflight(await shape(3300, 4200), TEE);

    expect(result.findings.filter((f) => f.level === "error")).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.meta.effectiveDpi).toBe(300);
  });

  it("derives the threshold from the garment, not a hardcoded constant", async () => {
    // 3000x3600 exactly fills the hoodie but falls short of the tee. If the
    // threshold were a constant, one of these two assertions would fail.
    const art = await shape(3000, 3600);

    const onHoodie = await preflight(art, HOODIE);
    const onTee = await preflight(art, TEE);

    expect(onHoodie.meta.effectiveDpi).toBe(300);
    expect(onTee.meta.effectiveDpi).toBeLessThan(300);
  });
});

describe("preflight: transparency", () => {
  it("blocks a fully opaque image, which would print as a rectangle", async () => {
    const result = await preflight(await opaque(3300, 4200), TEE);

    expect(result.ok).toBe(false);
    const finding = result.findings.find((f) => f.code === "opaque-background");
    expect(finding?.remedy).toBe("remove-background");
  });
});

describe("preflight: dark-garment underbase rules", () => {
  it("warns about soft edges on a dark garment", async () => {
    const result = await preflight(await feathered(3300, 4200), BLACK_TEE);

    const finding = result.findings.find((f) => f.code === "soft-edges-on-dark");
    expect(finding).toBeDefined();
    expect(finding!.remedy).toBe("flatten-alpha");
    expect(finding!.message).toMatch(/underbase/);
  });

  it("does not raise underbase warnings on a light garment", async () => {
    // The same file is fine on white - which is exactly why these rules cannot
    // be global constants.
    const art = await feathered(3300, 4200);
    const result = await preflight(art, TEE);

    expect(result.findings.map((f) => f.code)).not.toContain("soft-edges-on-dark");
  });

  it("warns that near-black art prints grey over the underbase", async () => {
    const result = await preflight(await shape(3300, 4200, "#050505"), BLACK_TEE);

    const finding = result.findings.find((f) => f.code === "black-ink-on-dark");
    expect(finding?.remedy).toBe("make-transparent");
  });
});

describe("preflight: contrast", () => {
  it("warns when art is nearly the same tone as the shirt", async () => {
    const result = await preflight(await shape(3300, 4200, "#f4f4f4"), TEE);

    expect(result.findings.map((f) => f.code)).toContain("low-contrast");
  });

  it("stays quiet when art contrasts well with the shirt", async () => {
    const result = await preflight(await shape(3300, 4200, "#1133aa"), TEE);

    expect(result.findings.map((f) => f.code)).not.toContain("low-contrast");
  });
});
