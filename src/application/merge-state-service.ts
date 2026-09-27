import { isAbsolute, join } from "node:path";
import { parseUnitPath, workspaceKey } from "../domain/isolation-unit.js";
import type { EnvPort } from "../ports/env.js";
import type { FileSystemPort } from "../ports/file-system.js";
import type { GitPort, WorktreeEntry } from "../ports/git.js";
import { readWorkspaceBlock } from "./parsers/project-block.js";
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
  /** Session folder when this repository is an isolation unit. */
  unit?: string;
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
  any_merging: boolean | null;
  unreadable: Array<{ alias: string | null; path: string | null; code: string; action: string }>;
  notes?: string[];
}

/**
 * Read-only inspection of in-progress merge state, per repo. Workspace-independent:
 * a `path` (or cwd) inspects that repo without any WORKSPACE block. An unreadable
 * target is never silently reported as "no merges".
 */
export async function runMergeState(
  fs: FileSystemPort,
  git: GitPort,
  env: EnvPort,
  paths: PathsService,
  input: MergeStateInput = {},
): Promise<MergeStateOutput> {
  const unreadable: MergeStateOutput["unreadable"] = [];
  const notes: string[] = [];
  const targets = await resolveTargets(fs, env, paths, input, unreadable);
  const repos: RepoMergeState[] = [];
  for (const t of targets) {
    if (!(await fs.exists(t.path))) {
      unreadable.push({
        alias: t.alias,
        path: t.path,
        code: "SOURCE_PATH_MISSING",
        action: `la ruta ${t.path} no existe en esta máquina: corregí la fuente o elegí una ruta existente`,
      });
      continue;
    }
    const repo = await inspectRepo(git, t.alias, t.path);
    if (repo === null) {
      unreadable.push({
        alias: t.alias,
        path: t.path,
        code: "SOURCE_UNREADABLE",
        action: `no se pudo consultar git en ${t.path}`,
      });
      continue;
    }
    repos.push(repo);
    if (t.alias === null || !repo.is_repo || (!input.all && input.source === undefined)) continue;
    let trees: WorktreeEntry[];
    try {
      trees = await git.worktreeList(t.path);
    } catch {
      unreadable.push({
        alias: t.alias,
        path: t.path,
        code: "UNIT_LIST_FAILED",
        action: `no se pudieron listar las unidades de ${t.alias}: revisá git worktree list`,
      });
      continue;
    }
    const root = await fs.realPath(paths.userUnitsDir()).catch(() => paths.userUnitsDir());
    for (const tree of trees) {
      const identity = parseUnitPath(root, tree.path);
      if (
        identity?.workspaceKey !== workspaceKey(paths.workspaceDir()) ||
        identity.alias !== t.alias
      )
        continue;
      if (tree.prunable) {
        notes.push(`Unidad ${identity.session} de ${t.alias} omitida: prunable (${tree.path})`);
        continue;
      }
      if (!(await fs.exists(tree.path))) {
        unreadable.push({
          alias: t.alias,
          path: tree.path,
          code: "SOURCE_PATH_MISSING",
          action: `la unidad ${identity.session} no existe en esta máquina`,
        });
        continue;
      }
      const unitRepo = await inspectRepo(git, t.alias, tree.path);
      if (unitRepo === null) {
        unreadable.push({
          alias: t.alias,
          path: tree.path,
          code: "SOURCE_UNREADABLE",
          action: `no se pudo consultar git en la unidad ${identity.session}`,
        });
      } else {
        repos.push({ ...unitRepo, unit: identity.session });
      }
    }
  }
  return {
    repos,
    any_merging: repos.some((r) => r.is_merging) ? true : unreadable.length ? null : false,
    unreadable,
    ...(notes.length ? { notes } : {}),
  };
}

async function resolveTargets(
  fs: FileSystemPort,
  _env: EnvPort,
  paths: PathsService,
  input: MergeStateInput,
  unreadable: MergeStateOutput["unreadable"],
): Promise<{ alias: string | null; path: string }[]> {
  const cwd = paths.workspaceDir();
  if (input.path !== undefined) {
    const p = isAbsolute(input.path) ? input.path : join(cwd, input.path);
    return [{ alias: null, path: p }];
  }
  if (input.source !== undefined || input.all) {
    let fuentes: Array<{ alias: string; path: string }> | undefined;
    try {
      const block = await readWorkspaceBlock(
        fs,
        cwd,
        paths.blockMarkers(),
        (b) => b.fuentes.length > 0,
      );
      fuentes = block?.fuentes;
    } catch {
      fuentes = undefined;
    }
    if (fuentes === undefined) {
      unreadable.push({
        alias: input.source ?? null,
        path: cwd,
        code: "SOURCES_BLOCK_MISSING",
        action: "declará las fuentes en el bloque WORKSPACE de AGENTS.md o CLAUDE.md",
      });
      return [];
    }
    if (input.source !== undefined) {
      const f = fuentes.find((x) => x.alias === input.source);
      if (!f)
        unreadable.push({
          alias: input.source,
          path: null,
          code: "SOURCE_UNKNOWN",
          action: `la fuente ${input.source} no está declarada; alias disponibles: ${fuentes.map((s) => s.alias).join(", ")}`,
        });
      return f ? [{ alias: f.alias, path: f.path }] : [];
    }
    return fuentes.map((f) => ({ alias: f.alias, path: f.path }));
  }
  return [{ alias: null, path: cwd }];
}

async function inspectRepo(
  git: GitPort,
  alias: string | null,
  path: string,
): Promise<RepoMergeState | null> {
  let is_repo: boolean;
  try {
    is_repo = await git.isGitRepo(path);
  } catch {
    return null;
  }
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
  let is_merging: boolean;
  try {
    is_merging = await git.isMerging(path);
  } catch {
    return null;
  }
  let current_branch: string | null;
  let dirty: boolean;
  let conflicted_files: string[];
  let merge_origin: string | null;
  try {
    current_branch = (await git.currentBranch(path)) ?? null;
    dirty = await git.isDirty(path);
    conflicted_files = is_merging ? await git.conflictedFiles(path) : [];
    merge_origin = is_merging ? ((await git.mergeOrigin(path)) ?? null) : null;
  } catch {
    return null;
  }
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
