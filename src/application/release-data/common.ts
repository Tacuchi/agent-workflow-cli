import { join } from "node:path";
import {
  correlativeValue,
  leadingCorrelativeInput,
  normalizeCorrelativeInput,
  prefixedCorrelativeInput,
} from "../../domain/correlative.js";
import type { FileSystemPort } from "../../ports/file-system.js";
import { readWorkspaceBlock } from "../parsers/project-block.js";
import type { PathsService } from "../paths-service.js";

export function sessionCorrelative(code: string | null | undefined): string | null {
  if (!code) return null;
  const value = String(code).trim();
  return (
    normalizeCorrelativeInput(value) ??
    prefixedCorrelativeInput(value, "session") ??
    leadingCorrelativeInput(value)
  );
}

/**
 * Compatibility projection for older release callers. New range comparisons
 * use `sessionCorrelative` and the domain comparator so `999 → 1000` stays in
 * numeric order.
 */
export function sessionCodeInt(code: string | null | undefined): number | null {
  const correlative = sessionCorrelative(code);
  const value = correlative === null ? null : correlativeValue(correlative);
  return value === null ? null : Number(value);
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
  const block = await readWorkspaceBlock(fs, cwd, paths.blockMarkers());
  return block?.fuentes ?? [];
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
