/**
 * A record of the calls that cost money.
 *
 * The pipeline makes paid calls in three different places - generation, matting
 * and hosted upscaling - and only one of them was ever being counted. Nothing
 * capped how often someone could click "remove background", which the README
 * cheerfully described as impossible.
 *
 * Rather than have each route guess what the pipeline did, the pipeline says
 * so. `upscaleToFit` in particular cannot be predicted from outside: whether it
 * calls a hosted model or resamples locally depends on the scale factor, and
 * only it knows.
 */

/** What a paid call costs us, roughly. An estimate - see estimateCostCents. */
export type PaidCall = {
  provider: "openai" | "fal";
  model: string;
  costCents: number;
  /**
   * "generate" is a new image, which is what a person thinks of as using up an
   * allowance. "assist" is cleaning up or enlarging one they already have.
   * Counted separately so one generation - which quietly makes up to two
   * assists of its own - does not eat three of somebody's thirty images.
   */
  kind: "generate" | "assist";
};

export type CallLog = { record(call: PaidCall): void };

export type CollectedCalls = CallLog & { readonly calls: PaidCall[] };

export function createCallLog(): CollectedCalls {
  const calls: PaidCall[] = [];
  return {
    calls,
    record(call: PaidCall) {
      calls.push(call);
    },
  };
}

/**
 * Rough per-call costs for the fal models.
 *
 * Deliberately estimates, like the OpenAI ones: these bound spend and show
 * people what they have left, they do not bill anybody. Erring high is the
 * safe direction for both jobs.
 */
export const FAL_COSTS = {
  birefnet: 1,
  esrgan: 2,
} as const;
