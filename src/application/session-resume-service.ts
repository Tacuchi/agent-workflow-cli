import { join } from "node:path";
import type { EnvPort } from "../ports/env.js";
import type { FileSystemPort } from "../ports/file-system.js";
import { type CheckpointFields, readLatestCheckpoint } from "./checkpoint-service.js";
import { type RunReopen, reopenRun } from "./flow/reopen-run.js";
import { locateRun } from "./flow/run-state-service.js";
import { upsertHistoryRow } from "./history-update-service.js";
import { withCwdLock } from "./lock-service.js";
import type { PathsService } from "./paths-service.js";
import { relpath } from "./paths.js";
import { findArtifact } from "./session-artifacts.js";
import {
  bindContextToSession,
  lookupBinding,
  restoreBindingTo,
} from "./session-binding-service.js";
import { writeSessionNarrative } from "./session-narrative.js";
import {
  ABANDONED_MARKER,
  CLOSED_MARKER,
  PAUSED_MARKER,
  type SessionEntry,
  type SessionResolutionError,
  readSessionState,
  resolveSessionTarget,
} from "./session-resolver.js";

export interface SessionResumeInput {
  code?: string;
  /** Opaque conversation id; resolution falls back to its durable association. */
  contextId?: string;
  /**
   * Reactivate a closed session being resumed (remove its `.closed` sentinel).
   * Default false = read-only resume. This is the inter-turn continuity move
   * (operating context, row 2): a related bare prompt reopens the most-recent
   * session so new work — scripts into its SCRIPTS.sql, a re-close at
   * convergence — lands in an *active* session, not a closed one.
   */
  reopen?: boolean;
}

export interface SessionResumeOutput {
  code: string | null;
  folder: string;
  path: string;
  state: string;
  objetivo: string | null;
  objetivo_text: string | null;
  checkpoint: CheckpointFields | null;
  /** Where the reopened session's run resumes; absent when it had none to reopen. */
  run?: { resumes_at: string };
}

export interface SessionResumeError {
  error: string;
  code?: string;
  action?: string;
  run_error?: Extract<RunReopen, { ok: false }>["failure"];
  restore_error?: string;
}

export type SessionResumeResult =
  | SessionResumeOutput
  | SessionResumeError
  | { sessionError: SessionResolutionError };

export async function runSessionResume(
  fs: FileSystemPort,
  _env: EnvPort,
  paths: PathsService,
  input: SessionResumeInput,
): Promise<SessionResumeResult> {
  // Reopening is a selection, not a guess: it reactivates a closed line and
  // associates the conversation with it, so it always names its target.
  if (reopenWithoutCode(input)) {
    return { error: "--reopen exige --code <NNN>", code: "INVALID_INPUT" };
  }

  const resolution = await resolveResumeTarget(fs, paths, input);
  if (resolution.outcome !== "resolved") return { sessionError: resolution };
  const session = resolution.session;

  if (session.state === "abandoned" && input.reopen !== true) {
    return {
      error: `la sesión ${session.folder} está abandonada; reabrila con --reopen`,
      code: "SESSION_ABANDONED",
    };
  }

  let state = session.state;
  let resumesAt: string | null = null;
  if (state === "paused" && input.reopen !== true) {
    const resumed = await withCwdLock(fs, paths, () => unpauseUnderLock(fs, paths, session, input));
    if ("error" in resumed)
      return {
        error: resumed.error,
        code: "code" in resumed ? resumed.code : "SESSION_RESUME_FAILED",
      };
    state = "active";
    await writeSessionNarrative(fs, paths, { folder: session.folder, path: session.path });
  }
  if (input.reopen === true) {
    const reopened = await reopenSessionAndRun(fs, paths, session, input.contextId);
    if ("error" in reopened) return reopened;
    resumesAt = reopened.resumes_at;
    state = "active";
  }

  return resumedSessionOutput(fs, paths, session, state, resumesAt);
}

async function reopenSessionAndRun(
  fs: FileSystemPort,
  paths: PathsService,
  session: SessionEntry,
  contextId: string | undefined,
): Promise<SessionResumeError | { resumes_at: string | null }> {
  const reopened = await reopenUnderLock(fs, paths, session, contextId);
  if ("error" in reopened) return reopened;
  // F3 keeps the hub and run locks separate. If the second step fails,
  // restore the marker under the hub lock before reporting failure.
  let run: RunReopen;
  try {
    run = await reopenRun(fs, locateRun(paths, session.folder));
  } catch (error) {
    run = {
      ok: false,
      failure: {
        code: "FLOW_REOPEN_FAILED",
        message: error instanceof Error ? error.message : String(error),
        action: `volvé a correr 'aw session-resume --code ${session.folder} --reopen'`,
      },
    };
  }
  if (!run.ok) {
    const restored =
      reopened.wasClosed || reopened.wasPaused
        ? await restoreClosed(fs, paths, session, reopened, contextId)
        : null;
    return {
      code: run.failure.code,
      error: `${run.failure.code}: ${run.failure.message}${restored === null ? "" : `; no se pudo restaurar .closed: ${restored}`}`,
      action:
        run.failure.code === "FLOW_RUN_LOCKED"
          ? `esperá a que termine y volvé a correr 'aw session-resume --code ${session.folder} --reopen'`
          : run.failure.action,
      run_error: run.failure,
      ...(restored === null ? {} : { restore_error: restored }),
    };
  }
  // The narrative must reflect the committed reopen, not a failed run reopen.
  await writeSessionNarrative(fs, paths, { folder: session.folder, path: session.path });
  return { resumes_at: run.resumes_at };
}

