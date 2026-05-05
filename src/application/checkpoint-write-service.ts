import { join } from "node:path";
import type { EnvPort } from "../ports/env.js";
import type { DirEntry, FileSystemPort } from "../ports/file-system.js";
import type { DiffNumstatEntry, GitPort } from "../ports/git.js";
import { findActiveSessions } from "./checkpoint-service.js";
import { parseProjectBlock } from "./parsers/project-block.js";
import type { PathsService } from "./paths-service.js";

const PLACEHOLDER_MARKER = "_[AI:";

const PHASE_INDEX: Record<string, string> = {
  planning: "1/4",
  planificacion: "1/4",
  requerimiento: "1/4",
  plan: "1/4",
  execution: "2/4",
  ejecucion: "2/4",
  implementacion: "2/4",
  validation: "3/4",
  validacion: "3/4",
  closure: "4/4",
  cierre: "4/4",
};

interface SessionState {
  code: string | null;
  flow: string | null;
  name: string;
  folder: string;
  phase: string | null;
  branches: string[];
  tasks: { open: number; closed: number; total: number };
  progress_pct: number | null;
  decisions_count: number;
  last_decision: { id: string; excerpt: string } | null;
  artefacts: Record<string, boolean | number>;
  files_touched: DiffNumstatEntry[];
  origen: string | null;
  timestamp: string;
}

export interface CheckpointWriteOutput {
  session: string;
  checkpoint_path: string;
  lines_written?: number;
  phase?: string | null;
  progress_pct?: number | null;
  tasks_open?: number;
  tasks_closed?: number;
  files_touched_count?: number;
  skipped?: boolean;
  reason?: string;
}

export interface CheckpointWriteSkipped {
  skipped: true;
  reason: string;
  active_sessions?: string[];
}

export async function runCheckpointWrite(
  fs: FileSystemPort,
  env: EnvPort,
  git: GitPort,
  paths: PathsService,
  options: { code?: string; force?: boolean } = {},
): Promise<CheckpointWriteOutput | CheckpointWriteSkipped> {
  const cwd = env.cwd();
  const folder = await resolveTargetFolder(fs, env, paths, options.code);
  if (!folder) {
    const actives = await findActiveSessions(fs, cwd);
    if (actives.length === 0) {
      return { skipped: true, reason: "no hay sesiones activas en QTC-PROJECT.Status" };
    }
    return {
      skipped: true,
      reason: "múltiples sesiones activas; especificá --code <CODE>",
      active_sessions: actives.map((a) => a.folder),
    };
  }

  const sessionPath = join(paths.cwdSessionsDir(), folder);
  if (!(await fs.exists(sessionPath))) {
    throw new Error(`folder no existe: ${sessionPath}`);
  }
  const cpPath = join(sessionPath, "CHECKPOINT.md");

  if ((await fs.exists(cpPath)) && options.force !== true) {
    const existing = await fs.readText(cpPath);
    if (!existing.includes(PLACEHOLDER_MARKER)) {
      return {
        session: folder,
        checkpoint_path: cpPath,
        skipped: true,
        reason:
          "CHECKPOINT.md ya está sintetizado (sin placeholders); pasar --force para regenerar",
      };
    }
  }

  const state = await extractSessionState(fs, git, cwd, paths, sessionPath);
  const md = formatCheckpointMd(state);
  await fs.mkdirp(sessionPath);
  await fs.writeText(cpPath, md);

  return {
    session: folder,
    checkpoint_path: cpPath,
    // Mirror Python str.splitlines() which doesn't count trailing empty.
    lines_written: md.replace(/\n$/, "").split("\n").length,
    phase: state.phase,
    progress_pct: state.progress_pct,
    tasks_open: state.tasks.open,
    tasks_closed: state.tasks.closed,
    files_touched_count: state.files_touched.length,
  };
}

async function resolveTargetFolder(
  fs: FileSystemPort,
  env: EnvPort,
  paths: PathsService,
  code: string | undefined,
): Promise<string | null> {
  if (code) {
    const sessionsDir = paths.cwdSessionsDir();
    if (!(await fs.exists(sessionsDir))) return null;
    const entries = await fs.list(sessionsDir);
    const norm = code.replace("session", "").split("-")[0]?.padStart(3, "0") ?? code;
    for (const entry of entries) {
      if (entry.type !== "dir") continue;
      const m = entry.name.match(/^session(\d{3})-/);
      if (m?.[1] === norm) return entry.name;
    }
    return null;
  }
  const actives = await findActiveSessions(fs, env.cwd());
  return actives.length === 1 ? (actives[0]?.folder ?? null) : null;
}

