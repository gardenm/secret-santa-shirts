import sharp from "sharp";
import { MIN_DPI, effectiveDpi, formatInches, maxUsableInches, type PrintArea } from "./print";

/**
 * Print-readiness checks.
 *
 * Two principles here:
 *
 * 1. Every check is derived from the recipient's garment, never a constant.
 *    Print area varies by model, and the dark-garment rules only apply to dark
 *    garments.
 * 2. Every finding carries a remedy. A bare "your image is too small" leaves
 *    someone stuck who does not know what to do next, and they then ask the
 *    organizer - which is exactly the outcome this app exists to avoid.
 */

export type Remedy =
  | "upscale"
  | "place-smaller"
  | "remove-background"
  | "fit-to-safe-area"
  | "flatten-alpha"
  | "make-transparent"
  | "adjust-contrast";

export type Finding = {
  level: "error" | "warning";
  code: string;
  message: string;
  remedy?: Remedy;
};

export type PreflightResult = {
  ok: boolean;
  findings: Finding[];
  meta: {
    widthPx: number;
    heightPx: number;
    hasAlpha: boolean;
    effectiveDpi: number;
    partialAlphaRatio: number;
    coverageRatio: number;
  };
};

export type GarmentContext = {
  printArea: PrintArea;
  isDark: boolean;
  colourHex: string;
  colourName: string;
};

/** Alpha values in this band are neither on nor off - the underbase problem. */
const PARTIAL_ALPHA_LOW = 8;
const PARTIAL_ALPHA_HIGH = 247;

/** Above this fraction of soft-edged pixels, a dark garment will show a halo. */
const PARTIAL_ALPHA_WARN_RATIO = 0.06;

/** Above this fraction of inked area, DTG output feels stiff and plasticky. */
const HEAVY_COVERAGE_RATIO = 0.85;

const MAX_FILE_BYTES = 40 * 1024 * 1024;

export async function preflight(
  file: Buffer,
  garment: GarmentContext,
): Promise<PreflightResult> {
  const findings: Finding[] = [];
  const image = sharp(file, { limitInputPixels: 512 * 1024 * 1024 });
  const metadata = await image.metadata();

  const widthPx = metadata.width ?? 0;
  const heightPx = metadata.height ?? 0;
  const hasAlpha = Boolean(metadata.hasAlpha);

  // --- Size ---------------------------------------------------------------
  // Compare against the garment's own print area, not a fixed number.
  const dpi = Math.min(
    effectiveDpi(widthPx, garment.printArea.widthPx),
    effectiveDpi(heightPx, garment.printArea.heightPx),
  );

  if (dpi < MIN_DPI) {
    const usable = maxUsableInches(widthPx, heightPx);
    findings.push({
      level: "error",
      code: "resolution-too-low",
      message:
        `This artwork is ${widthPx}x${heightPx}px, which is only ${Math.round(dpi)} DPI ` +
        `across a ${formatInches(garment.printArea)} print. It needs at least ${MIN_DPI} DPI. ` +
        `You can upscale it, or print it smaller - at this resolution it stays sharp up to ` +
        `${usable.width.toFixed(1)}" x ${usable.height.toFixed(1)}".`,
      remedy: "upscale",
    });
  }

  if (file.byteLength > MAX_FILE_BYTES) {
    findings.push({
      level: "error",
      code: "file-too-large",
      message: `The file is ${(file.byteLength / 1024 / 1024).toFixed(1)} MB; the limit is 40 MB.`,
    });
  }

  if (metadata.space && metadata.space !== "srgb") {
    findings.push({
      level: "error",
      code: "wrong-colour-space",
      message:
        `The file is in ${metadata.space}. DTG printers expect 8-bit RGB - CMYK files ` +
        `shift colour unpredictably.`,
    });
  }

  // --- Alpha --------------------------------------------------------------
  // DTG prints exactly what is in the file: an opaque background becomes a
  // printed rectangle of that colour on the shirt.
  if (!hasAlpha) {
    findings.push({
      level: "error",
      code: "no-alpha",
      message:
        "This file has no transparency. The background would print as a solid rectangle on the " +
        "shirt rather than letting the fabric show through.",
      remedy: "remove-background",
    });
  }

  const stats = await analysePixels(file);

  if (hasAlpha && stats.opaqueRatio > 0.995) {
    findings.push({
      level: "error",
      code: "opaque-background",
      message:
        "Every pixel in this file is opaque, so it would print as a full rectangle on the shirt.",
      remedy: "remove-background",
    });
  }

  // --- Dark-garment (white underbase) rules -------------------------------
  // On a dark garment the printer lays a solid white underbase first. A pixel
  // at 30% opacity still gets a 100% solid white dot beneath it, so soft edges
  // print as a chalky halo rather than fading out.
  if (garment.isDark) {
    if (stats.partialAlphaRatio > PARTIAL_ALPHA_WARN_RATIO) {
      findings.push({
        level: "warning",
        code: "soft-edges-on-dark",
        message:
          `About ${(stats.partialAlphaRatio * 100).toFixed(0)}% of this design uses soft or ` +
          `semi-transparent edges (glows, drop shadows, faded gradients). On ${garment.colourName} ` +
          `the printer lays a solid white underbase under every one of those pixels, so they will ` +
          `print as a chalky white halo instead of fading out.`,
        remedy: "flatten-alpha",
      });
    }

    if (stats.nearBlackRatio > 0.1) {
      findings.push({
        level: "warning",
        code: "black-ink-on-dark",
        message:
          `Roughly ${(stats.nearBlackRatio * 100).toFixed(0)}% of this design is near-black. ` +
          `Printed over a white underbase on ${garment.colourName}, black ink comes out grey. ` +
          `Leaving those areas fully transparent lets the shirt itself show through - a truer black.`,
        remedy: "make-transparent",
      });
    }

    if (stats.coverageRatio > HEAVY_COVERAGE_RATIO) {
      findings.push({
        level: "warning",
        code: "heavy-coverage",
        message:
          "This design covers nearly the whole print area. On a dark garment that means a full " +
          "sheet of underbase, which prints thick and stiff.",
      });
    }
  }

  // --- Contrast against the garment ---------------------------------------
  const garmentLuma = luminance(hexToRgb(garment.colourHex));
  const artLuma = stats.meanLuminance;
  if (stats.coverageRatio > 0.01 && Math.abs(artLuma - garmentLuma) < 0.18) {
    findings.push({
      level: "warning",
      code: "low-contrast",
      message:
        `This design is very close in tone to ${garment.colourName}, so it may be hard to see ` +
        `on the finished shirt. An outline or a shift in brightness would help.`,
      remedy: "adjust-contrast",
    });
  }

  return {
    ok: !findings.some((f) => f.level === "error"),
    findings,
    meta: {
      widthPx,
      heightPx,
      hasAlpha,
      effectiveDpi: Math.round(dpi),
      partialAlphaRatio: stats.partialAlphaRatio,
      coverageRatio: stats.coverageRatio,
    },
  };
}

