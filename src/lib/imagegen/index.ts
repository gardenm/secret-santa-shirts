import type { PrintArea } from "../print";
import { removeBackground } from "./matte";
import { openAIProvider } from "./providers/openai";
import { buildPrintPrompt, type PromptContext } from "./prompt";
import { ImageGenError, type Aspect, type ImageProvider } from "./types";
import { coversPrintArea, upscaleToFit } from "./upscale";

export { ImageGenError } from "./types";
export type { Aspect, GeneratedImage, ImageProvider } from "./types";
export { flattenAlpha, blackToTransparent, removeBackground } from "./matte";
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

  // The person types a subject; what reaches the model is that subject wrapped
  // in print-appropriate direction. See prompt.ts for why.
  const prompt = options.promptContext
    ? buildPrintPrompt(subject, options.promptContext)
    : subject;

  const generated = await provider.generate(prompt, aspect);
  steps.push(`generate:${generated.model}`);

  let buffer = generated.buffer;

  // Skip the matting call when the model already produced real transparency -
  // gpt-image-1.5 can, gpt-image-2 cannot.
  if (!options.keepBackground && !generated.transparent) {
    buffer = await removeBackground(buffer);
    steps.push("matte:birefnet");
  }

  // Upscale to reach the full 300 DPI target. Model output is already above
  // the usability floor, so this is about hitting the ideal rather than
  // rescuing the file - see coversPrintArea.
  if (!coversPrintArea({ widthPx: generated.widthPx, heightPx: generated.heightPx }, options.printArea)) {
    buffer = await upscaleToFit(buffer, options.printArea);
    steps.push("upscale");
  }

  return {
    buffer,
    costCents: generated.costCents,
    model: generated.model,
    steps,
    prompt,
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
): Promise<{ buffer: Buffer; steps: string[] }> {
  const steps: string[] = [];
  let buffer = file;

  if (options.removeBg) {
    buffer = await removeBackground(buffer);
    steps.push("matte:birefnet");
  }

  const sharpModule = await import("sharp");
  const meta = await sharpModule.default(buffer).metadata();
  if (!meta.width || !meta.height) throw new ImageGenError("Could not read the uploaded image.");

  if (!coversPrintArea({ widthPx: meta.width, heightPx: meta.height }, options.printArea)) {
    buffer = await upscaleToFit(buffer, options.printArea);
    steps.push("upscale");
  }

  return { buffer, steps };
}
