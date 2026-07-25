export type Aspect = "portrait" | "square" | "landscape";

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
