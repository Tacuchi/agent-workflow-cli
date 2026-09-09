// Addressing a skill INSIDE a source (Spec 043 · AC-04): a candidate is
// identified by (source, resolved ref, path relative to the source root), and
// its invocable name travels beside that triple instead of being it.
//
// Why not the previous by-name discovery: it stopped as soon as the root was
// itself a skill, walked three levels down and discarded repeated names — so a
// collection's leaves were unreachable and `plugins/<x>/skills/<x>` fell off
// the edge. Here the GIT listing is the commit's own tree (no depth, nothing
// hidden below a recognized root, no dedupe) and the LOCAL walk declares its
// limits and says when it was cut.

import type { Dirent } from "node:fs";
import { lstat, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  gitClone,
  gitCloneSkillManifests,
  gitListTreePaths,
  gitResolveCommit,
  gitSparseAddFile,
  gitSparseAddSkillDir,
  gitSparseDisable,
} from "./install-plugin-skills-git.js";
import { hasValidFrontmatter } from "./install-plugin-skills.js";
import { resolveSkillSource, skillFrontmatterName } from "./skills-manager.js";

/** Bounded local walk. A source deeper or wider than this is reported cut. */
export const LOCAL_WALK_LIMITS = { maxDepth: 6, maxEntries: 5000 } as const;

const MANIFEST = "SKILL.md";

/** One addressable skill of a source. */
export interface SkillCandidate {
  /** Path relative to the source root; `""` when the root itself is the skill. */
  path: string;
  /** Invocable identity: the frontmatter `name`, else the directory basename. */
  name: string;
  /** The directory basename — kept because the two diverge in the wild. */
  directory: string;
}

/** What a source turned out to contain, and how sure that list is. */
export interface SourceInventory {
  /** The source as the registry records it (never the temp clone). */
  source: string;
  kind: "git" | "local";
  /** The ref the caller asked for, if any. */
  requestedRef: string | null;
  /** The commit it resolved to — once. `null` for a local source, which is
   *  frozen by its prepared payload's digest instead. */
  resolvedRef: string | null;
  candidates: SkillCandidate[];
  /** The walk hit a limit: `candidates` is a floor, never "all of them". */
  truncated: boolean;
  limits: { maxDepth: number; maxEntries: number } | null;
}

export interface SourceRejection {
  code: string;
  message: string;
}

/**
 * A source brought within reach: what it contains, where to read it, and how
 * to give it back. `materialize` is what turns a chosen PATH into real bytes —
 * identity for a local dir, a sparse expansion for a manifest-only clone.
 */
export interface AcquiredSource {
  inventory: SourceInventory;
  /** Absolute root on disk: the clone, or the local directory itself. */
  root: string;
  materialize: (relPath: string) => Promise<string>;
  /**
   * Every FILE the source contains, source-relative.
   *
   * A sparse clone has almost nothing on disk, so "does this resource exist?"
   * cannot be answered by the filesystem: the commit's own listing answers it,
   * and the local walk answers the same question the same way.
   */
  listPaths: () => Promise<string[]>;
  /** Brings ONE file within reach, or `null` when the source does not have
   *  it — which is the difference between "not fetched" and "not there". */
  materializeFile: (relPath: string) => Promise<string | null>;
  release: () => Promise<void>;
}

/** A path a person typed: it must stay inside the source and cross no link. */
export async function validateRelativePath(
  root: string,
  relPath: string,
): Promise<{ absolute: string } | SourceRejection> {
  const clean = relPath.replace(/^\/+|\/+$/g, "");
  if (clean.length === 0) return { absolute: root };
  if (isAbsolute(relPath)) {
    return { code: "PATH_NOT_RELATIVE", message: `'${relPath}' no es una ruta del origen` };
  }
  const absolute = resolve(root, clean);
  const inside = relative(resolve(root), absolute);
  if (inside.startsWith("..") || isAbsolute(inside)) {
    return { code: "PATH_ESCAPES_SOURCE", message: `'${relPath}' se sale del origen` };
  }
  const crossing = await crossesLink(resolve(root), clean);
  if (crossing !== null) {
    return crossing === "missing"
      ? { code: "PATH_NOT_FOUND", message: `'${relPath}' no existe en el origen` }
      : { code: "PATH_IS_SYMLINK", message: `'${relPath}' cruza un enlace simbólico` };
  }
  return { absolute };
}

