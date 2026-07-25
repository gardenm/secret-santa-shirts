/**
 * Print geometry.
 *
 * The one rule here: nothing downstream may hardcode a canvas or print size.
 * Print area varies by garment model, so every dimension is derived from the
 * recipient's chosen garment row.
 */

export const DPI = 300;

/**
 * The editor works at exactly 1/4 of print scale. Keeping it an integer divisor
 * means scaling to print is a clean multiply with no rounding or aspect drift,
 * and the browser never has to hold a print-resolution canvas.
 */
export const DESIGN_SCALE = 4;

/** Minimum acceptable effective resolution. Below this we block submission. */
export const MIN_DPI = 150;

/** Safe area inset, as a fraction of the print area, to keep art off the edges. */
export const SAFE_AREA_INSET = 0.04;

export type PrintArea = { widthPx: number; heightPx: number };

export function designSpace(area: PrintArea) {
  return {
    width: Math.round(area.widthPx / DESIGN_SCALE),
    height: Math.round(area.heightPx / DESIGN_SCALE),
  };
}

export function inches(area: PrintArea) {
  return {
    width: area.widthPx / DPI,
    height: area.heightPx / DPI,
  };
}

/** Human-readable print size, e.g. `11" x 14"`. */
export function formatInches(area: PrintArea): string {
  const { width, height } = inches(area);
  const fmt = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(1));
  return `${fmt(width)}" x ${fmt(height)}"`;
}

/**
 * Effective DPI if `sourcePx` is stretched to fill `targetPx` of print area.
 * This is what decides whether an uploaded image is usable at a given size.
 */
export function effectiveDpi(sourcePx: number, targetPx: number): number {
  if (targetPx <= 0) return 0;
  return (sourcePx / targetPx) * DPI;
}

/**
 * Largest print size, in inches, at which a source image still meets MIN_DPI.
 * Used to offer "place it smaller" as a concrete remedy rather than an error:
 * people can reason about inches, not pixels.
 */
export function maxUsableInches(sourceWPx: number, sourceHPx: number) {
  return {
    width: sourceWPx / MIN_DPI,
    height: sourceHPx / MIN_DPI,
  };
}

export function safeArea(area: PrintArea) {
  const insetX = Math.round(area.widthPx * SAFE_AREA_INSET);
  const insetY = Math.round(area.heightPx * SAFE_AREA_INSET);
  return {
    left: insetX,
    top: insetY,
    right: area.widthPx - insetX,
    bottom: area.heightPx - insetY,
  };
}
