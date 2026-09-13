import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * Gives the suite its own throwaway asset directory.
 *
 * Tests render print files and store them through lib/storage, which without
 * this writes into the project's own `.uploads/`. Nothing ever cleaned up, so
 * a few runs left hundreds of megabytes of dead PNGs sitting there - gitignored
 * and therefore invisible until the disk filled up.
 */
export default async function setup() {
  const dir = await mkdtemp(path.join(tmpdir(), "shirt-test-assets-"));
  process.env.UPLOADS_DIR = dir;

  return async () => {
    await rm(dir, { recursive: true, force: true });
  };
}
