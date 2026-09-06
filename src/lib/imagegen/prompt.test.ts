import { describe, expect, it } from "vitest";
import {
  STYLE_OPTIONS,
  buildPrintPrompt,
  isPrintStyle,
  wordCount,
  type PrintStyle,
} from "./prompt";

const BLACK = { isDark: true, colourName: "Black" };
const WHITE = { isDark: false, colourName: "White" };

describe("buildPrintPrompt", () => {
  it("keeps the person's own words intact", () => {
    // The frame is about how it is drawn, never what. Twelve people asking for
    // twelve things must still get twelve different shirts.
    const prompt = buildPrintPrompt("a badger riding a bicycle", WHITE);
    expect(prompt).toContain("a badger riding a bicycle");
  });

  it("tidies trailing punctuation rather than doubling it up", () => {
    const prompt = buildPrintPrompt("a badger on a bike.  ", WHITE);
    expect(prompt).not.toContain("bike..");
    expect(prompt).toContain("a badger on a bike");
  });

  it("asks for the qualities that both look good and print well", () => {
    const prompt = buildPrintPrompt("a fox", WHITE);

    // Flat colour, hard edges and a tight palette are simultaneously the cure
    // for generic AI output and for DTG print problems.
    expect(prompt).toMatch(/flat areas of solid colour/i);
    expect(prompt).toMatch(/crisp defined edges/i);
    expect(prompt).toMatch(/three or four inks/i);
    expect(prompt).toMatch(/silhouette/i);
  });

  it("rules out the gloss that reads as slop", () => {
    const prompt = buildPrintPrompt("a fox", WHITE);

    // gpt-image models follow explicit constraint clauses; this would be the
    // wrong technique on a model without negative prompting.
    expect(prompt).toMatch(/no gradients/i);
    expect(prompt).toMatch(/no soft glows/i);
    expect(prompt).toMatch(/no photographic or 3D rendering/i);
    expect(prompt).toMatch(/no watermark/i);
  });

  it("asks for a plain background, which is what makes matting clean", () => {
    const prompt = buildPrintPrompt("a fox", WHITE);

    // BiRefNet cuts a subject off a uniform field far more cleanly than off a
    // busy scene, so the prompt does the cutout step a favour.
    expect(prompt).toMatch(/plain flat background/i);
    expect(prompt).toMatch(/no background scenery/i);
  });
});

describe("garment awareness", () => {
  it("asks for opaque ink and bright colour on a dark shirt", () => {
    const prompt = buildPrintPrompt("a fox", { isDark: true, colourName: "Navy" });

    // Partial opacity on a dark garment gets a solid white underbase beneath
    // it, which prints as a chalky halo.
    expect(prompt).toMatch(/fully opaque ink/i);
    expect(prompt).toMatch(/bright saturated/i);
    expect(prompt).toContain("navy");
  });

  it("asks for deep colour and dark outlines on a light shirt", () => {
    const prompt = buildPrintPrompt("a fox", { isDark: false, colourName: "Natural" });

    expect(prompt).toMatch(/deep saturated colours/i);
    expect(prompt).toMatch(/strong dark outlines/i);
    expect(prompt).toContain("natural");
  });

  it("gives genuinely different guidance for the two cases", () => {
    const dark = buildPrintPrompt("a fox", BLACK);
    const light = buildPrintPrompt("a fox", WHITE);

    expect(dark).not.toBe(light);
    expect(dark).toMatch(/luminous/i);
    expect(light).not.toMatch(/luminous/i);
  });
});

describe("styles", () => {
  it("names a real printing tradition for each option", () => {
    for (const { value } of STYLE_OPTIONS) {
      if (value === "none") continue;
      const prompt = buildPrintPrompt("a fox", { ...WHITE, style: value as PrintStyle });

      // A named tradition gives the model somewhere specific to go. Quality
      // adjectives just land it back in its house style.
      expect(prompt).toMatch(/Rendered as a/);
      expect(prompt).not.toMatch(/masterpiece|8k|highly detailed|trending/i);
    }
  });

  it("produces a different prompt for each style", () => {
    const prompts = STYLE_OPTIONS.map(({ value }) =>
      buildPrintPrompt("a fox", { ...WHITE, style: value }),
    );
    expect(new Set(prompts).size).toBe(STYLE_OPTIONS.length);
  });

  it("defaults to screen print, the most forgiving option", () => {
    expect(buildPrintPrompt("a fox", WHITE)).toBe(
      buildPrintPrompt("a fox", { ...WHITE, style: "screenprint" }),
    );
  });

  it("still applies the print rules when no style is chosen", () => {
    const prompt = buildPrintPrompt("a fox", { ...WHITE, style: "none" });

    expect(prompt).not.toMatch(/Rendered as a/);
    // The manufacturing constraints are not optional, whatever the style.
    expect(prompt).toMatch(/flat areas of solid colour/i);
    expect(prompt).toMatch(/no gradients/i);
  });

  it("validates styles coming off the wire", () => {
    expect(isPrintStyle("linocut")).toBe(true);
    expect(isPrintStyle("photorealistic")).toBe(false);
    expect(isPrintStyle(null)).toBe(false);
  });
});

describe("prompt length", () => {
  it("stays substantial without burying the subject", () => {
    const prompt = buildPrintPrompt("a badger riding a bicycle up a steep hill", WHITE);
    const words = wordCount(prompt);

    expect(words).toBeGreaterThan(60);
    expect(words).toBeLessThan(160);
  });

  it("puts the subject near the front", () => {
    const prompt = buildPrintPrompt("a badger riding a bicycle", WHITE);

    // Scene and format come first per OpenAI's guidance, but the subject must
    // not end up buried behind a paragraph of boilerplate.
    expect(prompt.indexOf("badger")).toBeLessThan(prompt.length / 2);
  });
});
