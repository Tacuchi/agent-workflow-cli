// The run exercises the checkout's `dist`, so `dist` must be built from the
// checkout as it is now. Chosen check: modification times. Any file under
// src/ or skills/, or package.json, newer than dist/dist-manifest.json (which
// `npm run build` writes last) means the build is stale, and the run refuses.
// A content check of the tracked src would also catch a `git checkout` that
// restores older mtimes; mtimes were chosen because they need no git and catch
// the common case, an edit without `npm run build`. The src tree hash is
// recorded in the evidence next to the copied CLI's, for anyone to recompute.

import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

export const BUILD_INPUTS = ["src", "skills", "package.json"];
export const BUILD_STAMP = join("dist", "dist-manifest.json");

function filesUnder(path) {
  if (!existsSync(path)) return [];
  if (!statSync(path).isDirectory()) return [path];
  return readdirSync(path, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? filesUnder(join(path, e.name)) : e.isFile() ? [join(path, e.name)] : [],
  );
}

/**
 * Build inputs newer than the build stamp, relative to `checkout`, newest first.
 * `mtime(path)` is injectable for tests. A missing stamp is itself stale.
 */
export function staleBuildInputs(checkout, mtime = (p) => statSync(p).mtimeMs) {
  const stamp = join(checkout, BUILD_STAMP);
  if (!existsSync(stamp)) return [BUILD_STAMP];
  const built = mtime(stamp);
  return BUILD_INPUTS.flatMap((part) => filesUnder(join(checkout, part)))
    .map((f) => ({ f, t: mtime(f) }))
    .filter(({ t }) => t > built)
    .sort((a, b) => b.t - a.t)
    .map(({ f }) => f.slice(checkout.length + 1));
}
