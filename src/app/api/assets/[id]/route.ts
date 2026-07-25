import { NextResponse } from "next/server";
import { contentTypeFor, getAsset, isValidAssetId } from "@/lib/storage";
import { auth } from "@/lib/auth";

/**
 * Serves a stored asset.
 *
 * Same-origin on purpose: the canvas loads these directly, and a cross-origin
 * image would taint it. Ids are opaque uuids and validated before touching
 * storage, so a crafted path cannot escape the asset directory.
 */
export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session?.user) return new NextResponse("Not signed in.", { status: 401 });

  const { id } = await context.params;
  if (!isValidAssetId(id)) return new NextResponse("Not found.", { status: 404 });

  try {
    const bytes = await getAsset(id);
    return new NextResponse(new Uint8Array(bytes), {
      headers: {
        "Content-Type": contentTypeFor(id),
        // Assets are immutable - a new id is minted for every change.
        "Cache-Control": "private, max-age=31536000, immutable",
      },
    });
  } catch {
    return new NextResponse("Not found.", { status: 404 });
  }
}
