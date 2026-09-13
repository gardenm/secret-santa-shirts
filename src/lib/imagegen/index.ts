import type { PrintArea } from "../print";
import { removeBackground } from "./matte";
import { createCallLog, type PaidCall } from "./meter";
import { openAIProvider } from "./providers/openai";
export { aiConfigured, resolveTarget } from "./providers/openai";
export type { ProviderTarget } from "./providers/openai";
import { buildPrintPrompt, type PromptContext } from "./prompt";
import { ImageGenError, type Aspect, type ImageProvider } from "./types";
import { coversPrintArea, upscaleToFit } from "./upscale";

export { ImageGenError, isAspect, ASPECTS } from "./types";
export type { Aspect, GeneratedImage, ImageProvider } from "./types";
export { flattenAlpha, blackToTransparent, removeBackground } from "./matte";
export { createCallLog, FAL_COSTS } from "./meter";
export type { CallLog, CollectedCalls, PaidCall } from "./meter";
export {
  buildPrintPrompt,
  isPrintStyle,
  STYLE_OPTIONS,
  PROMPT_PLACEHOLDER,
  PROMPT_HINT,
} from "./prompt";
export type { PrintStyle, PromptContext } from "./prompt";
export {
  coversPrintArea,
  isBelowMinimumDpi,
  effectiveDpiFor,
  upscaleToFit,
  upscaleFactorFor,
} from "./upscale";

/**
 * The generation pipeline.
 *
 *   generate -> matte -> upscale -> ready for the canvas
 *
 * Each stage is swappable, which is the point: transparency and resolution are
 * pipeline concerns rather than model capabilities, so the model can be chosen
 * on quality alone and replaced without touching the editor.
 */

export type PipelineResult = {
  buffer: Buffer;
  costCents: number;
  model: string;
  steps: string[];
  /** The expanded prompt actually sent, kept for the audit trail. */
  prompt: string;
  /**
   * Every call that cost money, including the matte and upscale the caller
   * cannot see. The route writes these to `generations`, which is what the
   * spend caps are counted from.
   */
  calls: PaidCall[];
};

export function defaultProvider(): ImageProvider {
  return openAIProvider();
}

export async function generateForPrint(
  subject: string,
  options: {
    printArea: PrintArea;
    aspect?: Aspect;
    provider?: ImageProvider;
    /** Skip matting when the design is meant to fill a rectangle deliberately. */
    keepBackground?: boolean;
    /**
     * The recipient's garment. Drives contrast and edge treatment in the
     * prompt: a design for a black shirt needs different guidance from one for
     * a white shirt, and both need the flat-ink framing that keeps output from
     * looking generic and printing badly.
     */
    promptContext?: PromptContext;
  },
): Promise<PipelineResult> {
  const provider = options.provider ?? defaultProvider();
  const aspect = options.aspect ?? "portrait";
  const steps: string[] = [];
  const log = createCallLog();

  // The person types a subject; what reaches the model is that subject wrapped
  // in print-appropriate direction. See prompt.ts for why.
  const prompt = options.promptContext
    ? buildPrintPrompt(subject, options.promptContext)
    : subject;

  const generated = await provider.generate(prompt, aspect);
  steps.push(`generate:${generated.model}`);
  log.record({
    provider: "openai",
    model: generated.model,
    costCents: generated.costCents,
    kind: "generate",
  });

  let buffer = generated.buffer;

  // Skip the matting call when the model already produced real transparency -
  // gpt-image-1.5 can, gpt-image-2 cannot.
  if (!options.keepBackground && !generated.transparent) {
    buffer = await removeBackground(buffer, log);
    steps.push("matte:birefnet");
  }

  // Upscale to reach the full 300 DPI target. Model output is already above
  // the usability floor, so this is about hitting the ideal rather than
  // rescuing the file - see coversPrintArea.
  if (!coversPrintArea({ widthPx: generated.widthPx, heightPx: generated.heightPx }, options.printArea)) {
    buffer = await upscaleToFit(buffer, options.printArea, { log });
    steps.push("upscale");
  }

  return {
    buffer,
    // The whole run, not just the generation - matting and upscaling are real
    // money too, and were previously invisible.
    costCents: log.calls.reduce((total, call) => total + call.costCents, 0),
    model: generated.model,
    steps,
    prompt,
    calls: log.calls,
  };
}

/**
 * Prepares an uploaded file for the canvas. Same pipeline, minus generation -
 * so a phone screenshot and a generated image reach the editor in the same
 * state, and preflight only has one shape of input to reason about.
 */
export async function prepareUpload(
  file: Buffer,
  options: { printArea: PrintArea; removeBg?: boolean },
): Promise<{ buffer: Buffer; steps: string[]; calls: PaidCall[] }> {
  const steps: string[] = [];
  const log = createCallLog();
  let buffer = file;

  if (options.removeBg) {
    buffer = await removeBackground(buffer, log);
    steps.push("matte:birefnet");
  }

  const sharpModule = await import("sharp");
  const meta = await sharpModule.default(buffer).metadata();
  if (!meta.width || !meta.height) throw new ImageGenError("Could not read the uploaded image.");

  if (!coversPrintArea({ widthPx: meta.width, heightPx: meta.height }, options.printArea)) {
    // Often a hosted call: a phone screenshot needs far more than 1.5x. This is
    // one of the paths that was spending money with nothing counting it.
    buffer = await upscaleToFit(buffer, options.printArea, { log });
    steps.push("upscale");
  }

  return { buffer, steps, calls: log.calls };
}
