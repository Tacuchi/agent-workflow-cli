import { join } from "node:path";
import type { EnvPort } from "../ports/env.js";
import type { FileSystemPort } from "../ports/file-system.js";
import type { GitPort } from "../ports/git.js";
import { findActiveSessions } from "./checkpoint-service.js";
import { totalInScope } from "./checkpoint/files-touched.js";
import { formatCheckpointMd, isPristineCheckpoint } from "./checkpoint/markdown.js";
import { extractSessionState } from "./checkpoint/state-reader.js";
import {
  type LifecycleOptions,
  type LifecycleTarget,
  resolveLifecycleTarget,
  unresolvedDetail,
} from "./lifecycle-target.js";
import { type PathsService, resolveWorkspaceRoot } from "./paths-service.js";
import { writeSessionNarrative } from "./session-narrative.js";
import type { SessionCandidate, SessionEntry, SessionResolutionError } from "./session-resolver.js";

// This module deliberately owns NO placeholder marker of its own. `_[AI:` used
// to be declared here as well as in `checkpoint-service.ts`, with incompatible
// meanings: over there it classifies a checkpoint as a draft that still needs
// the agent (coherent, and it stays), here it granted permission to destroy the
// file. Since the template always emits the marker, that permission was
// permanent. Provenance decides who may overwrite now, and the one surviving
// marker means one thing only.

/** Said to the caller whenever content was kept instead of being regenerated. */
const PRESERVED_REASON =
  "CHECKPOINT.md tiene contenido escrito y se conservó; pasar --force para regenerarlo";

export interface CheckpointWriteOutput {
  session: string;
  checkpoint_path: string;
  lines_written?: number;
  progress_pct?: number | null;
  tasks_open?: number;
  tasks_closed?: number;
  files_touched_count?: number;
  skipped?: boolean;
  /** The existing CHECKPOINT had content: nothing was written, nothing was lost. */
  preserved?: true;
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
  // Binds: writing a CHECKPOINT and refreshing SESSION.md IS this conversation
  // claiming the line, and the next hook run (which carries no `--code`) needs
  // the association to land on the same one.
  const target = await resolveLifecycleTarget(fs, paths, options, "bind");
  if (target.outcome !== "resolved") return unresolved(fs, paths, target);
  const session = target.session;
  const cpPath = join(session.path, "CHECKPOINT.md");

  if (await hasContentToPreserve(fs, cpPath, options.force === true)) {
    return {
      session: session.folder,
      checkpoint_path: cpPath,
      skipped: true,
      preserved: true,
      reason: PRESERVED_REASON,
    };
  }

  // The workspace root rather than the raw cwd. Today the two coincide by
  // construction — session resolution already refuses to run from a
  // subdirectory, so nothing reaches here with a deeper cwd — and what actually
  // bounds the reading is `repoPrefix` inside the collection. This stays the
  // resolved root anyway: it is the value the boundary is DEFINED as, so the
  // day session resolution learns to walk up, the inventory does not silently
  // widen to the parent repository along with it.
  const workspaceRoot = await resolveWorkspaceRoot(fs, env, paths);
  const state = await extractSessionState(fs, git, workspaceRoot, session.path);
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
    files_touched_count: totalInScope(state.files_touched),
  };
}

export interface AutoCompactOnCloseOutput {
  /** At most ONE entry: the resolved target, never "every active session". */
  checkpoints_written: Array<{
    session?: string;
    checkpoint_path?: string;
    progress_pct?: number | null;
    skipped?: boolean;
    preserved?: true;
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
  // Does NOT bind: the host is exiting, so there is no later turn the
  // association could serve, and establishing one is a locked write that fails
  // the whole resolution when it cannot be taken — which would cost the
  // checkpoint this surface exists to save.
  const target = await resolveLifecycleTarget(
    fs,
    paths,
    { ...options, canPauseCompaction: false },
    "read-only",
  );
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
  const workspaceRoot = await resolveWorkspaceRoot(fs, env, paths);
  const entry = await writeCheckpointForTarget(fs, git, workspaceRoot, target.session);
  return { checkpoints_written: [entry] };
}

async function writeCheckpointForTarget(
  fs: FileSystemPort,
  git: GitPort,
  workspaceRoot: string,
  session: SessionEntry,
): Promise<AutoCompactOnCloseOutput["checkpoints_written"][number]> {
  const cpPath = join(session.path, "CHECKPOINT.md");
  // No `force` here on purpose: SessionEnd is a hook, and a hook is never the
  // declared intention that AC-02 asks for before overwriting content.
  if (await hasContentToPreserve(fs, cpPath, false)) {
    return {
      session: session.folder,
      checkpoint_path: cpPath,
      skipped: true,
      preserved: true,
      reason: PRESERVED_REASON,
    };
  }
  try {
    const state = await extractSessionState(fs, git, workspaceRoot, session.path);
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

/**
 * The single guard both lifecycle write paths ask before touching the file.
 *
 * Absent file → nothing to lose. Sealed and intact → the CLI's own untouched
 * template, so regenerating it is free. Anything else — filled in, hand-edited,
 * or written by a version that predates the seal — is somebody's work, and only
 * `--force` gets past it.
 */
async function hasContentToPreserve(
  fs: FileSystemPort,
  cpPath: string,
  force: boolean,
): Promise<boolean> {
  if (force) return false;
  if (!(await fs.exists(cpPath))) return false;
  return !isPristineCheckpoint(await fs.readText(cpPath));
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
