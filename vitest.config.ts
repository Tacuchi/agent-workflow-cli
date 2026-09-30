import { execFileSync } from "node:child_process";
import { dirname } from "node:path";
import { defineConfig } from "vitest/config";

/**
 * On macOS `/usr/bin/git` is an xcrun shim: every call resolves the developer dir and
 * execs the real git, doubling the spawn. The git suites spawn thousands of them, and
 * under parallel workers that overhead is what pushed them past their timeouts.
 */
function pathWithRealGit(): string | undefined {
  if (process.platform !== "darwin") return undefined;
  try {
    const git = execFileSync("xcrun", ["--find", "git"], { encoding: "utf8" }).trim();
    return git === "" ? undefined : `${dirname(git)}:${process.env.PATH ?? ""}`;
  } catch {
    return undefined;
  }
}

const path = pathWithRealGit();

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts", "tests/**/*.test.tsx"],
    ...(path !== undefined ? { env: { PATH: path } } : {}),
    // The limit catches hangs; a loaded machine still slows the git suites.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
