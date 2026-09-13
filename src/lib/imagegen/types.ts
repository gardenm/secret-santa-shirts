export const ASPECTS = ["portrait", "square", "landscape"] as const;
export type Aspect = (typeof ASPECTS)[number];

/**
 * Validates an aspect that came from a client.
 *
 * The provider indexes a size table with this. An unknown value read as
 * `undefined` there and then threw a TypeError on `.width`, which surfaced to
 * the person as a 502 with an internal message in it. `style` on the same
 * request was already validated; this is the same guard for its neighbour.
 */
export function isAspect(value: unknown): value is Aspect {
  return typeof value === "string" && (ASPECTS as readonly string[]).includes(value);
}

export type GeneratedImage = {
  /** Raw PNG bytes. */
  buffer: Buffer;
  widthPx: number;
  heightPx: number;
  costCents: number;
  model: string;
  /** True when the model produced a genuine alpha channel itself. */
  transparent: boolean;
};

export interface ImageProvider {
  readonly name: string;
  readonly model: string;
  generate(prompt: string, aspect: Aspect): Promise<GeneratedImage>;
}

export class ImageGenError extends Error {
  constructor(
    message: string,
    readonly kind: "moderation" | "provider" | "config" = "provider",
  ) {
    super(message);
  }
}
