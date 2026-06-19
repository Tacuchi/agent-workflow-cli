// Data layer del tab WORKSPACE del TUI.
//
// Agrega la información del workspace que el usuario necesita sin abrir ningún
// host de IA:
//
// - git status del repo primario (branch, ahead/behind, dirty/staged/untracked, último commit)
// - ramas recientes (con flag `current`)
// - sources declaradas (alias / path / rama principal)
// - ramas de trabajo actuales (working_branches por alias del bloque WORKSPACE)
//
// No hay distinción project/hub: un workspace simplemente tiene 1+ fuentes.
// Read-only puro: ningún side-effect en disco ni en remoto.

import { basename, join } from "node:path";
import type { EnvPort } from "../ports/env.js";
import type { FileSystemPort } from "../ports/file-system.js";
import type { GitPort } from "../ports/git.js";
import type { ProcessPort } from "../ports/process.js";
import { type ParsedProjectBlock, parseProjectBlock } from "./parsers/project-block.js";
import type { PathsService } from "./paths-service.js";

export interface ProjectGitData {
  branch: string;
  base: string;
  ahead: number;
  behind: number;
  dirty: number;
  staged: number;
  untracked: number;
  lastCommit: ProjectCommit | null;
}

export interface ProjectCommit {
  sha: string;
  title: string;
  author: string;
  /** ISO 8601 */
  whenIso: string;
  /** Texto humano relativo, ej "hace 2 h" */
  whenRel: string;
}

export interface ProjectBranch {
  name: string;
  current: boolean;
  ahead: number;
  /** Texto humano relativo del último commit */
  whenRel: string | null;
}

export interface ProjectSource {
  alias: string;
  path: string;
  branch: string | null;
  mainBranch: string;
  dirty: boolean;
  changedFiles: number;
}

export interface ProjectTabData {
  workspaceName: string;
  /** Path absoluto del workspace (cwd) */
  workspacePath: string;
  /**
   * True si el workspace tiene bloque WORKSPACE en CLAUDE.md/AGENTS.md
   * (es decir, fue inicializado con workspace-init).
   *
   * Cuando es false, el tab renderiza una landing con la opción de init
   * en lugar del contenido completo.
   */
  initialized: boolean;
  /** Git data del repo primario (cwd, o la primera fuente declarada) */
  git: ProjectGitData | null;
  /** Ramas recientes ordenadas por last-commit-date desc */
  branches: ProjectBranch[];
  /** Sources declaradas (alias / path / rama principal) */
  sources: ProjectSource[];
  /** Ramas de trabajo actuales por alias de fuente (bloque WORKSPACE > Status) */
  workingBranches: Record<string, string>;
  /** Si hubo error parcial fetcheando data */
  warnings: string[];
}

interface BuildOptions {
  /** Máximo de ramas a listar (default 5) */
  branchLimit?: number;
}

export interface ProjectTabDataDeps {
  fs: FileSystemPort;
  env: EnvPort;
  git: GitPort;
  process: ProcessPort;
  paths: PathsService;
}

/**
 * Construye toda la data del tab Proyecto en una pasada.
 *
 * Cada subfetch atrapa errores propios para no tumbar el render — si por
 * ejemplo `git log` falla, el resto del payload sigue válido y la falla queda
 * en `warnings[]`.
 */
export async function buildProjectTabData(
  deps: ProjectTabDataDeps,
  options: BuildOptions = {},
): Promise<ProjectTabData> {
  const { fs, env, git, process: proc, paths } = deps;
  const cwd = env.cwd();
  const warnings: string[] = [];

  const block = await safeRun(
    "read-project-block",
    () => readProjectBlock(fs, cwd, paths),
    warnings,
    null as ParsedProjectBlock | null,
  );

  const workspaceName = block?.proyecto || basename(cwd);

  // Repo primario: la primera fuente declarada (si hay), si no el cwd.
  const primaryRepoPath = block && block.fuentes.length > 0 ? (block.fuentes[0]?.path ?? cwd) : cwd;
  const primaryMainBranch =
    block && block.fuentes.length > 0 ? (block.fuentes[0]?.main_branch ?? "main") : "main";
  // El tile GIT debe mostrar la rama de trabajo DEFINIDA en el workspace para la
  // fuente primaria, no la que el repo tenga checked out (puede ser cualquiera).
  const definedWorkingBranch = resolveDefinedWorkingBranch(block);

  // ===== Git data del repo primario =====
  const gitData = await safeRun(
    "git",
    () => buildGitData(git, proc, primaryRepoPath, primaryMainBranch, definedWorkingBranch),
    warnings,
    null,
  );

  // ===== Ramas recientes =====
  const branches = await safeRun(
    "branches",
    () => buildBranches(proc, primaryRepoPath, options.branchLimit ?? 5),
    warnings,
    [] as ProjectBranch[],
  );

  // ===== Sources (todas las fuentes declaradas) =====
  const sources: ProjectSource[] = [];
  if (block) {
    for (const f of block.fuentes) {
      const repoPath = f.path;
      const isRepo = await safeRun(
        `is-repo:${f.alias}`,
        () => git.isGitRepo(repoPath),
        warnings,
        false,
      );
      if (!isRepo) continue;
      const branch = await safeRun(
        `branch:${f.alias}`,
        () => git.currentBranch(repoPath),
        warnings,
        undefined,
      );
      const changed = await safeRun(
        `dirty:${f.alias}`,
        () => git.changedFiles(repoPath),
        warnings,
        [] as string[],
      );
      sources.push({
        alias: f.alias,
        path: f.path,
        branch: branch ?? null,
        mainBranch: f.main_branch,
        dirty: changed.length > 0,
        changedFiles: changed.length,
      });
    }
  }

  return {
    workspaceName,
    workspacePath: cwd,
    initialized: block !== null,
    git: gitData,
    branches,
    sources,
    workingBranches: block?.working_branches ?? {},
    warnings,
  };
}

