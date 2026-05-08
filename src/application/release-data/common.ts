import { join } from "node:path";
import type { FileSystemPort } from "../../ports/file-system.js";
import { parseProjectBlock } from "../parsers/project-block.js";
import type { PathsService } from "../paths-service.js";

export function sessionCodeInt(code: string | null | undefined): number | null {
  if (!code) return null;
  let s = String(code)
    .trim()
    .replace(/session/g, "");
  s = (s.split("-")[0] ?? "").trim();
  const n = Number.parseInt(s, 10);
  return Number.isNaN(n) ? null : n;
}

export async function collectFilesByExt(
  fs: FileSystemPort,
  dir: string,
  ext: string,
): Promise<string[]> {
  const result: string[] = [];
  const stack: string[] = [dir];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) break;
    let entries: Awaited<ReturnType<FileSystemPort["list"]>>;
    try {
      entries = await fs.list(current);
    } catch {
      continue;
    }
    for (const e of entries) {
      if (e.type === "dir") stack.push(e.path);
      else if (e.type === "file" && e.name.endsWith(ext)) result.push(e.path);
    }
  }
  return result;
}

export async function readSources(
  fs: FileSystemPort,
  cwd: string,
  paths: PathsService,
): Promise<{ alias: string; path: string }[]> {
  for (const file of [join(cwd, "CLAUDE.md"), join(cwd, "AGENTS.md")]) {
    if (!(await fs.exists(file))) continue;
    const block = parseProjectBlock(await fs.readText(file), paths.blockMarkers());
    if (block) return block.fuentes;
  }
  return [];
}

export async function getDocsDir(
  fs: FileSystemPort,
  cwd: string,
  paths: PathsService,
  sourceAlias: string | undefined,
): Promise<string> {
  if (!sourceAlias) return join(cwd, "docs");
  const sources = await readSources(fs, cwd, paths);
  const found = sources.find((s) => s.alias === sourceAlias);
  if (!found) {
    throw new Error(
      `Fuente '${sourceAlias}' no encontrada. Aliases disponibles: ${sources
        .map((s) => s.alias)
        .join(", ")}`,
    );
  }
  return join(found.path, "docs");
}

export async function getReleaseDir(
  fs: FileSystemPort,
  cwd: string,
  paths: PathsService,
  sourceAlias: string | undefined,
): Promise<string> {
  return join(await getDocsDir(fs, cwd, paths, sourceAlias), "release");
}
