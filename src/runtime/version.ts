import { createRequire } from "node:module";

/**
 * Version from the package's own package.json via a relative require — the
 * ../../ hop works from both src/runtime/ (vitest) and dist/runtime/
 * (published bin). Failure degrades to "unknown" rather than crashing.
 */
export function readPackageVersion(): string {
  try {
    const require = createRequire(import.meta.url);
    const pkg = require("../../package.json") as { version?: string };
    return pkg.version ?? "unknown";
  } catch {
    return "unknown";
  }
}
