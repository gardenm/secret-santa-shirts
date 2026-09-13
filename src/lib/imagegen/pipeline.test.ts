import { describe, expect, it } from "vitest";
import sharp from "sharp";
import { blackToTransparent, flattenAlpha } from "./matte";
import {
  coversPrintArea,
  effectiveDpiFor,
  isBelowMinimumDpi,
  upscaleFactorFor,
  upscaleToFit,
} from "./upscale";
import { FAL_COSTS, createCallLog, generateForPrint, prepareUpload } from "./index";
import type { ImageProvider } from "./types";

const TEE = { widthPx: 3300, heightPx: 4200 };

/** What gpt-image-2 can actually produce for a 3:4 portrait. */
const GENERATED = { widthPx: 2480, heightPx: 3312 };

async function png(w: number, h: number, background = "#00000000") {
  return sharp({ create: { width: w, height: h, channels: 4, background } }).png().toBuffer();
}

describe("upscale planning", () => {
  it("recognises that no model output fills the print area natively", () => {
    // The premise of the pipeline: generated art never arrives at print size.
    expect(coversPrintArea(GENERATED, TEE)).toBe(false);
  });

  it("is nonetheless already above the usable quality floor", () => {
    // Worth stating explicitly: 2480px across 11" is ~225 DPI, well above the
    // 150 DPI floor. The upscale closes the gap to 300 DPI - it is not
    // rescuing an unprintable file, which is why the results hold up.
    expect(isBelowMinimumDpi(GENERATED, TEE)).toBe(false);
    expect(Math.round(effectiveDpiFor(GENERATED, TEE))).toBeGreaterThan(200);
  });

  it("keeps the required factor gentle", () => {
    // ~1.33x is the easy regime. If this ever climbs past ~2x the print area
    // is too large for the models available and should come down.
    const factor = upscaleFactorFor(GENERATED, TEE);
    expect(factor).toBeGreaterThan(1);
    expect(factor).toBeLessThan(1.5);
  });

  it("flags genuinely unusable art", () => {
    expect(isBelowMinimumDpi({ widthPx: 800, heightPx: 800 }, TEE)).toBe(true);
  });

  it("does not upscale art already at print size", () => {
    expect(coversPrintArea({ widthPx: 3300, heightPx: 4200 }, TEE)).toBe(true);
  });

  it("scales art up without cropping it", async () => {
    // Generated art is 3:4 while the tee print area is 11:14, so the two
    // aspect ratios differ slightly. Fitting inside preserves the whole image
    // - cropping someone's design to fill the area would be worse than
    // leaving a margin.
    const out = await upscaleToFit(await png(GENERATED.widthPx, GENERATED.heightPx, "#3355ff"), TEE);
    const meta = await sharp(out).metadata();

    expect(meta.height).toBe(4200);
    expect(meta.width).toBeLessThanOrEqual(3300);
    expect(meta.width).toBeGreaterThan(GENERATED.widthPx);
  });
});

describe("flattenAlpha", () => {
  it("removes the partial alpha that causes underbase halos", async () => {
    const soft = await sharp({ create: { width: 100, height: 100, channels: 4, background: "#ff884480" } })
      .png()
      .toBuffer();

    const flattened = await flattenAlpha(soft);
    const { data } = await sharp(flattened).ensureAlpha().raw().toBuffer({ resolveWithObject: true });

    for (let i = 3; i < data.length; i += 4) {
      expect([0, 255]).toContain(data[i]);
    }
  });
});

describe("blackToTransparent", () => {
  it("clears near-black pixels so the shirt shows through", async () => {
    const black = await sharp({ create: { width: 50, height: 50, channels: 4, background: "#050505" } })
      .png()
      .toBuffer();

    const out = await blackToTransparent(black);
    const { data } = await sharp(out).ensureAlpha().raw().toBuffer({ resolveWithObject: true });

    for (let i = 3; i < data.length; i += 4) expect(data[i]).toBe(0);
  });

  it("leaves coloured pixels alone", async () => {
    const blue = await sharp({ create: { width: 50, height: 50, channels: 4, background: "#3355ff" } })
      .png()
      .toBuffer();

    const out = await blackToTransparent(blue);
    const { data } = await sharp(out).ensureAlpha().raw().toBuffer({ resolveWithObject: true });

    for (let i = 3; i < data.length; i += 4) expect(data[i]).toBe(255);
  });
});

