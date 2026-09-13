import { describe, expect, it } from "vitest";
import { ImageGenError } from "./types";
import { aiConfigured, resolveTarget } from "./providers/openai";

/**
 * Where a generation request goes, and under which model id.
 *
 * These are pure - no network, no keys - which is the point: the whole risk in
 * routing through the Gateway is getting the endpoint and the model id out of
 * step with each other, and that is decidable without spending a cent.
 */

const GATEWAY = { AI_GATEWAY_API_KEY: "gw-key" };
const DIRECT = { OPENAI_API_KEY: "sk-key" };

describe("resolveTarget", () => {
  it("prefers the Gateway, because that is where the spend ceiling is", () => {
    const target = resolveTarget("gpt-image-2", { ...GATEWAY, ...DIRECT });

    expect(target.viaGateway).toBe(true);
    expect(target.apiKey).toBe("gw-key");
    expect(target.endpoint).toBe("https://ai-gateway.vercel.sh/v1/images/generations");
  });

  it("prefixes the model with its creator for the Gateway", () => {
    // The Gateway namespaces models by creator. A bare id here is a 400 on
    // every single request - a total outage of the feature, not a degradation.
    expect(resolveTarget("gpt-image-2", GATEWAY).modelId).toBe("openai/gpt-image-2");
  });

  it("does not leak that prefix onto the direct OpenAI path", () => {
    // The mirror-image failure, and the reason these two are tested together:
    // OpenAI has no idea what "openai/gpt-image-2" is.
    const target = resolveTarget("gpt-image-2", DIRECT);

    expect(target.viaGateway).toBe(false);
    expect(target.modelId).toBe("gpt-image-2");
    expect(target.endpoint).toBe("https://api.openai.com/v1/images/generations");
  });

  it("treats an empty env var as unset rather than as a key", () => {
    // `AI_GATEWAY_API_KEY=""` is how a var usually arrives "unset". Letting it
    // win would route to the Gateway with no credential and fail at runtime,
    // while a perfectly good OpenAI key sat unused.
    const target = resolveTarget("gpt-image-2", { AI_GATEWAY_API_KEY: "", ...DIRECT });

    expect(target.viaGateway).toBe(false);
    expect(target.apiKey).toBe("sk-key");
  });

  it("fails as a config error, naming both variables", () => {
    try {
      resolveTarget("gpt-image-2", {});
      expect.unreachable("expected a config error");
    } catch (error) {
      expect(error).toBeInstanceOf(ImageGenError);
      // "config" is what separates "you didn't set this up" from "the provider
      // refused your prompt" for the caller.
      expect((error as ImageGenError).kind).toBe("config");
      expect((error as Error).message).toContain("AI_GATEWAY_API_KEY");
      expect((error as Error).message).toContain("OPENAI_API_KEY");
    }
  });
});

describe("aiConfigured", () => {
  it("accepts either key on its own", () => {
    // The editor hides its AI panel on this answer. When it only knew about
    // OPENAI_API_KEY, configuring just the Gateway made the feature vanish
    // from the UI while the backend worked perfectly.
    expect(aiConfigured(GATEWAY)).toBe(true);
    expect(aiConfigured(DIRECT)).toBe(true);
  });

  it("is false with neither, and with empty strings", () => {
    expect(aiConfigured({})).toBe(false);
    expect(aiConfigured({ AI_GATEWAY_API_KEY: "", OPENAI_API_KEY: "" })).toBe(false);
  });
});
