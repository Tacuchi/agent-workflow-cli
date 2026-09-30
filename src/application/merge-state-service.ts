import { isAbsolute, join } from "node:path";
import { parseUnitPath, workspaceKey } from "../domain/isolation-unit.js";
import type { EnvPort } from "../ports/env.js";
import type { FileSystemPort } from "../ports/file-system.js";
import type { GitPort, WorktreeEntry } from "../ports/git.js";
import {
  type ProjectFuente,
  readWorkspaceBlock,
  requireSourcePath,
} from "./parsers/project-block.js";
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
  error?: string;
  error_code?: "SOURCE_PATH_MISSING";
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
        action:
          t.alias === null
            ? `la ruta ${t.path} no existe en esta máquina: elegí una ruta existente`
            : `la ruta de la fuente ${t.alias} no existe en este host: declárala con aw add-source ${t.alias}:<ruta>`,
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
    await inspectSourceUnits(fs, git, paths, t, repos, unreadable, notes);
  }
  return {
    repos,
    any_merging: mergeSummary(repos, unreadable),
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
    return resolveSourceTargets(fs, paths, input, unreadable);
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

async function inspectSourceUnits(
  fs: FileSystemPort,
  git: GitPort,
  paths: PathsService,
  t: { alias: string | null; path: string },
  repos: RepoMergeState[],
  unreadable: MergeStateOutput["unreadable"],
  notes: string[],
): Promise<void> {
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
    return;
  }
  const root = await fs.realPath(paths.userUnitsDir()).catch(() => paths.userUnitsDir());
  for (const tree of trees) {
    const identity = parseUnitPath(root, tree.path);
    if (identity?.workspaceKey !== workspaceKey(paths.workspaceDir()) || identity.alias !== t.alias)
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

async function resolveSourceTargets(
  fs: FileSystemPort,
  paths: PathsService,
  input: MergeStateInput,
  unreadable: MergeStateOutput["unreadable"],
): Promise<{ alias: string | null; path: string }[]> {
  const cwd = paths.workspaceDir();
  let fuentes: ProjectFuente[] | undefined;
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
    if (f === undefined) {
      unreadable.push({
        alias: input.source,
        path: null,
        code: "SOURCE_UNKNOWN",
        action: `la fuente ${input.source} no está declarada; alias disponibles: ${fuentes.map((s) => s.alias).join(", ")}`,
      });
      return [];
    }
  }
  return sourcePaths(fs, fuentes, input, unreadable);
}

async function sourcePaths(
  fs: FileSystemPort,
  fuentes: ProjectFuente[],
  input: MergeStateInput,
  unreadable: MergeStateOutput["unreadable"],
): Promise<{ alias: string; path: string }[]> {
  const targets: Array<{ alias: string; path: string }> = [];
  for (const fuente of fuentes) {
    if (input.source !== undefined && fuente.alias !== input.source) continue;
    try {
      targets.push({ alias: fuente.alias, path: await requireSourcePath(fs, fuente) });
    } catch (err) {
      unreadable.push({
        alias: fuente.alias,
        path: fuente.path,
        code: "SOURCE_PATH_MISSING",
        action: (err as Error).message,
      });
    }
  }
  return targets;
}

function mergeSummary(
  repos: RepoMergeState[],
  unreadable: MergeStateOutput["unreadable"],
): boolean | null {
  return repos.some((r) => r.is_merging) ? true : unreadable.length ? null : false;
}