describe("generateForPrint", () => {
  /** Captures what the provider was actually asked for. */
  function recordingProvider(transparent = true) {
    const seen: string[] = [];
    const provider: ImageProvider = {
      name: "fake",
      model: "fake-model",
      async generate(prompt: string) {
        seen.push(prompt);
        return {
          buffer: await png(GENERATED.widthPx, GENERATED.heightPx, "#3355ff"),
          widthPx: GENERATED.widthPx,
          heightPx: GENERATED.heightPx,
          costCents: 7,
          model: "fake-model",
          transparent,
        };
      },
    };
    return { provider, seen };
  }

  it("sends the expanded print prompt, not the raw subject", async () => {
    const { provider, seen } = recordingProvider();

    const result = await generateForPrint("a badger on a bicycle", {
      printArea: TEE,
      provider,
      promptContext: { isDark: true, colourName: "Black", style: "linocut" },
    });

    // The whole prompt frame is worthless if it never reaches the model, and
    // that failure would be completely invisible from the outside.
    expect(seen).toHaveLength(1);
    expect(seen[0]).toContain("a badger on a bicycle");
    expect(seen[0]).toMatch(/linocut/i);
    expect(seen[0]).toMatch(/fully opaque ink/i);
    expect(seen[0]).toMatch(/no gradients/i);
    expect(result.prompt).toBe(seen[0]);
  });

  it("passes the subject through untouched when there is no garment context", async () => {
    const { provider, seen } = recordingProvider();

    await generateForPrint("a badger on a bicycle", { printArea: TEE, provider });

    expect(seen[0]).toBe("a badger on a bicycle");
  });

  it("varies the prompt with the recipient's shirt colour", async () => {
    const dark = recordingProvider();
    const light = recordingProvider();

    await generateForPrint("a fox", {
      printArea: TEE,
      provider: dark.provider,
      promptContext: { isDark: true, colourName: "Navy" },
    });
    await generateForPrint("a fox", {
      printArea: TEE,
      provider: light.provider,
      promptContext: { isDark: false, colourName: "White" },
    });

    expect(dark.seen[0]).not.toBe(light.seen[0]);
    expect(dark.seen[0]).toContain("navy");
    expect(light.seen[0]).toContain("white");
  });

  const fakeProvider = (transparent: boolean): ImageProvider => ({
    name: "fake",
    model: "fake-model",
    async generate() {
      return {
        buffer: await png(GENERATED.widthPx, GENERATED.heightPx, "#3355ff"),
        widthPx: GENERATED.widthPx,
        heightPx: GENERATED.heightPx,
        costCents: 7,
        model: "fake-model",
        transparent,
      };
    },
  });

  it("skips the matting call when the model produced real transparency", async () => {
    // No FAL_KEY is set in tests, so if matting were attempted this would throw.
    const result = await generateForPrint("a dinosaur", {
      printArea: TEE,
      provider: fakeProvider(true),
    });

    expect(result.steps).toContain("generate:fake-model");
    expect(result.steps).not.toContain("matte:birefnet");
    expect(result.steps).toContain("upscale");
  });

  it("upscales to the print area, since model output never reaches it", async () => {
    const result = await generateForPrint("a dinosaur", {
      printArea: TEE,
      provider: fakeProvider(true),
    });

    const meta = await sharp(result.buffer).metadata();
    expect(meta.height).toBe(TEE.heightPx);
  });
});

describe("metering paid calls", () => {
  const fakeProvider: ImageProvider = {
    name: "fake",
    model: "fake-model",
    async generate() {
      return {
        buffer: await png(GENERATED.widthPx, GENERATED.heightPx, "#3355ff"),
        widthPx: GENERATED.widthPx,
        heightPx: GENERATED.heightPx,
        costCents: 7,
        model: "fake-model",
        transparent: true,
      };
    },
  };

  it("reports the generation as a paid call", async () => {
    const result = await generateForPrint("a dinosaur", { printArea: TEE, provider: fakeProvider });

    expect(result.calls).toEqual([
      { provider: "openai", model: "fake-model", costCents: 7, kind: "generate" },
    ]);
  });

  it("does not charge for an upscale that ran locally", async () => {
    // 2480x3312 -> 3300x4200 is 1.33x, under the hosted threshold, so it is
    // resampled here for free. The caller cannot know that from outside, which
    // is the whole reason the pipeline reports its own calls rather than
    // having each route guess.
    const result = await generateForPrint("a dinosaur", { printArea: TEE, provider: fakeProvider });

    expect(result.steps).toContain("upscale");
    expect(result.calls.filter((c) => c.provider === "fal")).toEqual([]);
    expect(result.costCents).toBe(7);
  });

  it("does not charge for a hosted upscale that failed and fell back", async () => {
    // A 400x500 upload needs far more than 1.5x, so it takes the hosted path.
    // With no FAL_KEY that call fails and a local resize covers for it - and
    // the person is charged nothing, because nothing was billed. Recording the
    // call at the point of *attempting* it would get this backwards.
    const { calls, steps } = await prepareUpload(await png(400, 500, "#3355ff"), {
      printArea: TEE,
    });

    expect(steps).toContain("upscale");
    expect(calls).toEqual([]);
  });

  it("totals the cost across every call in a run", () => {
    const log = createCallLog();
    log.record({ provider: "openai", model: "gpt-image-2", costCents: 7, kind: "generate" });
    log.record({ provider: "fal", model: "birefnet", costCents: FAL_COSTS.birefnet, kind: "assist" });
    log.record({ provider: "fal", model: "esrgan", costCents: FAL_COSTS.esrgan, kind: "assist" });

    // The number that used to be reported was the generation alone. Matting
    // and upscaling are real money, and were invisible.
    expect(log.calls.reduce((t, c) => t + c.costCents, 0)).toBe(7 + FAL_COSTS.birefnet + FAL_COSTS.esrgan);
    expect(log.calls.filter((c) => c.kind === "assist")).toHaveLength(2);
  });
});
