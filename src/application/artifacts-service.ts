import { join } from "node:path";
import type { EnvPort } from "../ports/env.js";
import type { FileSystemPort } from "../ports/file-system.js";
import { parseDecisiones } from "./parsers/decisiones.js";
import { parseObjetivo } from "./parsers/objetivo.js";
import { type TaskItem, parseTasks } from "./parsers/tasks.js";
import type { PathsService } from "./paths-service.js";
import { relpath } from "./paths.js";
import { findArtifact, listExistingArtifacts } from "./session-artifacts.js";
import { resolveSession } from "./session-resolver.js";

export interface ArtifactsInput {
  code?: string;
  verbose?: boolean;
}

interface ObjetivoSummary {
  titulo: string | null;
  tipo: string | null;
  modalidad: string | null;
  criterios_count: number;
  fuentes_mencionadas: string[];
  has_origen: boolean;
}

interface TasksSummary {
  total: number;
  open: number;
  closed: number;
  progress_pct: number;
  next_open: TaskItem | null;
}

interface ArtifactsBlock {
  objetivo: ObjetivoSummary | null;
  tasks: TasksSummary | null;
  decisiones_count: number;
  dependencias_present?: boolean;
  checkpoint_present?: boolean;
  entrega_present?: boolean;
  conclusiones_present?: boolean;
  discovery_present?: boolean;
  evidencia_present?: boolean;
  hallazgos_present?: boolean;
  backlog_present?: boolean;
  scripts_sql_present?: boolean;
  scripts?: { total: number; forward: number; rollback: number; has_bundle: boolean };
}

export interface ArtifactsOutput {
  session: string;
  path: string;
  code: string | null;
  flow: string | null;
  state: string;
  phase: string;
  artifacts: ArtifactsBlock;
  branch?: string;
}

export interface ArtifactsError {
  error: string;
  code: string | null;
}

export async function runArtifactsCommand(
  fs: FileSystemPort,
  env: EnvPort,
  paths: PathsService,
  input: ArtifactsInput,
): Promise<ArtifactsOutput | ArtifactsError> {
  const session = await resolveSession(fs, env, paths, input.code, true);
  if (!session) {
    return { error: "session_not_found", code: input.code ?? null };
  }
  const cwd = env.cwd();
  const verbose = input.verbose === true;

  const objetivoSummary = await summarizeObjetivo(fs, session.path);
  const tasksSummary = await summarizeTasks(fs, session.path);
  const decisionesCount = await countDecisiones(fs, session.path);

  const presence = await readPresenceFlags(fs, session.path);
  const scripts = await readScripts(fs, session.path);

  const artifacts: ArtifactsBlock = {
    objetivo: objetivoSummary,
    tasks: tasksSummary,
    decisiones_count: decisionesCount,
  };
  if (verbose) {
    Object.assign(artifacts, presence);
  } else {
    for (const [k, v] of Object.entries(presence)) {
      if (v === true) {
        (artifacts as unknown as Record<string, unknown>)[k] = v;
      }
    }
  }
  if (scripts.total > 0 || verbose) {
    artifacts.scripts = scripts;
  }

  const result: ArtifactsOutput = {
    session: session.folder,
    path: verbose ? session.path : relpath(session.path, cwd),
    code: session.code,
    flow: session.flow,
    state: session.state,
    phase: session.phase,
    artifacts,
  };
  if (session.branch !== undefined || verbose) {
    result.branch = session.branch ?? "";
  }
  return result;
}

async function summarizeObjetivo(
  fs: FileSystemPort,
  sessionPath: string,
): Promise<ObjetivoSummary | null> {
  const path = await findArtifact(sessionPath, "objective", fs);
  if (!path) return null;
  const text = await fs.readText(path);
  const parsed = parseObjetivo(text);
  return {
    titulo: parsed.titulo,
    tipo: parsed.tipo,
    modalidad: parsed.modalidad,
    criterios_count: parsed.criterios_aceptacion.length,
    fuentes_mencionadas: parsed.fuentes_mencionadas,
    has_origen: parsed.origen !== null,
  };
}

async function summarizeTasks(
  fs: FileSystemPort,
  sessionPath: string,
): Promise<TasksSummary | null> {
  const path = await findArtifact(sessionPath, "tasks", fs);
  if (!path) return null;
  const text = await fs.readText(path);
  const parsed = parseTasks(text);
  return {
    total: parsed.total,
    open: parsed.open,
    closed: parsed.closed,
    progress_pct: parsed.progress_pct,
    next_open: parsed.next_open,
  };
}

async function countDecisiones(fs: FileSystemPort, sessionPath: string): Promise<number> {
  const path = await findArtifact(sessionPath, "decisions", fs);
  if (!path) return 0;
  const text = await fs.readText(path);
  return parseDecisiones(text).length;
}

interface PresenceFlags {
  dependencias_present: boolean;
  checkpoint_present: boolean;
  entrega_present: boolean;
  conclusiones_present: boolean;
  discovery_present: boolean;
  evidencia_present: boolean;
  hallazgos_present: boolean;
  backlog_present: boolean;
  scripts_sql_present: boolean;
}

async function readPresenceFlags(fs: FileSystemPort, sessionPath: string): Promise<PresenceFlags> {
  const present = await listExistingArtifacts(sessionPath, fs);
  return {
    dependencias_present: present.dependencies !== null,
    checkpoint_present: present.checkpoint !== null,
    entrega_present: present.delivery !== null,
    conclusiones_present: present.conclusions !== null,
    discovery_present: present.discovery !== null,
    evidencia_present: present.evidence !== null,
    hallazgos_present: present.findings !== null,
    backlog_present: present.backlog !== null,
    scripts_sql_present: present.scripts_sql !== null,
  };
}

async function readScripts(
  fs: FileSystemPort,
  sessionPath: string,
): Promise<{ total: number; forward: number; rollback: number; has_bundle: boolean }> {
  const scriptsDir = join(sessionPath, "scripts");
  if (!(await fs.exists(scriptsDir))) {
    return { total: 0, forward: 0, rollback: 0, has_bundle: false };
  }
  let total = 0;
  let rollback = 0;
  for (const file of await collectFiles(fs, scriptsDir)) {
    if (file.endsWith(".sql")) {
      total += 1;
      if (file.endsWith(".rollback.sql")) {
        rollback += 1;
      }
    }
  }
  const hasBundle = await fs.exists(join(scriptsDir, "bundle"));
  return { total, forward: total - rollback, rollback, has_bundle: hasBundle };
}

async function collectFiles(fs: FileSystemPort, dir: string): Promise<string[]> {
  const entries = await fs.list(dir);
  const result: string[] = [];
  for (const entry of entries) {
    if (entry.type === "dir") {
      result.push(...(await collectFiles(fs, entry.path)));
    } else {
      result.push(entry.name);
    }
  }
  return result;
}