/** Reopened and associated, recording whether this call removed `.closed`. */
async function reopenUnderLock(
  fs: FileSystemPort,
  paths: PathsService,
  session: SessionEntry,
  contextId: string | undefined,
): Promise<
  | SessionResumeError
  | {
      wasClosed: boolean;
      wasPaused: boolean;
      wasAbandoned: boolean;
      previousBinding: string | null;
    }
> {
  const id = contextId?.trim() ?? "";
  // `failure` (not `error`) so the busy-lock envelope `withCwdLock` returns
  // stays distinguishable from a failure raised inside the critical section.
  type Locked =
    | {
        ok: true;
        wasClosed: boolean;
        wasPaused: boolean;
        wasAbandoned: boolean;
        previousBinding: string | null;
      }
    | { ok: false; failure: SessionResumeError };

  const result = await withCwdLock(fs, paths, async (): Promise<Locked> => {
    const wasClosed = await fs.exists(join(session.path, CLOSED_MARKER));
    const wasPaused = await fs.exists(join(session.path, PAUSED_MARKER));
    const wasAbandoned = await fs.exists(join(session.path, ABANDONED_MARKER));
    const snapshot = await resumeSnapshot(fs, paths);
    const previous =
      id.length > 0 ? await lookupBinding(fs, paths, id) : { status: "unbound" as const };
    if (previous.status === "invalid") {
      return { ok: false, failure: { error: previous.reason, code: "SESSION_BINDING_INVALID" } };
    }
    const previousBinding = previous.status === "bound" ? previous.folder : null;
    try {
      const bindingFailure = await bindReopenedSession(fs, paths, id, session);
      if (bindingFailure !== null) return { ok: false, failure: bindingFailure };
      // `remove` is idempotent — a no-op when the session is already active.
      await fs.remove(join(session.path, CLOSED_MARKER));
      await fs.remove(join(session.path, PAUSED_MARKER));
      await fs.remove(join(session.path, ABANDONED_MARKER));
      await upsertHistoryRow(fs, paths, {
        code: session.code ?? session.folder,
        sesionName: session.name,
        state: "active",
      });
      return { ok: true, wasClosed, wasPaused, wasAbandoned, previousBinding };
    } catch (error) {
      await restoreSessionMarkers(fs, session, wasClosed, wasPaused, wasAbandoned);
      await restoreResumeSnapshot(fs, snapshot);
      return {
        ok: false,
        failure: {
          error: `no se pudo reabrir ${session.folder}: ${error instanceof Error ? error.message : String(error)}`,
          code: "SESSION_REOPEN_FAILED",
        },
      };
    }
  });

  if ("error" in result) return { error: result.error, code: "LOCK_BUSY" };
  return result.ok
    ? {
        wasClosed: result.wasClosed,
        wasPaused: result.wasPaused,
        wasAbandoned: result.wasAbandoned,
        previousBinding: result.previousBinding,
      }
    : result.failure;
}

