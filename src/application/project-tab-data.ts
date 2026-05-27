// Data layer del nuevo "Proyecto" tab del TUI.
//
// Agrega información que el usuario necesita sin abrir ningún host de IA:
//
// - git status del workspace (branch, ahead/behind, dirty/staged/untracked, último commit)
// - ramas recientes (con flag `current`)
// - sources del bloque PROJECT (hub mode → varias filas)
// - sesiones activas (code, flow, name, phase, summary)
// - pendientes (items `- [ ]` agregados desde TASKS.md de cada sesión activa)
//
// Read-only puro: ningún side-effect en disco ni en remoto.

import { basename, join } from "node:path";
import type { EnvPort } from "../ports/env.js";
import type { FileSystemPort } from "../ports/file-system.js";
import type { GitPort } from "../ports/git.js";
import type { ProcessPort } from "../ports/process.js";
import { type ParsedProjectBlock, parseProjectBlock } from "./parsers/project-block.js";
import type { PathsService } from "./paths-service.js";
import { type SessionEntry, SessionsService } from "./sessions-service.js";

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

export interface ProjectSessionSummary {
  code: string;
  flow: string;
  name: string;
  phase: string;
  state: "active" | "closed" | "requirement";
  /** `## Type` del OBJECTIVE (feature/bugfix/…). Ausente si no declarado. */
  type?: string;
  /** Fecha de inicio (o mtime) de la sesión, para ordenar/mostrar recencia. */
  date?: string;
  summary?: string;
}

export interface ProjectPendingItem {
  /** Code de la sesión que lo origina */
  sessionCode: string;
  /** Slug + flow (ej. `dev/tui-redesign-crush`) */
  sessionLabel: string;
  /** Texto del item (sin el `- [ ]`) */
  text: string;
  /** Prioridad heurística por keywords (high/med/low) */
  prio: "high" | "med" | "low";
}

export interface ProjectTabData {
  workspaceName: string;
  workspaceMode: "project" | "hub";
  /** Path absoluto del workspace (cwd) */
  workspacePath: string;
  /**
   * True si el workspace tiene bloque AW-PROJECT en CLAUDE.md/AGENTS.md
   * (es decir, fue inicializado con project-init o hub-init).
   *
   * Cuando es false, el tab renderiza una landing con las opciones de init
   * en lugar del contenido completo.
   */
  initialized: boolean;
  /** Git data del repo primario (cwd en project mode, primera fuente en hub mode) */
  git: ProjectGitData | null;
  /** Ramas recientes ordenadas por last-commit-date desc */
  branches: ProjectBranch[];
  /** Sources declaradas (hub mode); vacío en project mode */
  sources: ProjectSource[];
  /** Sesiones (active + closed recientes) */
  sessions: ProjectSessionSummary[];
  /** Pendientes agregados de TASKS.md de sesiones activas */
  pending: ProjectPendingItem[];
  /** Si hubo error parcial fetcheando data */
  warnings: string[];
}

interface BuildOptions {
  /** Máximo de ramas a listar (default 5) */
  branchLimit?: number;
  /** Máximo de pendientes a listar (default 10) */
  pendingLimit?: number;
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
  const workspaceMode = block?.mode ?? "project";

  // Primary repo: en hub mode, primera source. En project mode, cwd.
  const primaryRepoPath =
    workspaceMode === "hub" && block && block.fuentes.length > 0
      ? (block.fuentes[0]?.path ?? cwd)
      : cwd;
  const primaryMainBranch =
    workspaceMode === "hub" && block && block.fuentes.length > 0
      ? (block.fuentes[0]?.main_branch ?? "main")
      : "main";

