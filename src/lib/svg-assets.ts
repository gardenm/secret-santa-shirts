import { contentTypeFor, getAsset, isValidAssetId } from "./storage";

/**
 * Inlines image assets into a design SVG as data URIs.
 *
 * This is not an optimisation - it is load-bearing correctness.
 *
 * resvg has no image-href resolver and no network access, and it does not
 * complain about hrefs it cannot load: it renders the image as nothing and
 * reports success. Fabric's toSVG() emits the raw src URL. So without this
 * step, every design containing an uploaded or generated image renders as a
 * blank print file, at exactly the right dimensions, with no error anywhere -
 * a failure that would surface when the shirts arrived.
 *
 * Measured, for the avoidance of doubt:
 *   data:image/png;base64,...   -> renders
 *   /api/assets/<id>            -> 0 opaque pixels, no error
 *   https://example.com/a.png   -> 0 opaque pixels, no error
 *
 * The allowlist below therefore refuses anything it cannot resolve rather than
 * letting it through to render blank. It doubles as SSRF protection: the SVG
 * is client-supplied, and assets resolve from storage by id, so a crafted href
 * can never make the server fetch a URL of the client's choosing.
 */

export class SvgAssetError extends Error {}

/** Matches href="..." and xlink:href="..." on <image> elements. */
const IMAGE_HREF = /<image\b[^>]*?\s(?:xlink:)?href\s*=\s*"([^"]*)"/gi;

const ASSET_PATH = /^\/api\/assets\/([^/?#]+)$/;

export async function inlineAssets(svg: string): Promise<string> {
  const hrefs = [...svg.matchAll(IMAGE_HREF)].map((m) => m[1]);
  const replacements = new Map<string, string>();

  for (const href of hrefs) {
    if (replacements.has(href)) continue;

    // Already inline - nothing to resolve, and resvg handles it.
    if (href.startsWith("data:image/")) {
      replacements.set(href, href);
      continue;
    }

    const match = ASSET_PATH.exec(href);
    if (!match) {
      throw new SvgAssetError(
        `This design references an image the server cannot resolve (${truncate(href)}). ` +
          `Only images uploaded or generated through this app can be printed - an external ` +
          `link would render as a blank shirt.`,
      );
    }

    const id = decodeURIComponent(match[1]);
    if (!isValidAssetId(id)) {
      throw new SvgAssetError(`This design references an invalid image id (${truncate(id)}).`);
    }

    let bytes: Buffer;
    try {
      bytes = await getAsset(id);
    } catch {
      throw new SvgAssetError(
        `An image in this design is missing from storage (${truncate(id)}). ` +
          `Try re-adding it before submitting.`,
      );
    }

    replacements.set(href, `data:${contentTypeFor(id)};base64,${bytes.toString("base64")}`);
  }

  return svg.replace(IMAGE_HREF, (whole, href: string) => {
    const replacement = replacements.get(href);
    return replacement === undefined ? whole : whole.replace(href, replacement);
  });
}

/** How many image layers a design references. Used to sanity-check renders. */
export function countImageRefs(svg: string): number {
  return [...svg.matchAll(IMAGE_HREF)].length;
}

function truncate(value: string, max = 60): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}