async function extractSessionState(
  fs: FileSystemPort,
  git: GitPort,
  cwd: string,
  paths: PathsService,
  sessionPath: string,
): Promise<SessionState> {
  const folder = sessionPath.split(/[\\/]/).pop() ?? "";
  const parsed = parseSessionFolder(folder);
  const { phase, branches } = await readPhaseFromBlock(fs, cwd, paths, folder);

  const tasks = await countTasks(fs, sessionPath);
  const progressPct = tasks.total > 0 ? Math.round((100 * tasks.closed) / tasks.total) : null;
  const decisions = await countDecisions(fs, sessionPath);
  const lastDecision = await readLastDecision(fs, sessionPath);
  const artefacts = await listArtefacts(fs, sessionPath);
  const filesTouched = await git.diffNumstat(cwd);
  const origen = await readOrigen(fs, sessionPath);

  return {
    code: parsed.code,
    flow: parsed.flow,
    name: parsed.name,
    folder,
    phase,
    branches,
    tasks,
    progress_pct: progressPct,
    decisions_count: decisions,
    last_decision: lastDecision,
    artefacts,
    files_touched: filesTouched,
    origen,
    timestamp: formatNowMinute(),
  };
}

function parseSessionFolder(folder: string): {
  code: string | null;
  flow: string | null;
  name: string;
} {
  const m = folder.match(/^session(\d{3})-(.+)/);
  if (!m || !m[1] || !m[2]) return { code: null, flow: null, name: folder };
  const parts = m[2].split("-");
  if (parts.length >= 2 && ["dev", "design", "analyze", "core"].includes(parts[0] ?? "")) {
    return { code: m[1], flow: parts[0] ?? null, name: parts.slice(1).join("-") };
  }
  return { code: m[1], flow: null, name: m[2] };
}

async function readPhaseFromBlock(
  fs: FileSystemPort,
  cwd: string,
  paths: PathsService,
  folder: string,
): Promise<{ phase: string | null; branches: string[] }> {
  for (const file of [join(cwd, "CLAUDE.md"), join(cwd, "AGENTS.md")]) {
    if (!(await fs.exists(file))) continue;
    const block = parseProjectBlock(await fs.readText(file), paths.blockMarkers());
    if (!block) continue;
    for (const s of block.sessions) {
      if (s.folder === folder) return { phase: s.phase, branches: s.branches };
    }
  }
  return { phase: null, branches: [] };
}

async function countTasks(
  fs: FileSystemPort,
  sessionPath: string,
): Promise<{ open: number; closed: number; total: number }> {
  const path = join(sessionPath, "TASKS.md");
  if (!(await fs.exists(path))) return { open: 0, closed: 0, total: 0 };
  const text = await fs.readText(path);
  const open = (text.match(/^\s*[-*]\s*\[\s\]/gm) ?? []).length;
  const closed = (text.match(/^\s*[-*]\s*\[[xX]\]/gm) ?? []).length;
  return { open, closed, total: open + closed };
}

