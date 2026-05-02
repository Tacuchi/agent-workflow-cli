import { join } from "node:path";
import type { EnvPort } from "../ports/env.js";
import type { FileSystemPort } from "../ports/file-system.js";
import { parseProjectBlock } from "./parsers/project-block.js";
import { resolveSession } from "./session-resolver.js";

const PHASE_ORDER = ["planning", "execution", "validation", "closure"] as const;

const LEGACY_PHASE_MAP: Record<string, string> = {
  requerimiento: "planning",
  plan: "planning",
  implementacion: "execution",
  implementación: "execution",
  validacion: "validation",
  validación: "validation",
  cierre: "closure",
  brief: "planning",
  discover: "execution",
  "define-develop": "execution",
  "define+develop": "execution",
  develop: "execution",
  deliver: "execution",
  pregunta: "planning",
  exploracion: "execution",
  exploración: "execution",
  sintesis: "execution",
  síntesis: "execution",
  recomendacion: "execution",
  recomendación: "execution",
};

export function normalizePhase(raw: string | undefined | null): string | null {
  if (!raw) return null;
  const norm = raw.trim().toLowerCase();
  if ((PHASE_ORDER as readonly string[]).includes(norm)) return norm;
  return LEGACY_PHASE_MAP[norm] ?? null;
}

interface TaskCounts {
  pendientes: number;
  en_progreso: number;
  completadas: number;
}

function countTasks(text: string): TaskCounts {
  if (!text) return { pendientes: 0, en_progreso: 0, completadas: 0 };
  const pend = (text.match(/^\s*-\s*\[\s*\]/gm) ?? []).length;
  const prog = (text.match(/^\s*-\s*\[~\]/gm) ?? []).length;
  const done = (text.match(/^\s*-\s*\[[xX]\]/gm) ?? []).length;
  return { pendientes: pend, en_progreso: prog, completadas: done };
}

export interface PhaseDetectOutput {
  code: string;
  folder: string;
  current_phase_in_qtc_project: string | null;
  suggested_phase: string;
  divergent: boolean;
  signals: {
    objetivo_exists: boolean;
    objetivo_has_criteria: boolean;
    tasks_counts: TaskCounts;
    has_scripts_sql: boolean;
  };
}

export interface PhaseDetectError {
  error: string;
}

export async function runPhaseDetect(
  fs: FileSystemPort,
  env: EnvPort,
  code: string | undefined,
): Promise<PhaseDetectOutput | PhaseDetectError> {
  if (!code) return { error: "--code es obligatorio" };
  const session = await resolveSession(fs, env, code, true);
  if (!session) return { error: `Sesión no encontrada: ${code}` };

  const objetivo = await loadObjetivo(fs, session.path);
  const counts = await loadTaskCounts(fs, session.path);
  const hasScripts = await hasAnyScript(fs, session.path);
  const currentInQtc = await readPhaseFromBlock(fs, env.cwd(), session.folder);
  const suggested = pickSuggested(objetivo, counts, hasScripts, currentInQtc);

  return {
    code: session.code ?? code,
    folder: session.folder,
    current_phase_in_qtc_project: currentInQtc,
    suggested_phase: suggested,
    divergent: divergesFrom(currentInQtc, suggested),
    signals: {
      objetivo_exists: objetivo.exists,
      objetivo_has_criteria: objetivo.hasCriteria,
      tasks_counts: counts,
      has_scripts_sql: hasScripts,
    },
  };
}

interface ObjetivoState {
  exists: boolean;
  text: string;
  hasCriteria: boolean;
}

async function loadObjetivo(fs: FileSystemPort, sessionPath: string): Promise<ObjetivoState> {
  const objetivoPath = join(sessionPath, "OBJETIVO.md");
  const exists = await fs.exists(objetivoPath);
  let text = "";
  if (exists) {
    text = await fs.readText(objetivoPath);
  } else {
    const reqPath = join(sessionPath, "REQUIREMENTS.md");
    if (await fs.exists(reqPath)) text = await fs.readText(reqPath);
  }
  const hasCriteria = text.includes("[ ]") || text.toLowerCase().includes("[x]");
  return { exists, text, hasCriteria };
}

async function loadTaskCounts(fs: FileSystemPort, sessionPath: string): Promise<TaskCounts> {
  const tasksPath = join(sessionPath, "TASKS.md");
  const tasksText = (await fs.exists(tasksPath)) ? await fs.readText(tasksPath) : "";
  return countTasks(tasksText);
}

async function hasAnyScript(fs: FileSystemPort, sessionPath: string): Promise<boolean> {
  const scriptsDir = join(sessionPath, "scripts");
  return (await fs.exists(scriptsDir)) && (await hasAnySql(fs, scriptsDir));
}

function pickSuggested(
  obj: ObjetivoState,
  counts: TaskCounts,
  hasScripts: boolean,
  currentInQtc: string | null,
): string {
  if (!obj.exists || obj.text.trim().length === 0) return "planning";
  const hasTasks = counts.pendientes + counts.en_progreso + counts.completadas > 0;
  const hasOpen = counts.pendientes + counts.en_progreso > 0;
  if (!hasTasks && !hasScripts) return "planning";
  if (hasOpen || hasScripts) return "execution";
  if (counts.completadas > 0 && !hasOpen) return "validation";
  return normalizePhase(currentInQtc) ?? "planning";
}

function divergesFrom(current: string | null, suggested: string): boolean {
  const norm = normalizePhase(current);
  return norm !== null && norm !== suggested;
}

async function readPhaseFromBlock(
  fs: FileSystemPort,
  cwd: string,
  folder: string,
): Promise<string | null> {
  for (const file of [join(cwd, "CLAUDE.md"), join(cwd, "AGENTS.md")]) {
    if (!(await fs.exists(file))) continue;
    const block = parseProjectBlock(await fs.readText(file));
    if (!block) continue;
    for (const s of block.sessions) {
      if (s.folder === folder) return s.phase;
    }
  }
  return null;
}

async function hasAnySql(fs: FileSystemPort, dir: string): Promise<boolean> {
  const stack: string[] = [dir];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) break;
    const entries = await fs.list(current);
    for (const entry of entries) {
      if (entry.type === "dir") {
        stack.push(entry.path);
      } else if (entry.name.endsWith(".sql")) {
        return true;
      }
    }
  }
  return false;
}
