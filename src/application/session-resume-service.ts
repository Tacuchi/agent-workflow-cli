import { join } from "node:path";
import type { EnvPort } from "../ports/env.js";
import type { FileSystemPort } from "../ports/file-system.js";
import { type CheckpointFields, readLatestCheckpoint } from "./checkpoint-service.js";
import { withCwdLock } from "./lock-service.js";
import type { PathsService } from "./paths-service.js";
import { relpath } from "./paths.js";
import { findArtifact } from "./session-artifacts.js";
import { bindContextToSession } from "./session-binding-service.js";
import {
  CLOSED_MARKER,
  type SessionEntry,
  type SessionResolutionError,
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
}

export interface SessionResumeError {
  error: string;
  code?: string;
}

export type SessionResumeResult =
  | SessionResumeOutput
  | SessionResumeError
  | { sessionError: SessionResolutionError };

export async function runSessionResume(
  fs: FileSystemPort,
  env: EnvPort,
  paths: PathsService,
  input: SessionResumeInput,
): Promise<SessionResumeResult> {
  // Reopening is a selection, not a guess: it reactivates a closed line and
  // associates the conversation with it, so it always names its target.
  if (input.reopen === true && (input.code ?? "").trim().length === 0) {
    return { error: "--reopen exige --code <NNN>", code: "INVALID_INPUT" };
  }

  const resolution = await resolveSessionTarget(fs, paths, {
    ...(input.code !== undefined ? { code: input.code } : {}),
    ...(input.contextId !== undefined ? { contextId: input.contextId } : {}),
    allowClosed: true,
    // A reopen binds inside its own lock below, so the operation acquires the
    // workspace lock exactly once.
    bind: input.reopen !== true,
  });
  if (resolution.outcome !== "resolved") return { sessionError: resolution };
  const session = resolution.session;

  let state = session.state;
  if (input.reopen === true) {
    const reopened = await reopenUnderLock(fs, paths, session, input.contextId);
    if (reopened !== null) return reopened;
    state = "active";
  }

  const cwd = env.cwd();
  // Dual-read: new-model SESSION.md first, legacy OBJECTIVE.md as fallback.
  const objetivoPath =
    (await findArtifact(session.path, "session", fs)) ??
    (await findArtifact(session.path, "objective", fs));
  const objetivoText = objetivoPath ? await fs.readText(objetivoPath) : null;

  // Resume context comes from the folder-local CHECKPOINT.md, not the project block.
  const checkpoint = await readLatestCheckpoint(fs, session.path);

  return {
    code: session.code,
    folder: session.folder,
    path: relpath(session.path, cwd),
    state,
    objetivo: objetivoText,
    objetivo_text: objetivoText,
    checkpoint,
  };
}

/** `null` = reopened and associated; otherwise the error to return verbatim. */
async function reopenUnderLock(
  fs: FileSystemPort,
  paths: PathsService,
  session: SessionEntry,
  contextId: string | undefined,
): Promise<SessionResumeError | null> {
  const id = contextId?.trim() ?? "";
  // `failure` (not `error`) so the busy-lock envelope `withCwdLock` returns
  // stays distinguishable from a failure raised inside the critical section.
  type Locked = { ok: true } | { ok: false; failure: SessionResumeError };

  const result = await withCwdLock(fs, paths, async (): Promise<Locked> => {
    // `remove` is idempotent — a no-op when the session is already active.
    await fs.remove(join(session.path, CLOSED_MARKER));
    if (id.length === 0) return { ok: true };
    const bound = await bindContextToSession(fs, paths, id, session.folder);
    return bound.ok
      ? { ok: true }
      : { ok: false, failure: { error: bound.reason, code: "SESSION_BINDING_INVALID" } };
  });

  if ("error" in result) return { error: result.error, code: "LOCK_BUSY" };
  return result.ok ? null : result.failure;
}
