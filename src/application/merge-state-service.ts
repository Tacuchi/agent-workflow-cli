import { isAbsolute, join } from "node:path";
import type { EnvPort } from "../ports/env.js";
import type { FileSystemPort } from "../ports/file-system.js";
import type { GitPort } from "../ports/git.js";
import { parseProjectBlock } from "./parsers/project-block.js";
import type { PathsService } from "./paths-service.js";

export interface MergeStateInput {
  /** Inspect this repo path directly (absolute, or relative to cwd). Workspace-independent. */
  path?: string;
  /** Inspect the workspace source with this alias (requires a WORKSPACE block). */
  source?: string;
  /** Inspect every workspace source (requires a WORKSPACE block). */
  all?: boolean;
}

export interface RepoMergeState {
  /** Source alias when resolved from the workspace block; null for a direct path / cwd. */
  alias: string | null;
  path: string;
  is_repo: boolean;
  is_merging: boolean;
  /** Destination (ours) — the current branch. */
  current_branch: string | null;
  /** Origin (theirs) — the branch being merged in. */
  merge_origin: string | null;
  conflicted_files: string[];
  dirty: boolean;
}

export interface MergeStateOutput {
  repos: RepoMergeState[];
  any_merging: boolean;
}

/**
 * Read-only inspection of in-progress merge state, per repo. Workspace-independent:
 * a `path` (or cwd) inspects that repo without any WORKSPACE block; `--source`/`--all`
 * resolve sources from the block when present. Never throws on a reachable target —
 * a non-repo / unreadable target degrades to `is_repo:false`.
 */
export async function runMergeState(
  fs: FileSystemPort,
  git: GitPort,
  env: EnvPort,
  paths: PathsService,
  input: MergeStateInput = {},
): Promise<MergeStateOutput> {
  const targets = await resolveTargets(fs, env, paths, input);
  const repos: RepoMergeState[] = [];
  for (const t of targets) {
    repos.push(await inspectRepo(git, t.alias, t.path));
  }
  return { repos, any_merging: repos.some((r) => r.is_merging) };
}

async function resolveTargets(
  fs: FileSystemPort,
  env: EnvPort,
  paths: PathsService,
  input: MergeStateInput,
): Promise<{ alias: string | null; path: string }[]> {
  const cwd = env.cwd();
  if (input.path !== undefined) {
    const p = isAbsolute(input.path) ? input.path : join(cwd, input.path);
    return [{ alias: null, path: p }];
  }
  if (input.source !== undefined || input.all) {
    const fuentes = await readFuentes(fs, paths, cwd);
    if (input.source !== undefined) {
      const f = fuentes.find((x) => x.alias === input.source);
      return f ? [{ alias: f.alias, path: f.path }] : [];
    }
    return fuentes.map((f) => ({ alias: f.alias, path: f.path }));
  }
  return [{ alias: null, path: cwd }];
}

async function readFuentes(
  fs: FileSystemPort,
  paths: PathsService,
  cwd: string,
): Promise<{ alias: string; path: string }[]> {
  for (const file of [join(cwd, "CLAUDE.md"), join(cwd, "AGENTS.md")]) {
    try {
      if (!(await fs.exists(file))) continue;
      const block = parseProjectBlock(await fs.readText(file), paths.blockMarkers());
      if (block?.fuentes && block.fuentes.length > 0) {
        return block.fuentes.map((f) => ({ alias: f.alias, path: f.path }));
      }
    } catch {
      // no workspace / unreadable block → no sources (graceful)
    }
  }
  return [];
}

async function inspectRepo(
  git: GitPort,
  alias: string | null,
  path: string,
): Promise<RepoMergeState> {
  const is_repo = await safe(() => git.isGitRepo(path), false);
  if (!is_repo) {
    return {
      alias,
      path,
      is_repo: false,
      is_merging: false,
      current_branch: null,
      merge_origin: null,
      conflicted_files: [],
      dirty: false,
    };
  }
  const is_merging = await safe(() => git.isMerging(path), false);
  const current_branch = (await safe(() => git.currentBranch(path), undefined)) ?? null;
  const dirty = await safe(() => git.isDirty(path), false);
  const conflicted_files = is_merging ? await safe(() => git.conflictedFiles(path), []) : [];
  const merge_origin = is_merging
    ? ((await safe(() => git.mergeOrigin(path), undefined)) ?? null)
    : null;
  return {
    alias,
    path,
    is_repo: true,
    is_merging,
    current_branch,
    merge_origin,
    conflicted_files,
    dirty,
  };
}

async function safe<T>(fn: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await fn();
  } catch {
    return fallback;
  }
}
