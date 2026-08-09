import { join } from "node:path";
import type { EnvPort } from "../ports/env.js";
import type { FileSystemPort } from "../ports/file-system.js";
import type { GitPort } from "../ports/git.js";
import { findActiveSessions } from "./checkpoint-service.js";
import { formatCheckpointMd } from "./checkpoint/markdown.js";
import { extractSessionState } from "./checkpoint/state-reader.js";
import {
  type LifecycleOptions,
  type LifecycleTarget,
  resolveLifecycleTarget,
  unresolvedDetail,
} from "./lifecycle-target.js";
import type { PathsService } from "./paths-service.js";
import { writeSessionNarrative } from "./session-narrative.js";
import type { SessionCandidate, SessionEntry, SessionResolutionError } from "./session-resolver.js";

const PLACEHOLDER_MARKER = "_[AI:";

export interface CheckpointWriteOutput {
  session: string;
  checkpoint_path: string;
  lines_written?: number;
  progress_pct?: number | null;
  tasks_open?: number;
  tasks_closed?: number;
  files_touched_count?: number;
  skipped?: boolean;
  reason?: string;
}

/**
 * Non-pausable host: its native compaction goes ahead, Workline writes nothing
 * and says the continuity is degraded. `primary_session: null` is the point —
 * no active session gets presented as this conversation's line.
 */
export interface CheckpointWriteDegraded {
  skipped: true;
  reason: string;
  continuity: "degraded";
  primary_session: null;
  active_sessions: string[];
  candidates: SessionCandidate[];
  action: string;
}

/** Pausable host: hold the compaction until a human names the target. */
export interface CheckpointWriteBlocked {
  blocked: true;
  selection_required: true;
  sessionError: SessionResolutionError;
}

export type CheckpointWriteResult =
  | CheckpointWriteOutput
  | CheckpointWriteDegraded
  | CheckpointWriteBlocked;

export interface CheckpointWriteOptions extends LifecycleOptions {
  force?: boolean;
}

/**
 * PreCompact payload. `--code` used to be honoured only for legacy
 * `sessionNNN-*` folders, so a perfectly unambiguous current-model code was
 * silently skipped whenever a second session was active. It now goes through
 * the canonical resolver like everything else.
 */
export async function runCheckpointWrite(
  fs: FileSystemPort,
  env: EnvPort,
  git: GitPort,
  paths: PathsService,
  options: CheckpointWriteOptions = {},
): Promise<CheckpointWriteResult> {
  const target = await resolveLifecycleTarget(fs, paths, options);
  if (target.outcome !== "resolved") return unresolved(fs, paths, target);
  const session = target.session;
  const cpPath = join(session.path, "CHECKPOINT.md");

  if ((await fs.exists(cpPath)) && options.force !== true) {
    const existing = await fs.readText(cpPath);
    if (!existing.includes(PLACEHOLDER_MARKER)) {
      return {
        session: session.folder,
        checkpoint_path: cpPath,
        skipped: true,
        reason:
          "CHECKPOINT.md ya está sintetizado (sin placeholders); pasar --force para regenerar",
      };
    }
  }

  const state = await extractSessionState(fs, git, env.cwd(), session.path);
  const md = formatCheckpointMd(state);
  await fs.mkdirp(session.path);
  await fs.writeText(cpPath, md);
  // The CHECKPOINT is where progress lives, so writing one is exactly when the
  // session's entry point stops being current. Refreshed here and never on a
  // read, which is what keeps a `status` or a `resume` from rewriting history.
  await writeSessionNarrative(fs, paths, { folder: session.folder, path: session.path });

  return {
    session: session.folder,
    checkpoint_path: cpPath,
    lines_written: md.replace(/\n$/, "").split("\n").length,
    progress_pct: state.progress_pct,
    tasks_open: state.tasks.open,
    tasks_closed: state.tasks.closed,
    files_touched_count: state.files_touched.length,
  };
}

export interface AutoCompactOnCloseOutput {
  /** At most ONE entry: the resolved target, never "every active session". */
  checkpoints_written: Array<{
    session?: string;
    checkpoint_path?: string;
    progress_pct?: number | null;
    skipped?: boolean;
    reason?: string;
    error?: string;
  }>;
  continuity?: "degraded";
  primary_session?: null;
  candidates?: SessionCandidate[];
  action?: string;
}

/**
 * SessionEnd. It used to iterate EVERY active session, so closing one host
 * conversation wrote checkpoints over lines belonging to others. It now
 * checkpoints the resolved target and nothing else; with no sufficient
 * identity it writes nothing at all. The host is exiting, so there is nobody
 * left to answer a selection prompt: this surface always degrades, never blocks.
 */
export async function runAutoCompactOnClose(
  fs: FileSystemPort,
  env: EnvPort,
  git: GitPort,
  paths: PathsService,
  options: LifecycleOptions = {},
): Promise<AutoCompactOnCloseOutput> {
  const target = await resolveLifecycleTarget(fs, paths, {
    ...options,
    canPauseCompaction: false,
  });
  if (target.outcome !== "resolved") {
    const detail = unresolvedDetail(target);
    return {
      checkpoints_written: [],
      continuity: "degraded",
      primary_session: null,
      candidates: detail.candidates,
      action: detail.action,
    };
  }
  const entry = await writeCheckpointForTarget(fs, git, env.cwd(), target.session);
  return { checkpoints_written: [entry] };
}

async function writeCheckpointForTarget(
  fs: FileSystemPort,
  git: GitPort,
  cwd: string,
  session: SessionEntry,
): Promise<AutoCompactOnCloseOutput["checkpoints_written"][number]> {
  const cpPath = join(session.path, "CHECKPOINT.md");
  if (await fs.exists(cpPath)) {
    const existing = await fs.readText(cpPath);
    if (!existing.includes(PLACEHOLDER_MARKER)) {
      return {
        session: session.folder,
        checkpoint_path: cpPath,
        skipped: true,
        reason: "CHECKPOINT.md ya sintetizado",
      };
    }
  }
  try {
    const state = await extractSessionState(fs, git, cwd, session.path);
    const md = formatCheckpointMd(state);
    await fs.mkdirp(session.path);
    await fs.writeText(cpPath, md);
    return {
      session: session.folder,
      checkpoint_path: cpPath,
      progress_pct: state.progress_pct,
    };
  } catch (err) {
    return {
      session: session.folder,
      error: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
    };
  }
}

async function unresolved(
  fs: FileSystemPort,
  paths: PathsService,
  target: Extract<LifecycleTarget, { outcome: "degraded" | "blocked" }>,
): Promise<CheckpointWriteDegraded | CheckpointWriteBlocked> {
  if (target.outcome === "blocked") {
    return { blocked: true, selection_required: true, sessionError: target.error };
  }
  const actives = await findActiveSessions(fs, paths);
  return {
    skipped: true,
    reason: target.reason,
    continuity: "degraded",
    primary_session: null,
    active_sessions: actives.map((a) => a.folder),
    candidates: target.candidates,
    action: target.action,
  };
}