/** Every segment, not just the leaf: a link halfway down redirects the rest. */
async function crossesLink(root: string, clean: string): Promise<"missing" | "symlink" | null> {
  let walked = root;
  for (const segment of clean.split("/")) {
    walked = join(walked, segment);
    const stats = await lstat(walked).catch(() => null);
    if (stats === null) return "missing";
    if (stats.isSymbolicLink()) return "symlink";
  }
  return null;
}

/** Candidate at an explicit path — the way in that no exploration limit gates. */
export async function candidateAtPath(
  root: string,
  relPath: string,
): Promise<SkillCandidate | SourceRejection> {
  const validated = await validateRelativePath(root, relPath);
  if ("code" in validated) return validated;
  const manifest = join(validated.absolute, MANIFEST);
  const content = await readFile(manifest, "utf8").catch(() => null);
  if (content === null || !hasValidFrontmatter(content)) {
    return {
      code: "MANIFEST_ABSENT",
      message: `'${relPath || "."}' no tiene un ${MANIFEST} con name y description`,
    };
  }
  return candidateOf(root, validated.absolute, content);
}

function candidateOf(root: string, dir: string, content: string): SkillCandidate {
  const rel = relative(resolve(root), resolve(dir)).split(sep).join("/");
  const directory = rel === "" ? basename(resolve(root)) : basename(dir);
  return { path: rel, name: skillFrontmatterName(content) ?? directory, directory };
}

/**
 * Bounded walk of a local source. Excludes `.git`, `node_modules` and every
 * symlink (a link's `Dirent` is not a directory), keeps `.claude` eligible —
 * the standard home of a repo's own skills — and, unlike the by-name
 * discovery, does NOT stop at a directory that is already a skill: a
 * collection's leaves are exactly what lives below one.
 */
async function walkLocalManifests(
  root: string,
  budget: { entries: number },
): Promise<{ candidates: SkillCandidate[]; truncated: boolean }> {
  const candidates: SkillCandidate[] = [];
  let truncated = false;

  const visit = async (dir: string, depth: number): Promise<void> => {
    if (depth > LOCAL_WALK_LIMITS.maxDepth) {
      truncated = true;
      return;
    }
    let entries: Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      truncated = true;
      return;
    }
    const content = await readFile(join(dir, MANIFEST), "utf8").catch(() => null);
    if (content !== null && hasValidFrontmatter(content)) {
      candidates.push(candidateOf(root, dir, content));
    }
    for (const entry of entries) {
      if (budget.entries <= 0) {
        truncated = true;
        return;
      }
      budget.entries -= 1;
      if (!walkable(entry)) continue;
      await visit(join(dir, entry.name), depth + 1);
    }
  };

  await visit(resolve(root), 0);
  return { candidates, truncated };
}

/**
 * Whether the walk descends into this entry.
 *
 * `.claude` is the one dot-dir kept: it is the standard home of a repo's own
 * skills, so excluding it would hide exactly what somebody is looking for. A
 * symlink's `Dirent` is not a directory, which is how links stay unfollowed.
 */
function walkable(entry: Dirent): boolean {
  if (!entry.isDirectory()) return false;
  if (entry.name === "node_modules" || entry.name === ".git") return false;
  return !entry.name.startsWith(".") || entry.name === ".claude";
}

/** Files of a local source, under the same declared limits as the manifest
 *  walk: it answers "does the source have this?" without following a link. */
async function walkLocalFiles(root: string): Promise<string[]> {
  const base = resolve(root);
  const out: string[] = [];
  const pending: { dir: string; depth: number }[] = [{ dir: base, depth: 0 }];
  let budget = LOCAL_WALK_LIMITS.maxEntries;
  while (pending.length > 0) {
    const next = pending.pop();
    if (next === undefined || next.depth > LOCAL_WALK_LIMITS.maxDepth) continue;
    const entries = await readdir(next.dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (budget <= 0) return out.sort();
      budget -= 1;
      const full = join(next.dir, entry.name);
      // A link's `Dirent` is neither a directory nor a file: it falls through.
      if (walkable(entry)) pending.push({ dir: full, depth: next.depth + 1 });
      else if (entry.isFile()) out.push(relative(base, full).split(sep).join("/"));
    }
  }
  return out.sort();
}

