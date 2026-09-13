import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  resolve: {
    alias: { "@": path.resolve(__dirname, "./src") },
  },
  test: {
    // PGlite spins up a fresh in-process Postgres and applies migrations per
    // suite, which is slower than a unit test but still seconds, not minutes.
    testTimeout: 30_000,
    hookTimeout: 60_000,
    // Points lib/storage at a temp directory and deletes it afterwards, so a
    // run does not leave print files in the project.
    globalSetup: ["./vitest.global-setup.ts"],
  },
});
