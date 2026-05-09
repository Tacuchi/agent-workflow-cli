import { join } from "node:path";
import type { EnvPort } from "../ports/env.js";
import type { FileSystemPort } from "../ports/file-system.js";
import type { GitPort } from "../ports/git.js";
import { findActiveSessions } from "./checkpoint-service.js";
import { formatCheckpointMd } from "./checkpoint/markdown.js";
import { extractSessionState } from "./checkpoint/state-reader.js";
import type { PathsService } from "./paths-service.js";

const PLACEHOLDER_MARKER = "_[AI:";

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
    const actives = await findActiveSessions(fs, cwd, paths.blockMarkers());
    if (actives.length === 0) {
      return { skipped: true, reason: "no hay sesiones activas en <NS>-PROJECT.Status" };
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
  const actives = await findActiveSessions(fs, env.cwd(), paths.blockMarkers());
  return actives.length === 1 ? (actives[0]?.folder ?? null) : null;
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
  const actives = await findActiveSessions(fs, cwd, paths.blockMarkers());
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
