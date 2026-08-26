import { join } from "node:path";
import type { SessionNarrative } from "../domain/session/narrative.js";
import type { EnvPort } from "../ports/env.js";
import type { FileSystemPort } from "../ports/file-system.js";
import { firstNonEmptyLine, parseMdSectionBilingual } from "./markdown.js";
import { parseDecisiones } from "./parsers/decisiones.js";
import { type TaskItem, parseTasks } from "./parsers/tasks.js";
import type { PathsService } from "./paths-service.js";
import { relpath } from "./paths.js";
import { findArtifact, listExistingArtifacts } from "./session-artifacts.js";
import { buildSessionNarrative } from "./session-narrative.js";
import {
  type SessionResolutionError,
  resolveSessionTarget,
  sessionReadRequest,
} from "./session-resolver.js";

export interface ArtifactsInput {
  code?: string;
  /** Omit the narrative — the technical detail on its own. */
  noNarrative?: boolean;
  verbose?: boolean;
  /** Opaque conversation id; resolution falls back to its durable association. */
  contextId?: string;
}

interface SessionSummary {
  titulo: string | null;
  criterios_count: number;
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
  session: SessionSummary | null;
  tasks: TasksSummary | null;
  decisiones_count: number;
  checkpoint_present?: boolean;
  conclusiones_present?: boolean;
  analysis_file_present?: boolean;
  backlog_present?: boolean;
  scripts_sql_present?: boolean;
  scripts?: { total: number; forward: number; rollback: number; has_bundle: boolean };
}

export interface ArtifactsOutput {
  session: string;
  path: string;
  code: string | null;
  state: string;
  artifacts: ArtifactsBlock;
  branch?: string;
  /**
   * The human reading of the session — the SAME projection `SESSION.md` carries
   * and `resume` answers from.
   *
   * Counts and presence flags say what EXISTS; they were never able to say what
   * happened, and a person asking "what did this session do?" had to open the
   * files and reconstruct it. The projection is built here rather than described,
   * so this surface cannot drift from the block on disk.
   */
  narrative?: SessionNarrative;
}

export type ArtifactsResult = ArtifactsOutput | { sessionError: SessionResolutionError };

export async function runArtifactsCommand(
  fs: FileSystemPort,
  _env: EnvPort,
  paths: PathsService,
  input: ArtifactsInput,
): Promise<ArtifactsResult> {
  const resolution = await resolveSessionTarget(fs, paths, sessionReadRequest(input));
  if (resolution.outcome !== "resolved") return { sessionError: resolution };
  const session = resolution.session;
  const cwd = paths.workspaceDir();
  const verbose = input.verbose === true;

  const sessionSummary = await summarizeSession(fs, session.path);
  const tasksSummary = await summarizeTasks(fs, session.path);
  const decisionesCount = await countDecisiones(fs, session.path);

  const presence = await readPresenceFlags(fs, session.path);
  const scripts = await readScripts(fs, session.path);

  const artifacts: ArtifactsBlock = {
    session: sessionSummary,
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
    state: session.state,
    artifacts,
  };
  if (session.branch !== undefined || verbose) {
    result.branch = session.branch ?? "";
  }
  if (input.noNarrative !== true) {
    // The code is left to derive: `session.code` is whatever the caller typed —
    // the folder name when they named the folder — and the narrative's own code
    // is the session's correlative, which is one fact with one answer.
    result.narrative = await buildSessionNarrative(fs, paths, {
      folder: session.folder,
      path: session.path,
    });
  }
  return result;
}

async function summarizeSession(
  fs: FileSystemPort,
  sessionPath: string,
): Promise<SessionSummary | null> {
  // New-model SESSION.md first; legacy OBJECTIVE.md as fallback.
  const path =
    (await findArtifact(sessionPath, "session", fs)) ??
    (await findArtifact(sessionPath, "objective", fs));
  if (!path) return null;
  const text = await fs.readText(path);
  const titleMatch = text.match(/^#\s+(.+)/m);
  const successSection =
    parseMdSectionBilingual(text, "Success criteria") ??
    parseMdSectionBilingual(text, "Criterios de aceptación") ??
    "";
  const criteriaCount = (successSection.match(/^\s*[-*]\s+\[[ xX]?\]/gm) ?? []).length;
  const originSection = parseMdSectionBilingual(text, "Origin");
  const hasOrigen =
    originSection !== undefined && (firstNonEmptyLine(originSection)?.length ?? 0) > 0;
  return {
    titulo: titleMatch?.[1]?.trim() ?? null,
    criterios_count: criteriaCount,
    has_origen: hasOrigen,
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
  checkpoint_present: boolean;
  conclusiones_present: boolean;
  analysis_file_present: boolean;
  backlog_present: boolean;
  scripts_sql_present: boolean;
}

async function readPresenceFlags(fs: FileSystemPort, sessionPath: string): Promise<PresenceFlags> {
  const present = await listExistingArtifacts(sessionPath, fs);
  return {
    checkpoint_present: present.checkpoint !== null,
    conclusiones_present: present.conclusions !== null,
    analysis_file_present: present.analysis_file !== null,
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
