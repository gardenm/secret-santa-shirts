import { Resvg, type ResvgRenderOptions } from "@resvg/resvg-js";
import { existsSync } from "node:fs";
import path from "node:path";
import type { PrintArea } from "./print";

/**
 * Renders a design to a print-ready PNG, server-side.
 *
 * The client sends `canvas.toSVG()` rather than a rasterised export. Three
 * reasons this is worth the round trip:
 *
 * 1. The browser never allocates a print-resolution canvas. A 3300x4200 RGBA
 *    buffer is ~55 MB, which mobile Safari will refuse - and a good share of
 *    people will design on a phone.
 * 2. Output is deterministic. No per-browser font substitution or antialiasing
 *    differences between the design someone approved and the file that prints.
 * 3. The print file can be re-rendered at any size later from stored state, so
 *    a vendor with different dimensions is a re-render rather than twelve
 *    people redrawing.
 *
 * Vector content - brush strokes, text - is rasterised at the target
 * resolution, so it stays crisp no matter how far it is scaled.
 */

/**
 * Fonts are supplied as directory paths. resvg-js takes `fontDirs`/`fontFiles`
 * and NOT font buffers - and passing an unrecognised key makes it silently
 * discard the whole options object, `fitTo` included, so a design renders at
 * design scale instead of print scale with no error raised. Hence the
 * dimension assertion at the end of renderDesign.
 */
const FONT_DIR = path.join(process.cwd(), "public", "fonts");

function fontOptions(): ResvgRenderOptions["font"] {
  return {
    // System fonts are off so output cannot vary with the host image. A font
    // that silently substitutes produces a wrong shirt rather than an error.
    loadSystemFonts: false,
    fontDirs: existsSync(FONT_DIR) ? [FONT_DIR] : [],
    defaultFontFamily: "Inter",
  };
}

export type RenderOptions = {
  /** Target print area, taken from the recipient's garment row. */
  printArea: PrintArea;
  /**
   * Background colour, for preview renders only. Print files must stay
   * transparent: DTG prints whatever is in the file, so a background colour
   * becomes a printed rectangle on the shirt.
   */
  background?: string;
};

export async function renderDesign(svg: string, options: RenderOptions): Promise<Buffer> {
  const resvg = new Resvg(svg, {
    fitTo: { mode: "width", value: options.printArea.widthPx },
    ...(options.background ? { background: options.background } : {}),
    font: fontOptions(),
    logLevel: "error",
  });

  const rendered = resvg.render();

  // Guard against the silent-options failure described above. Getting this
  // wrong means shipping a blurry shirt, and it would otherwise be invisible
  // until the parcel arrives.
  if (rendered.width !== options.printArea.widthPx) {
    throw new Error(
      `Render produced ${rendered.width}x${rendered.height}, expected width ` +
        `${options.printArea.widthPx}. resvg silently ignores its whole options ` +
        `object when given an unknown key - check the options passed here.`,
    );
  }

  return rendered.asPng();
}

/**
 * Preview render for the dashboard and reveal gallery - small, and composited
 * over the garment colour so it reads as a shirt rather than as floating art.
 */
export async function renderPreview(
  svg: string,
  options: RenderOptions & { widthPx?: number },
): Promise<Buffer> {
  const resvg = new Resvg(svg, {
    fitTo: { mode: "width", value: options.widthPx ?? 600 },
    ...(options.background ? { background: options.background } : {}),
    font: fontOptions(),
    logLevel: "error",
  });
  return resvg.render().asPng();
}
