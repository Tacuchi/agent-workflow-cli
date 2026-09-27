import { createHash } from "node:crypto";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const MANIFEST_FILE = "dist-manifest.json";

/** Seal the bytes left by tsc, never the manifest itself. */
export async function writeDistManifest(distRoot, version) {
  const files = [];
  async function walk(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const absolute = join(dir, entry.name);
      if (entry.isDirectory()) await walk(absolute);
      else if (entry.isFile() && absolute !== join(distRoot, MANIFEST_FILE)) {
        files.push({
          path: relative(distRoot, absolute).split(sep).join("/"),
          sha256: `sha256:${createHash("sha256")
            .update(await readFile(absolute))
            .digest("hex")}`,
        });
      }
    }
  }
  await walk(distRoot);
  files.sort((a, b) => a.path.localeCompare(b.path, "en"));
  await writeFile(
    join(distRoot, MANIFEST_FILE),
    `${JSON.stringify({ version, files }, null, 2)}\n`,
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const scriptsDir = dirname(fileURLToPath(import.meta.url));
  const packageRoot = resolve(scriptsDir, "..");
  const { version } = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));
  await writeDistManifest(join(packageRoot, "dist"), version);
}
