import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import type { FileSystemPort } from "../ports/file-system.js";
import type { PathsService } from "./paths-service.js";

const MINIMUM = ["CHECKPOINT.md", "DECISION.md", "BACKLOG.md"];

/** Only citations inside the system's scratch directory are eligible for copying. */
export async function sessionScratchReferences(
  fs: FileSystemPort,
  sessionPath: string,
): Promise<string[]> {
  const found = new Set<string>();
  const temp = await fs.realPath(tmpdir());
  for (const name of ["CONCLUSIONS.md", "BACKLOG.md"]) {
    const file = join(sessionPath, name);
    if (!(await fs.exists(file))) continue;
    const content = await fs.readText(file);
    for (const match of content.matchAll(
      /`([^`]+)`|(?:^|[\s(])((?:\/|[A-Za-z]:[\\/])[^\s)<>`]+)/gm,
    )) {
      const candidate = (match[1] ?? match[2] ?? "").trim().replace(/[.,;:]$/, "");
      if (!isAbsolute(candidate)) continue;
      const canonical = await fs.realPath(candidate);
      const inside = relative(temp, canonical);
      if (inside === "" || inside === ".." || inside.startsWith(`..${sep}`) || isAbsolute(inside))
        continue;
      found.add(candidate);
    }
  }
  return [...found].sort();
}

/** Consent copies citations into the session first, before the versioned archive snapshots them. */
export async function copySessionEvidence(
  fs: FileSystemPort,
  sessionPath: string,
  citations: readonly string[],
): Promise<string[]> {
  const copied: string[] = [];
  const temp = await fs.realPath(tmpdir());
  for (const citation of citations) {
    const source = await fs.realPath(citation);
    const inside = relative(temp, source);
    if (inside === "" || inside === ".." || inside.startsWith(`..${sep}`) || isAbsolute(inside))
      continue;
    const stat = await fs.lstat(citation);
    if (stat?.type !== "file" || stat.isSymlink) continue;
    const destination = join(sessionPath, "evidence", inside);
    await fs.mkdirp(dirname(destination));
    if (await fs.exists(destination)) await fs.remove(destination);
    await fs.publishBytesExclusive(destination, await fs.readBytes(citation));
    copied.push(relative(sessionPath, destination));
  }
  return copied;
}

/** Replace the versioned minimum without exposing a partially copied archive. */
export async function archiveSessionMinimum(
  fs: FileSystemPort,
  paths: PathsService,
  folder: string,
  sessionPath: string,
): Promise<string[]> {
  const archive = join(paths.cwdRoot(), "archive", folder);
  const staging = `${archive}.staging-${randomUUID()}`;
  const backup = `${archive}.backup-${randomUUID()}`;
  const copied: string[] = [];
  await fs.mkdirp(staging);
  try {
    const put = async (file: string, rel: string) => {
      const stat = await fs.lstat(file);
      if (stat?.type !== "file" || stat.isSymlink) return;
      const destination = join(staging, rel);
      await fs.mkdirp(dirname(destination));
      await fs.publishBytesExclusive(destination, await fs.readBytes(file));
      copied.push(rel);
    };
    for (const name of MINIMUM) await put(join(sessionPath, name), name);
    for (const entry of await fs.list(sessionPath)) {
      if (entry.type === "file" && entry.name.toLowerCase().endsWith(".sql"))
        await put(entry.path, entry.name);
    }
    const walk = async (dir: string, prefix: string, sqlOnly: boolean): Promise<void> => {
      if (!(await fs.exists(dir))) return;
      if ((await fs.lstat(dir))?.isSymlink) return;
      for (const entry of await fs.list(dir)) {
        const stat = await fs.lstat(entry.path);
        if (stat?.isSymlink) continue;
        if (stat?.type === "dir") await walk(entry.path, join(prefix, entry.name), sqlOnly);
        else if (stat?.type === "file" && (!sqlOnly || entry.name.toLowerCase().endsWith(".sql")))
          await put(entry.path, join(prefix, entry.name));
      }
    };
    await walk(join(sessionPath, "scripts"), "scripts", true);
    await walk(join(sessionPath, "evidence"), "evidence", false);
    if (await fs.exists(archive)) await fs.rename(archive, backup);
    try {
      await fs.rename(staging, archive);
    } catch (error) {
      if (await fs.exists(backup)) await fs.rename(backup, archive);
      throw error;
    }
    await fs.remove(backup);
    return copied.map((name) => join(archive, name));
  } finally {
    await fs.remove(staging);
  }
}