/** Manifests of a git clone, read from the COMMIT's tree. */
async function gitManifests(root: string, paths: readonly string[]): Promise<SkillCandidate[]> {
  const candidates: SkillCandidate[] = [];
  for (const path of paths) {
    if (path !== MANIFEST && !path.endsWith(`/${MANIFEST}`)) continue;
    const absolute = join(root, path);
    const content = await readFile(absolute, "utf8").catch(() => null);
    if (content === null || !hasValidFrontmatter(content)) continue;
    candidates.push(candidateOf(root, dirname(absolute), content));
  }
  return candidates;
}

export async function acquireSource(
  source: string,
  ref?: string,
): Promise<AcquiredSource | SourceRejection> {
  const resolved = resolveSkillSource(source, ref);
  if ("error" in resolved) return { code: "INVALID_SOURCE", message: resolved.error };

  if (resolved.kind === "local") {
    const stats = await lstat(resolved.path).catch(() => null);
    if (stats === null) {
      return { code: "SOURCE_NOT_FOUND", message: `el path local '${resolved.path}' no existe` };
    }
    if (stats.isSymbolicLink()) {
      return {
        code: "SOURCE_IS_SYMLINK",
        message: `'${resolved.path}' es un enlace simbólico: declará su destino real`,
      };
    }
    const walk = await walkLocalManifests(resolved.path, { entries: LOCAL_WALK_LIMITS.maxEntries });
    return {
      inventory: {
        source: resolved.path,
        kind: "local",
        requestedRef: null,
        resolvedRef: null,
        candidates: walk.candidates,
        truncated: walk.truncated,
        limits: { ...LOCAL_WALK_LIMITS },
      },
      root: resolved.path,
      materialize: async (relPath) => resolve(resolved.path, relPath),
      listPaths: () => walkLocalFiles(resolved.path),
      materializeFile: async (relPath) => {
        const absolute = resolve(resolved.path, relPath);
        return (await lstat(absolute).catch(() => null)) === null ? null : absolute;
      },
      release: async () => {},
    };
  }

  const temp = await mkdtemp(join(tmpdir(), "aw-skill-source-"));
  const release = async () => {
    await rm(temp, { recursive: true, force: true }).catch(() => {});
  };
  // A server that refuses the partial clone falls back to a full one; then the
  // whole tree is already checked out and `materialize` is identity.
  let sparse = true;
  try {
    await gitCloneSkillManifests(resolved.url, temp, resolved.ref);
  } catch {
    await rm(temp, { recursive: true, force: true }).catch(() => {});
    try {
      await gitClone(resolved.url, temp, resolved.ref);
      sparse = false;
    } catch (err) {
      await release();
      return { code: "GIT_CLONE_FAILED", message: `git clone falló: ${(err as Error).message}` };
    }
  }
  try {
    const tree = await gitListTreePaths(temp);
    const candidates = await gitManifests(temp, tree);
    const resolvedRef = await gitResolveCommit(temp);
    return {
      inventory: {
        // The registry records the source the person gave, never the temp dir.
        source: source.split("#")[0] ?? source,
        kind: "git",
        requestedRef: resolved.ref ?? null,
        resolvedRef,
        candidates,
        truncated: false,
        limits: null,
      },
      root: temp,
      materialize: async (relPath) => {
        if (sparse) {
          if (relPath === "") await gitSparseDisable(temp);
          else await gitSparseAddSkillDir(temp, relPath);
        }
        return resolve(temp, relPath);
      },
      listPaths: async () => tree,
      materializeFile: async (relPath) => {
        if (!tree.includes(relPath)) return null;
        if (sparse) await gitSparseAddFile(temp, relPath);
        return resolve(temp, relPath);
      },
      release,
    };
  } catch (err) {
    await release();
    return {
      code: "SOURCE_UNREADABLE",
      message: `no se pudo leer el árbol de '${source}': ${(err as Error).message}`,
    };
  }
}

/** By-name selection, kept ONLY while it resolves a single option: two skills
 *  with the same name in one source are two alternatives, not a coin toss. */
export function candidatesNamed(inventory: SourceInventory, name: string): SkillCandidate[] {
  return inventory.candidates.filter((c) => c.name === name || c.directory === name);
}