async function countDecisions(fs: FileSystemPort, sessionPath: string): Promise<number> {
  const path = join(sessionPath, "DECISIONES.md");
  if (!(await fs.exists(path))) return 0;
  const text = await fs.readText(path);
  return (text.match(/^#{2,3}\s+DEC[- ]\d+/gm) ?? []).length;
}

async function readLastDecision(
  fs: FileSystemPort,
  sessionPath: string,
): Promise<{ id: string; excerpt: string } | null> {
  const path = join(sessionPath, "DECISIONES.md");
  if (!(await fs.exists(path))) return null;
  const text = await fs.readText(path);
  const matches = [...text.matchAll(/^#{2,3}\s+(DEC[- ]\d+[^\n]*)$/gm)];
  if (matches.length === 0) return null;
  const last = matches[matches.length - 1];
  if (!last || !last[1]) return null;
  const id = last[1].trim();
  const restStart = (last.index ?? 0) + last[0].length;
  const rest = text.slice(restStart);
  const body = rest.split("\n##", 1)[0] ?? "";
  const firstLine =
    body
      .split("\n")
      .map((l) => l.trim())
      .find((l) => l.length > 0) ?? "";
  return { id, excerpt: firstLine.slice(0, 140) };
}

async function listArtefacts(
  fs: FileSystemPort,
  sessionPath: string,
): Promise<Record<string, boolean | number>> {
  const has = async (name: string) => fs.exists(join(sessionPath, name));
  const scriptsDir = join(sessionPath, "scripts");
  const scriptsCount = (await fs.exists(scriptsDir))
    ? (await listSqlFiles(fs, scriptsDir)).length
    : 0;
  return {
    objetivo: await has("OBJETIVO.md"),
    tasks: await has("TASKS.md"),
    decisiones: await has("DECISIONES.md"),
    dependencias: await has("DEPENDENCIAS.md"),
    entrega: await has("ENTREGA.md"),
    evidencia: await has("EVIDENCIA.md"),
    hallazgos: await has("HALLAZGOS.md"),
    recomendacion: await has("RECOMENDACION.md"),
    scripts_count: scriptsCount,
  };
}

async function listSqlFiles(fs: FileSystemPort, dir: string): Promise<string[]> {
  const entries: DirEntry[] = await fs.list(dir);
  const result: string[] = [];
  for (const entry of entries) {
    if (entry.type === "file" && entry.name.endsWith(".sql")) {
      result.push(entry.name);
    }
  }
  return result.sort();
}

async function readOrigen(fs: FileSystemPort, sessionPath: string): Promise<string | null> {
  const path = join(sessionPath, "OBJETIVO.md");
  if (!(await fs.exists(path))) return null;
  const text = await fs.readText(path);
  const lines = text.split("\n");
  let inOrigen = false;
  for (const line of lines) {
    if (line.match(/^##\s+Origen\s*$/i)) {
      inOrigen = true;
      continue;
    }
    if (inOrigen) {
      if (line.startsWith("##")) break;
      const trimmed = line.trim();
      if (trimmed.length > 0) return trimmed.slice(0, 140);
    }
  }
  return null;
}

function formatCheckpointMd(state: SessionState): string {
  const lines: string[] = [];
  appendHeader(lines, state);
  appendDecisions(lines, state);
  appendFilesTouched(lines, state);
  appendContext(lines);
  appendRefs(lines, state);
  lines.push("", `<!-- escrito por qtc-core.checkpoint en ${state.timestamp} -->`, "");
  return lines.join("\n");
}

function appendHeader(lines: string[], state: SessionState): void {
  const phase = state.phase ?? "?";
  const phaseIdx = PHASE_INDEX[phase.toLowerCase()] ?? "?/4";
  const progress = state.progress_pct;
  const progressLine =
    progress !== null
      ? `${progress}% (${state.tasks.closed} de ${state.tasks.total} tareas completas)`
      : "_avance no determinado (TASKS.md ausente o vacío)_";
  lines.push(
    `# Checkpoint — ${state.folder}`,
    "",
    `- Actualizado: ${state.timestamp}`,
    `- Fase actual: ${phase} (${phaseIdx})`,
    `- Avance: ${progressLine}`,
    "",
    "## Lo último que hice",
    "",
    "_[AI: 1-3 oraciones del último avance concreto. Revisa últimos diffs y la última entrada de DECISIONES.md.]_",
    "",
    "## Próximo paso",
    "",
    "_[AI: 1-2 oraciones de qué hace falta hacer. Revisa primer item abierto en TASKS.md.]_",
    "",
  );
}

function appendDecisions(lines: string[], state: SessionState): void {
  lines.push("## Decisiones recientes", "");
  if (state.last_decision) {
    lines.push(`- ${state.last_decision.id}: ${state.last_decision.excerpt}`);
  } else {
    lines.push("_Sin decisiones registradas._");
  }
}

function appendFilesTouched(lines: string[], state: SessionState): void {
  lines.push("", "## Archivos tocados (post-último-commit)", "");
  const files = state.files_touched;
  if (files.length === 0) {
    lines.push("_Sin cambios sin commitear detectados en el cwd._");
    return;
  }
  for (const f of files.slice(0, 20)) {
    lines.push(`- ${f.path} (+${f.added} -${f.removed}) — _[AI: propósito en 1 línea]_`);
  }
  if (files.length > 20) {
    lines.push(`- _… y ${files.length - 20} más_`);
  }
}

function appendContext(lines: string[]): void {
  lines.push("", "## Contexto crítico para retomar", "");
  lines.push(
    "_[AI: 2-3 párrafos con la info mínima para continuar sin re-explorar. Qué descubriste, qué decisiones quedaron tomadas, qué hay que tener presente.]_",
  );
}

function appendRefs(lines: string[], state: SessionState): void {
  lines.push("", "## Refs", "");
  if (state.origen) lines.push(`- Origen: ${state.origen}`);
  if (state.branches.length > 0) lines.push(`- Ramas: ${state.branches.join(", ")}`);
  const present = collectArtefacts(state.artefacts);
  if (present.length > 0) {
    lines.push(`- Artefactos presentes: ${present.join(", ")}`);
  }
  lines.push("- Skills usadas: _[AI: enumera las skills invocadas durante la sesión]_");
}

function collectArtefacts(artefacts: Record<string, boolean | number>): string[] {
  const present: string[] = [];
  for (const [k, v] of Object.entries(artefacts)) {
    if (k === "scripts_count") continue;
    if (v === true) present.push(k);
  }
  const scriptsCount = artefacts.scripts_count;
  if (typeof scriptsCount === "number" && scriptsCount > 0) {
    present.push(`scripts(${scriptsCount})`);
  }
  return present;
}

function formatNowMinute(): string {
  const now = new Date();
  const yyyy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const dd = String(now.getDate()).padStart(2, "0");
  const hh = String(now.getHours()).padStart(2, "0");
  const mi = String(now.getMinutes()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd} ${hh}:${mi}`;
}

export interface AutoCompactOnCloseOutput {
  checkpoints_written: Array<{
    session?: string;
    checkpoint_path?: string;
    phase?: string | null;
    progress_pct?: number | null;
    skipped?: boolean;
    reason?: string;
    error?: string;
  }>;
}

export interface AutoCompactOnCloseSkipped {
  skipped: true;
  reason: string;
}

export async function runAutoCompactOnClose(
  fs: FileSystemPort,
  env: EnvPort,
  git: GitPort,
  paths: PathsService,
): Promise<AutoCompactOnCloseOutput | AutoCompactOnCloseSkipped> {
  const cwd = env.cwd();
  const actives = await findActiveSessions(fs, cwd);
  if (actives.length === 0) {
    return { skipped: true, reason: "no hay sesiones activas" };
  }
  const written: AutoCompactOnCloseOutput["checkpoints_written"] = [];
  for (const a of actives) {
    const entry = await writeCheckpointForActive(fs, git, cwd, paths, a.folder);
    if (entry) written.push(entry);
  }
  return { checkpoints_written: written };
}

async function writeCheckpointForActive(
  fs: FileSystemPort,
  git: GitPort,
  cwd: string,
  paths: PathsService,
  folder: string,
): Promise<AutoCompactOnCloseOutput["checkpoints_written"][number] | null> {
  if (!folder) return null;
  const sessionPath = join(paths.cwdSessionsDir(), folder);
  if (!(await fs.exists(sessionPath))) return null;
  const cpPath = join(sessionPath, "CHECKPOINT.md");
  if (await fs.exists(cpPath)) {
    const existing = await fs.readText(cpPath);
    if (!existing.includes(PLACEHOLDER_MARKER)) {
      return {
        session: folder,
        checkpoint_path: cpPath,
        skipped: true,
        reason: "CHECKPOINT.md ya sintetizado",
      };
    }
  }
  try {
    const state = await extractSessionState(fs, git, cwd, paths, sessionPath);
    const md = formatCheckpointMd(state);
    await fs.mkdirp(sessionPath);
    await fs.writeText(cpPath, md);
    return {
      session: folder,
      checkpoint_path: cpPath,
      phase: state.phase,
      progress_pct: state.progress_pct,
    };
  } catch (err) {
    return {
      session: folder,
      error: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
    };
  }
}