type PixelStats = {
  opaqueRatio: number;
  partialAlphaRatio: number;
  coverageRatio: number;
  nearBlackRatio: number;
  meanLuminance: number;
};

/**
 * Samples the image at reduced size. Exact per-pixel counts are not needed -
 * these drive human-facing warnings, and downsampling keeps a 3300x4200 file
 * from costing hundreds of megabytes to inspect.
 */
async function analysePixels(file: Buffer): Promise<PixelStats> {
  const { data, info } = await sharp(file)
    .resize(400, 400, { fit: "inside", withoutEnlargement: true })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const total = info.width * info.height;
  let opaque = 0;
  let partial = 0;
  let inked = 0;
  let nearBlack = 0;
  let lumaSum = 0;

  for (let i = 0; i < data.length; i += 4) {
    const [r, g, b, a] = [data[i], data[i + 1], data[i + 2], data[i + 3]];

    if (a >= PARTIAL_ALPHA_HIGH) opaque++;
    else if (a > PARTIAL_ALPHA_LOW) partial++;

    if (a > PARTIAL_ALPHA_LOW) {
      inked++;
      const l = luminance({ r, g, b });
      lumaSum += l;
      if (l < 0.12) nearBlack++;
    }
  }

  return {
    opaqueRatio: opaque / total,
    partialAlphaRatio: partial / total,
    coverageRatio: inked / total,
    nearBlackRatio: inked > 0 ? nearBlack / inked : 0,
    meanLuminance: inked > 0 ? lumaSum / inked : 0,
  };
}

function hexToRgb(hex: string) {
  const clean = hex.replace("#", "");
  return {
    r: parseInt(clean.slice(0, 2), 16),
    g: parseInt(clean.slice(2, 4), 16),
    b: parseInt(clean.slice(4, 6), 16),
  };
}

/** Relative luminance, sRGB weighted. */
function luminance({ r, g, b }: { r: number; g: number; b: number }): number {
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}
