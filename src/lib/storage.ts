import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * Asset storage for uploads, generated images and print files.
 *
 * Two adapters behind one interface: Vercel Blob when BLOB_READ_WRITE_TOKEN is
 * set, otherwise a local directory. Local is the default so dev and tests need
 * no cloud account.
 *
 * Assets are addressed by an opaque id, never by a caller-supplied URL. That
 * matters more than it looks: the design SVG comes from the client, and
 * resolving assets by id means the server never fetches a URL a client chose.
 *
 * Blobs are private, so the only way to read one is through /api/assets/[id],
 * which requires a session. The bucket is not a second, unguarded copy of
 * everyone's designs.
 */

export type StoredAsset = { id: string; contentType: string };

/**
 * Where local assets go.
 *
 * Overridable so the test suite can point at a temp directory it throws away.
 * Left to itself, a full run wrote a few hundred files into `.uploads/` and
 * never cleaned up - gitignored, so invisible until the disk filled.
 */
function localDir(): string {
  return process.env.UPLOADS_DIR || path.join(process.cwd(), ".uploads");
}

/** Ids are uuids with an extension - the pattern the SVG allowlist matches on. */
const ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(png|jpg|jpeg|svg)$/i;

export function isValidAssetId(id: string): boolean {
  return ID_PATTERN.test(id);
}

function extensionFor(contentType: string): string {
  if (contentType.includes("jpeg") || contentType.includes("jpg")) return "jpg";
  if (contentType.includes("svg")) return "svg";
  return "png";
}

export function contentTypeFor(id: string): string {
  if (id.endsWith(".jpg") || id.endsWith(".jpeg")) return "image/jpeg";
  if (id.endsWith(".svg")) return "image/svg+xml";
  return "image/png";
}

function blobConfigured(): boolean {
  return Boolean(process.env.BLOB_READ_WRITE_TOKEN);
}

export async function putAsset(bytes: Buffer, contentType = "image/png"): Promise<StoredAsset> {
  const id = `${randomUUID()}.${extensionFor(contentType)}`;

  if (blobConfigured()) {
    const { put } = await import("@vercel/blob");
    // Private, not public. These are people's designs, and the whole point is
    // that nobody sees them before the reveal. A public blob URL is readable by
    // anyone who has it - and the URL leaks easily enough: a screenshot of
    // devtools, a shared tab, the Vercel dashboard itself. The uuid makes it
    // unguessable, which is not the same as protected.
    await put(id, bytes, { access: "private", contentType, addRandomSuffix: false });
  } else {
    const dir = localDir();
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, id), bytes);
  }

  return { id, contentType };
}

export async function getAsset(id: string): Promise<Buffer> {
  if (!isValidAssetId(id)) throw new Error(`Not a valid asset id: ${id}`);

  if (blobConfigured()) {
    // `get` authenticates with the store token, which is what makes a private
    // blob readable at all. The old `head` then `fetch(meta.url)` pair only
    // worked because the blob was public.
    const { get } = await import("@vercel/blob");
    // Null for a blob that is not there; a 304 needs an ifNoneMatch we never
    // send. Either way there are no bytes, and the caller gets a clear failure
    // rather than an empty image that would print as a blank shirt.
    const result = await get(id, { access: "private" });
    if (!result || result.statusCode !== 200) {
      throw new Error(`Asset ${id} could not be read.`);
    }
    return Buffer.from(await new Response(result.stream).arrayBuffer());
  }

  return readFile(path.join(localDir(), id));
}

/** The URL the browser loads an asset from. Same-origin, so the canvas is never tainted. */
export function assetUrl(id: string): string {
  return `/api/assets/${id}`;
}
