import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts", "tests/**/*.test.tsx"],
    // Git-heavy suites run near 10 s on a loaded machine; the limit catches hangs, not slowness.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
