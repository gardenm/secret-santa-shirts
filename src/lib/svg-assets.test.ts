import { describe, expect, it } from "vitest";
import sharp from "sharp";
import { SvgAssetError, countImageRefs, inlineAssets } from "./svg-assets";
import { assetUrl, putAsset } from "./storage";
import { renderDesign } from "./render";

const TEE = { widthPx: 3300, heightPx: 4200 };

async function solidPng(w: number, h: number, colour: string) {
  return sharp({ create: { width: w, height: h, channels: 4, background: colour } })
    .png()
    .toBuffer();
}

/** Roughly what Fabric emits: an <image> layer over a transparent field. */
function designSvg(href: string, w = 825, h = 1050) {
  return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
  <image xlink:href="${href}" x="100" y="200" width="500" height="600"></image>
</svg>`;
}

describe("inlineAssets", () => {
  it("inlines an asset the app stored", async () => {
    const { id } = await putAsset(await solidPng(80, 80, "#ff4400"));

    const result = await inlineAssets(designSvg(assetUrl(id)));

    expect(result).toContain("data:image/png;base64,");
    expect(result).not.toContain("/api/assets/");
  });

  it("leaves an existing data URI alone", async () => {
    const dataUri = `data:image/png;base64,${(await solidPng(10, 10, "#00ff00")).toString("base64")}`;

    const result = await inlineAssets(designSvg(dataUri));
    expect(result).toContain(dataUri);
  });

  it("rejects a remote URL rather than rendering it blank", async () => {
    // resvg would render this as nothing and report success, so refusing is
    // the only way the person finds out before the shirt is printed.
    await expect(inlineAssets(designSvg("https://example.com/cat.png"))).rejects.toThrow(
      SvgAssetError,
    );
  });

  it("rejects a protocol-relative URL", async () => {
    await expect(inlineAssets(designSvg("//evil.example.com/a.png"))).rejects.toThrow(SvgAssetError);
  });

  it("rejects an arbitrary local path", async () => {
    // The SVG is client-supplied; resolving by asset id only is what keeps a
    // crafted href from turning into a server-side fetch or a file read.
    await expect(inlineAssets(designSvg("/etc/passwd"))).rejects.toThrow(SvgAssetError);
    await expect(inlineAssets(designSvg("file:///etc/passwd"))).rejects.toThrow(SvgAssetError);
  });

  it("rejects a path traversal dressed up as an asset id", async () => {
    await expect(inlineAssets(designSvg("/api/assets/..%2F..%2Fetc%2Fpasswd"))).rejects.toThrow(
      SvgAssetError,
    );
  });

  it("explains itself when an asset has gone missing", async () => {
    const missing = "/api/assets/00000000-0000-4000-8000-000000000000.png";
    await expect(inlineAssets(designSvg(missing))).rejects.toThrow(/missing from storage/);
  });

  it("handles several layers, resolving each once", async () => {
    const a = await putAsset(await solidPng(40, 40, "#ff0000"));
    const b = await putAsset(await solidPng(40, 40, "#0000ff"));

    const svg = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="825" height="1050">
      <image xlink:href="${assetUrl(a.id)}" x="0" y="0" width="100" height="100"></image>
      <image xlink:href="${assetUrl(b.id)}" x="100" y="0" width="100" height="100"></image>
      <image xlink:href="${assetUrl(a.id)}" x="200" y="0" width="100" height="100"></image>
    </svg>`;

    const result = await inlineAssets(svg);
    expect(countImageRefs(result)).toBe(3);
    expect(result).not.toContain("/api/assets/");
  });
});

describe("rendering an image layer", () => {
  it("puts real pixels in the print file", async () => {
    // The test that catches the silent failure. A dimension check passes on a
    // completely blank render, so this asserts the artwork is actually there.
    const { id } = await putAsset(await solidPng(200, 240, "#ff4400"));
    const svg = await inlineAssets(designSvg(assetUrl(id)));

    const png = await renderDesign(svg, { printArea: TEE });
    const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });

    let opaque = 0;
    for (let i = 3; i < data.length; i += 4) if (data[i] > 200) opaque++;

    expect(info.width).toBe(3300);
    // The layer covers 500x600 of an 825x1050 design, so roughly a third of
    // the print area should be inked.
    expect(opaque).toBeGreaterThan(0.2 * info.width * info.height);
  });

  it("renders blank if the href is left unresolved - the failure being guarded against", async () => {
    // Documents the actual resvg behaviour that motivates inlineAssets. If
    // this ever starts producing pixels, resvg has gained href resolution and
    // the guard could be relaxed.
    const png = await renderDesign(designSvg("/api/assets/whatever.png"), { printArea: TEE });
    const { data } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });

    let opaque = 0;
    for (let i = 3; i < data.length; i += 4) if (data[i] > 200) opaque++;

    expect(opaque).toBe(0);
  });
});