  // ===== Git data del repo primario =====
  const gitData = await safeRun(
    "git",
    () => buildGitData(git, proc, primaryRepoPath, primaryMainBranch),
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

  // ===== Sources (hub mode) =====
  const sources: ProjectSource[] = [];
  if (workspaceMode === "hub" && block) {
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

  // ===== Sessions =====
  // `state: "all"` es deliberado: necesitamos TODAS las sesiones para que el
  // tile `sessions` muestre el total real (no sólo activas) y para alimentar la
  // sección de sesiones recientes. `list({})` filtra a activas por default.
  const sessionsSvc = new SessionsService(fs, env, paths);
  const sessionsList = await safeRun(
    "sessions",
    () => sessionsSvc.list({ state: "all" }),
    warnings,
    {
      sessions: [] as SessionEntry[],
    } as Awaited<ReturnType<SessionsService["list"]>>,
  );
  const sessions: ProjectSessionSummary[] = sessionsList.sessions
    .filter(
      (s): s is SessionEntry & { code: string; flow: string } => s.code !== null && s.flow !== null,
    )
    .map((s) => {
      const item: ProjectSessionSummary = {
        code: s.code,
        flow: s.flow,
        name: s.name,
        phase: s.phase,
        state: s.state,
      };
      if (s.type !== undefined) item.type = s.type;
      if (s.date !== undefined) item.date = s.date;
      if (s.summary !== undefined) item.summary = s.summary;
      return item;
    });

  // ===== Pendings: parse `- [ ]` de TASKS.md en sesiones activas =====
  const pending = await safeRun(
    "pending",
    () =>
      buildPending(fs, paths.cwdSessionsDir(), sessionsList.sessions, options.pendingLimit ?? 10),
    warnings,
    [] as ProjectPendingItem[],
  );

  return {
    workspaceName,
    workspaceMode,
    workspacePath: cwd,
    initialized: block !== null,
    git: gitData,
    branches,
    sources,
    sessions,
    pending,
    warnings,
  };
}

// ---------- subfetchers ----------

async function buildGitData(
  git: GitPort,
  proc: ProcessPort,
  repoPath: string,
  mainBranch: string,
): Promise<ProjectGitData | null> {
  const isRepo = await git.isGitRepo(repoPath);
  if (!isRepo) return null;
  const branch = (await git.currentBranch(repoPath)) ?? "(detached)";

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

async function buildPending(
  fs: FileSystemPort,
  sessionsDir: string,
  sessions: SessionEntry[],
  limit: number,
): Promise<ProjectPendingItem[]> {
  const items: ProjectPendingItem[] = [];
  const active = sessions.filter((s) => s.state === "active" && s.code !== null);
  for (const s of active) {
    const tasksPath = join(sessionsDir, s.folder, "TASKS.md");
    if (!(await fs.exists(tasksPath))) continue;
    const content = await fs.readText(tasksPath).catch(() => null);
    if (!content) continue;
    const lines = content.split("\n");
    for (const raw of lines) {
      const line = raw.trim();
      // `- [ ] foo` o `| Tx | open | … | <texto> |`
      let text: string | null = null;
      const ck = line.match(/^[-*]\s+\[\s\]\s+(.+)$/);
      if (ck) {
        text = ck[1] ?? null;
      } else if (line.startsWith("|") && /\|\s*open\s*\|/i.test(line)) {
        const cols = line
          .split("|")
          .map((c) => c.trim())
          .filter((c) => c.length > 0);
        text = cols[cols.length - 1] ?? null; // last cell
        if (text && (text.startsWith("---") || text.toLowerCase() === "tarea")) text = null;
      }
      if (!text) continue;
      items.push({
        sessionCode: s.code ?? "?",
        sessionLabel: `${s.flow ?? "?"}/${s.name}`,
        text,
        prio: derivePrio(text),
      });
      if (items.length >= limit) return items;
    }
  }
  return items;
}

function derivePrio(text: string): "high" | "med" | "low" {
  const t = text.toLowerCase();
  if (/(bloque|blocker|crit|urgente|hotfix|seguridad|prod)/.test(t)) return "high";
  if (/(test|doc|cleanup|chore|nit|typo|opcional)/.test(t)) return "low";
  return "med";
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
