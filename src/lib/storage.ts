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
 */

export type StoredAsset = { id: string; contentType: string };

const LOCAL_DIR = path.join(process.cwd(), ".uploads");

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

function useBlob(): boolean {
  return Boolean(process.env.BLOB_READ_WRITE_TOKEN);
}

export async function putAsset(bytes: Buffer, contentType = "image/png"): Promise<StoredAsset> {
  const id = `${randomUUID()}.${extensionFor(contentType)}`;

  if (useBlob()) {
    const { put } = await import("@vercel/blob");
    await put(id, bytes, { access: "public", contentType, addRandomSuffix: false });
  } else {
    await mkdir(LOCAL_DIR, { recursive: true });
    await writeFile(path.join(LOCAL_DIR, id), bytes);
  }

  return { id, contentType };
}

export async function getAsset(id: string): Promise<Buffer> {
  if (!isValidAssetId(id)) throw new Error(`Not a valid asset id: ${id}`);

  if (useBlob()) {
    const { head } = await import("@vercel/blob");
    const meta = await head(id);
    const response = await fetch(meta.url);
    if (!response.ok) throw new Error(`Asset ${id} could not be read.`);
    return Buffer.from(await response.arrayBuffer());
  }

  return readFile(path.join(LOCAL_DIR, id));
}

/** The URL the browser loads an asset from. Same-origin, so the canvas is never tainted. */
export function assetUrl(id: string): string {
  return `/api/assets/${id}`;
}