// ---------- subfetchers ----------

async function buildGitData(
  git: GitPort,
  proc: ProcessPort,
  repoPath: string,
  mainBranch: string,
  workBranch?: string,
): Promise<ProjectGitData | null> {
  const isRepo = await git.isGitRepo(repoPath);
  if (!isRepo) return null;
  // `workBranch` (rama de trabajo definida en el hub) tiene prioridad sobre la
  // rama checked out: el tile GIT representa el trabajo del hub, no el HEAD
  // accidental del source. ahead/behind se calcula contra la rama mostrada.
  const branch = workBranch ?? (await git.currentBranch(repoPath)) ?? "(detached)";

  // ahead/behind vs `origin/<mainBranch>` — fallback a 0/0 si fail
  const aheadBehind = await runProc(
    proc,
    "git",
    ["rev-list", "--left-right", "--count", `origin/${mainBranch}...${branch}`],
    repoPath,
  );
  let ahead = 0;
  let behind = 0;
  if (aheadBehind.ok && aheadBehind.stdout) {
    const parts = aheadBehind.stdout.trim().split(/\s+/);
    behind = Number.parseInt(parts[0] ?? "0", 10) || 0;
    ahead = Number.parseInt(parts[1] ?? "0", 10) || 0;
  }

  const status = await runProc(proc, "git", ["status", "--porcelain=v1"], repoPath);
  let dirty = 0;
  let staged = 0;
  let untracked = 0;
  if (status.ok) {
    for (const line of status.stdout.split("\n")) {
      if (line.length === 0) continue;
      const x = line[0];
      const y = line[1];
      if (x === "?" && y === "?") {
        untracked++;
      } else {
        dirty++;
        if (x !== " " && x !== "?") staged++;
      }
    }
  }

  const last = await runProc(
    proc,
    "git",
    ["log", "-1", "--pretty=%H%x09%s%x09%an%x09%aI%x09%ar"],
    repoPath,
  );
  let lastCommit: ProjectCommit | null = null;
  if (last.ok && last.stdout) {
    const parts = last.stdout.trim().split("\t");
    if (parts.length >= 5 && parts[0] && parts[1] && parts[2] && parts[3] && parts[4]) {
      lastCommit = {
        sha: parts[0].slice(0, 7),
        title: parts[1],
        author: parts[2],
        whenIso: parts[3],
        whenRel: parts[4],
      };
    }
  }

  return {
    branch,
    base: mainBranch,
    ahead,
    behind,
    dirty,
    staged,
    untracked,
    lastCommit,
  };
}

async function buildBranches(
  proc: ProcessPort,
  repoPath: string,
  limit: number,
): Promise<ProjectBranch[]> {
  const out = await runProc(
    proc,
    "git",
    [
      "for-each-ref",
      `--count=${limit + 4}`,
      "--sort=-committerdate",
      "--format=%(HEAD)%09%(refname:short)%09%(committerdate:iso8601)%09%(committerdate:relative)",
      "refs/heads",
    ],
    repoPath,
  );
  if (!out.ok) return [];
  const branches: ProjectBranch[] = [];
  for (const line of out.stdout.split("\n")) {
    if (!line) continue;
    const parts = line.split("\t");
    if (parts.length < 4) continue;
    const head = parts[0]?.trim() === "*";
    const name = parts[1]?.trim() ?? "";
    const whenRel = parts[3]?.trim() ?? null;
    if (!name) continue;
    branches.push({ name, current: head, ahead: 0, whenRel });
    if (branches.length >= limit) break;
  }
  return branches;
}

// ---------- utils ----------

async function safeRun<T>(
  label: string,
  fn: () => Promise<T>,
  warnings: string[],
  fallback: T,
): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    warnings.push(`${label}: ${(err as Error).message}`);
    return fallback;
  }
}

async function runProc(
  proc: ProcessPort,
  cmd: string,
  args: string[],
  cwd: string,
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  const res = await proc.run(cmd, args, { cwd });
  return { ok: res.code === 0, stdout: res.stdout, stderr: res.stderr };
}

/**
 * Rama de trabajo a mostrar en el tile GIT.
 *
 * El tile representa el repo primario (`fuentes[0]`), pero su label debe ser la
 * rama de trabajo DEFINIDA en el workspace (sección `## Status > Ramas de trabajo
 * actuales`), no la rama que la fuente tenga checked out. Así el tile no cambia
 * según en qué rama estén las fuentes.
 *
 * Devuelve `undefined` cuando no hay rama de trabajo declarada para la fuente
 * primaria → el caller cae a la rama actual del repo.
 */
export function resolveDefinedWorkingBranch(block: ParsedProjectBlock | null): string | undefined {
  if (!block) return undefined;
  const primaryAlias = block.fuentes[0]?.alias;
  if (primaryAlias === undefined) return undefined;
  return block.working_branches[primaryAlias];
}

// Helper local — refleja `readProjectBlock` privado de sources-service.ts.
async function readProjectBlock(
  fs: FileSystemPort,
  cwd: string,
  paths: PathsService,
): Promise<ParsedProjectBlock | null> {
  for (const file of [join(cwd, "CLAUDE.md"), join(cwd, "AGENTS.md")]) {
    if (!(await fs.exists(file))) continue;
    const block = parseProjectBlock(await fs.readText(file), paths.blockMarkers());
    if (block) return block;
  }
  return null;
}
