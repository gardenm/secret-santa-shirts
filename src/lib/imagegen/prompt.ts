/**
 * Turning "a badger on a bike" into something that prints well on a shirt.
 *
 * Two observations drive this, and they happen to pull the same way.
 *
 * The look people mean by "AI slop" - airbrushed 3D gloss, mushy gradients,
 * soft glows, a hundred shades of everything, a vague centred blob - is also
 * the look that prints worst. On a dark garment DTG lays a solid white
 * underbase beneath every partially transparent pixel, so soft edges come out
 * as a chalky halo. Flat colour, hard edges and a tight palette fix the
 * aesthetic problem and the manufacturing problem at once.
 *
 * The other half is specificity. "Highly detailed, 8k, masterpiece" gives the
 * model nothing to act on and lands it in its house style, which is the slop.
 * Naming an actual printing tradition - a two-colour screen print, a linocut -
 * gives it somewhere to go.
 *
 * Structure follows OpenAI's own guidance for the gpt-image models: scene and
 * format first, then subject, then details, then explicit constraints. Those
 * models do follow constraint clauses well, which is worth noting because the
 * advice is model-specific - FLUX.2, for instance, has no negative prompting
 * and wants the subject first instead.
 */

export type PrintStyle =
  | "screenprint"
  | "linocut"
  | "vintage"
  | "ink"
  | "mascot"
  | "none";

export type PromptContext = {
  /** The recipient's garment drives contrast and how hard the edges must be. */
  isDark: boolean;
  colourName: string;
  style?: PrintStyle;
};

/**
 * Named traditions, not adjectives. Each of these is a real printing style
 * with its own constraints, which is why they produce something specific
 * rather than the default gloss.
 */
const STYLES: Record<Exclude<PrintStyle, "none">, string> = {
  screenprint:
    "Rendered as a bold two-colour screen print: flat blocks of solid ink, clean hard edges, " +
    "strong positive and negative space",
  linocut:
    "Rendered as a hand-carved linocut: chunky gouged marks, visible carving texture, stark " +
    "black shapes against bare paper",
  vintage:
    "Rendered as a 1970s printed tee graphic: warm muted palette of three inks, slightly " +
    "distressed ink texture, confident retro shapes",
  ink:
    "Rendered as a hand-drawn ink illustration: confident brush lines of varying weight, " +
    "cross-hatching for shadow, no grey tones",
  mascot:
    "Rendered as a classic embroidered mascot badge: thick outlines, simple expressive shapes, " +
    "three flat colours",
};

export const STYLE_OPTIONS: Array<{ value: PrintStyle; label: string; hint: string }> = [
  { value: "screenprint", label: "Bold screen print", hint: "Flat inks, hard edges. Safest bet." },
  { value: "linocut", label: "Linocut", hint: "Chunky carved marks, high contrast." },
  { value: "vintage", label: "Vintage 70s tee", hint: "Warm muted palette, worn texture." },
  { value: "ink", label: "Hand-drawn ink", hint: "Brush lines and cross-hatching." },
  { value: "mascot", label: "Mascot badge", hint: "Thick outlines, three colours." },
  { value: "none", label: "No set style", hint: "Your words decide. Riskier." },
];

const VALID_STYLES = new Set<string>(STYLE_OPTIONS.map((s) => s.value));

export function isPrintStyle(value: unknown): value is PrintStyle {
  return typeof value === "string" && VALID_STYLES.has(value);
}

/**
 * Builds the prompt actually sent to the model.
 *
 * The person's own words stay intact in the middle - the frame around them is
 * about *how* it is drawn, never *what*, so twelve people asking for twelve
 * different things still get twelve different shirts.
 */
export function buildPrintPrompt(subject: string, context: PromptContext): string {
  const cleaned = subject.trim().replace(/[.\s]+$/, "");
  const style = context.style ?? "screenprint";
  const garment = context.colourName.toLowerCase();

  const sections = [
    // Scene and format first, per the gpt-image prompting guidance.
    "Artwork for the front of a printed t-shirt, isolated on a plain flat background with " +
      "generous empty space around it",

    `The subject: ${cleaned}`,

    style !== "none" ? STYLES[style] : null,

    "A single clear subject with a strong readable silhouette that works from across a room, " +
      "built from flat areas of solid colour with crisp defined edges, using a tight palette of " +
      "three or four inks",

    context.isDark
      ? // On a dark garment the printer lays white ink under everything, so
        // partial opacity becomes a visible halo, and black ink over that
        // underbase reads grey rather than black.
        `Bright saturated colours chosen to stay luminous on a ${garment} shirt, every shape ` +
        `filled with fully opaque ink right up to a sharp outer edge`
      : `Deep saturated colours with strong dark outlines, chosen to hold their own against a ` +
        `${garment} shirt`,

    // gpt-image models follow explicit constraint clauses well. This would be
    // the wrong move on a model without negative prompting.
    "Constraints: no gradients, no soft glows, no drop shadows, no photographic or 3D rendering, " +
      "no background scenery, no border or frame, no watermark, and no lettering unless the " +
      "subject explicitly calls for it",
  ].filter(Boolean);

  return sections.join(". ") + ".";
}

/** Rough word count, for sanity-checking prompt length in tests. */
export function wordCount(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

/**
 * Editor copy. Vague input is the other half of the slop problem, so the
 * placeholder models a concrete subject rather than a mood.
 */
export const PROMPT_PLACEHOLDER =
  "A badger riding a bicycle up a steep hill, determined expression, panniers full of leeks";

export const PROMPT_HINT =
  "Describe one clear subject and what it's doing — concrete beats grand. The print style is " +
  "handled for you, so asking for “highly detailed, 8k, masterpiece” actually makes it worse.";
