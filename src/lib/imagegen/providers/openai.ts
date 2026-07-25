import { ImageGenError, type Aspect, type GeneratedImage, type ImageProvider } from "../types";

/**
 * OpenAI image generation.
 *
 * Model notes, because the choice here is less obvious than it looks:
 *
 * - `gpt-image-2` is the quality default. It allows arbitrary sizes but caps
 *   total output at 8.29M pixels with sides in multiples of 16, which works
 *   out to roughly 2480x3312 for a 3:4 portrait - about 8.3" x 11" at 300 DPI.
 *   It does NOT support transparent backgrounds; the pipeline mattes instead.
 * - `gpt-image-1.5` does support `background: "transparent"`, which lets the
 *   matting step be skipped when its output is clean.
 * - `gpt-image-1` deprecates 2026-10-23. Do not pin to it.
 *
 * No model reaches the full print area natively, so an upscale step runs
 * regardless - which is why transparency and resolution are both handled as
 * pipeline concerns and the model is chosen on quality alone.
 */

const ENDPOINT = "https://api.openai.com/v1/images/generations";

/** Largest 3:4 portrait within gpt-image-2's 8.29M pixel budget, sides /16. */
const SIZES: Record<Aspect, { width: number; height: number }> = {
  portrait: { width: 2480, height: 3312 },
  square: { width: 2864, height: 2864 },
  landscape: { width: 3312, height: 2480 },
};

export type OpenAIProviderOptions = {
  model?: "gpt-image-2" | "gpt-image-1.5";
  quality?: "low" | "medium" | "high";
};

export function openAIProvider(options: OpenAIProviderOptions = {}): ImageProvider {
  const model = options.model ?? "gpt-image-2";
  const quality = options.quality ?? "medium";

  return {
    name: "openai",
    model,

    async generate(prompt: string, aspect: Aspect): Promise<GeneratedImage> {
      const apiKey = process.env.OPENAI_API_KEY;
      if (!apiKey) throw new ImageGenError("OPENAI_API_KEY is not set.", "config");

      const size = SIZES[aspect];
      // Only 1.5 accepts a transparent background; asking 2 for one is an error.
      const supportsTransparency = model === "gpt-image-1.5";

      const response = await fetch(ENDPOINT, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          prompt,
          size: `${size.width}x${size.height}`,
          quality,
          output_format: "png",
          ...(supportsTransparency ? { background: "transparent" } : {}),
        }),
      });

      if (!response.ok) {
        const body = await response.text();
        // Providers moderate their own output; surface refusals as something a
        // person can act on rather than a stack trace.
        if (response.status === 400 && /safety|moderation|policy/i.test(body)) {
          throw new ImageGenError(
            "That prompt was refused by the image model. Try describing it differently.",
            "moderation",
          );
        }
        throw new ImageGenError(`Image generation failed (${response.status}): ${body}`);
      }

      const json = (await response.json()) as {
        data: Array<{ b64_json?: string }>;
        usage?: { total_tokens?: number };
      };

      const b64 = json.data?.[0]?.b64_json;
      if (!b64) throw new ImageGenError("Image provider returned no image data.");

      return {
        buffer: Buffer.from(b64, "base64"),
        widthPx: size.width,
        heightPx: size.height,
        costCents: estimateCostCents(quality),
        model,
        transparent: supportsTransparency,
      };
    },
  };
}

/**
 * Rough per-image cost, used for the per-participant spend cap. Deliberately
 * an estimate - the cap exists to bound spend, not to bill anyone.
 */
function estimateCostCents(quality: "low" | "medium" | "high"): number {
  return { low: 2, medium: 7, high: 20 }[quality];
}