async function restoreClosed(
  fs: FileSystemPort,
  paths: PathsService,
  session: SessionEntry,
  old: {
    wasClosed: boolean;
    wasPaused: boolean;
    wasAbandoned: boolean;
    previousBinding: string | null;
  },
  contextId: string | undefined,
): Promise<string | null> {
  try {
    const restored = await withCwdLock(fs, paths, async () => {
      if (old.wasClosed) await fs.writeText(join(session.path, CLOSED_MARKER), "");
      if (old.wasPaused) await fs.writeText(join(session.path, PAUSED_MARKER), "");
      if (old.wasAbandoned) await fs.writeText(join(session.path, ABANDONED_MARKER), "");
      await upsertHistoryRow(fs, paths, {
        code: session.code ?? session.folder,
        sesionName: session.name,
        state: old.wasAbandoned ? "abandoned" : old.wasPaused ? "paused" : "closed",
      });
      if (contextId)
        await restoreBindingTo(fs, paths, contextId, session.folder, old.previousBinding);
      return { ok: true };
    });
    return "error" in restored ? restored.error : null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

async function unpauseUnderLock(
  fs: FileSystemPort,
  paths: PathsService,
  session: SessionEntry,
  input: SessionResumeInput,
): Promise<SessionResumeError | { resumed: true }> {
  if ((await readSessionState(fs, session.path)) !== "paused") {
    return {
      error: `la sesión ${session.folder} ya no está pausada`,
      code: "SESSION_STATE_CHANGED",
    };
  }
  const snapshot = await resumeSnapshot(fs, paths);
  try {
    if (input.contextId) {
      const binding = await bindContextToSession(fs, paths, input.contextId, session.folder);
      if (!binding.ok) return { error: binding.reason };
    }
    await fs.remove(join(session.path, PAUSED_MARKER));
    await upsertHistoryRow(fs, paths, {
      code: session.code ?? session.folder,
      sesionName: session.name,
      state: "active",
    });
    return { resumed: true };
  } catch (error) {
    await fs.writeText(join(session.path, PAUSED_MARKER), "");
    await restoreResumeSnapshot(fs, snapshot);
    return {
      error: `no se pudo retomar ${session.folder}: ${error instanceof Error ? error.message : String(error)}`,
      code: "SESSION_RESUME_FAILED",
    };
  }
}

async function resumeSnapshot(fs: FileSystemPort, paths: PathsService) {
  const bindingFile = paths.cwdSessionBindingsFile();
  const historyFile = paths.cwdHistoryFile();
  const bindingsBefore = (await fs.exists(bindingFile)) ? await fs.readText(bindingFile) : null;
  const historyBefore = (await fs.exists(historyFile)) ? await fs.readText(historyFile) : null;
  return { bindingFile, historyFile, bindingsBefore, historyBefore };
}

async function restoreResumeSnapshot(
  fs: FileSystemPort,
  snapshot: Awaited<ReturnType<typeof resumeSnapshot>>,
): Promise<void> {
  const { bindingFile, historyFile, bindingsBefore, historyBefore } = snapshot;
  if (bindingsBefore === null) await fs.remove(bindingFile);
  else await fs.writeText(bindingFile, bindingsBefore);
  if (historyBefore === null) await fs.remove(historyFile);
  else await fs.writeText(historyFile, historyBefore);
}

async function restoreSessionMarkers(
  fs: FileSystemPort,
  session: SessionEntry,
  wasClosed: boolean,
  wasPaused: boolean,
  wasAbandoned: boolean,
): Promise<void> {
  if (wasClosed) await fs.writeText(join(session.path, CLOSED_MARKER), "");
  if (wasPaused) await fs.writeText(join(session.path, PAUSED_MARKER), "");
  if (wasAbandoned) await fs.writeText(join(session.path, ABANDONED_MARKER), "");
}

async function resumedSessionOutput(
  fs: FileSystemPort,
  paths: PathsService,
  session: SessionEntry,
  state: SessionEntry["state"],
  resumesAt: string | null,
): Promise<SessionResumeResult> {
  const cwd = paths.hubDir();
  // Dual-read: new-model SESSION.md first, legacy OBJECTIVE.md as fallback.
  const objetivoPath =
    (await findArtifact(session.path, "session", fs)) ??
    (await findArtifact(session.path, "objective", fs));
  const objetivoText = objetivoPath ? await fs.readText(objetivoPath) : null;

  // Resume context comes from the folder-local CHECKPOINT.md, not the hub block.
  const checkpoint = await readLatestCheckpoint(fs, session.path);

  return {
    code: session.code,
    folder: session.folder,
    path: relpath(session.path, cwd),
    state,
    objetivo: objetivoText,
    objetivo_text: objetivoText,
    checkpoint,
    ...(resumesAt !== null ? { run: { resumes_at: resumesAt } } : {}),
  };
}

function resolveResumeTarget(fs: FileSystemPort, paths: PathsService, input: SessionResumeInput) {
  return resolveSessionTarget(fs, paths, {
    intent: input.reopen === true ? "write" : "read",
    ...(input.code !== undefined ? { code: input.code } : {}),
    ...(input.contextId !== undefined ? { contextId: input.contextId } : {}),
    allowClosed: true,
    // A plain resume is an inspection. A reopen binds inside its own lock
    // below, so neither variant delegates a hidden binding write to resolution.
    bind: false,
  });
}

async function bindReopenedSession(
  fs: FileSystemPort,
  paths: PathsService,
  id: string,
  session: SessionEntry,
): Promise<SessionResumeError | null> {
  if (id.length > 0) {
    const bound = await bindContextToSession(fs, paths, id, session.folder);
    if (!bound.ok) {
      return { error: bound.reason, code: "SESSION_BINDING_INVALID" };
    }
  }
  return null;
}

function reopenWithoutCode(input: SessionResumeInput): boolean {
  return input.reopen === true && (input.code ?? "").trim().length === 0;
}
