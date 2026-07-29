import { join } from "node:path";
import type { FileSystemPort } from "../ports/file-system.js";
import { historyFields, upsertHistoryRow } from "./history-update-service.js";
import { withCwdLock } from "./lock-service.js";
import type { PathsService } from "./paths-service.js";
import { canonicalArtifactPath } from "./session-artifacts.js";
import { invalidateBindingsTo } from "./session-binding-service.js";
import {
  CLOSED_MARKER,
  type SessionEntry,
  type SessionResolutionError,
  resolveSessionTarget,
} from "./session-resolver.js";

export interface SessionCloseInput {
  code?: string;
  /** Optional refs for the HISTORY row (`kind:val` CSV; free text renders as-is). */
  refs?: string;
}

export interface SessionCloseOutput {
  code: string;
  folder: string;
  closed: boolean;
  checkpoint_path: string;
  backlog_path: string;
  refs?: string;
  /** HISTORY.md row upsert performed by close (durable record of closed work). */
  history?: { action: string; state: string };
  /** Non-fatal: close succeeds even if the HISTORY write failed. */
  history_error?: string;
  /** Conversation associations dropped because they pointed at this session. */
  bindings_invalidated: number;
}

export interface SessionCloseFullOutput {
  sessionClose: SessionCloseOutput;
}

export interface SessionCloseError {
  error: string;
  code?: string;
}

export type SessionCloseResult =
  | SessionCloseFullOutput
  | SessionCloseError
  | { sessionError: SessionResolutionError };

export async function runSessionClose(
  fs: FileSystemPort,
  paths: PathsService,
  input: SessionCloseInput,
): Promise<SessionCloseResult> {
  // Closing is destructive to continuity: it always names its target. Falling
  // back to "the sole active one" would let a conversation close a line it
  // never selected.
  if (!input.code) return { error: "--code es obligatorio" };
  const resolution = await resolveSessionTarget(fs, paths, { code: input.code, allowClosed: true });
  if (resolution.outcome !== "resolved") return { sessionError: resolution };
  const session = resolution.session;

  // Durable artifacts survive close. CHECKPOINT is a resume safety net (no-op
  // when the loop already wrote one). BACKLOG is NOT fabricated: the owning loop
  // writes it only when there is deferred content; `backlog_path` still reports
  // the canonical path.
  const checkpointPath = canonicalArtifactPath(session.path, "checkpoint");
  await ensureFile(fs, checkpointPath, "# CHECKPOINT\n");

  const refs = input.refs?.trim();
  const closure = await closeUnderLock(fs, paths, session, {
    code: session.code ?? input.code,
    ...(refs !== undefined && refs.length > 0 ? { refs } : {}),
  });
  if ("error" in closure) return closure;

  const sessionClose: SessionCloseOutput = {
    code: session.code ?? input.code,
    folder: session.folder,
    closed: true,
    checkpoint_path: checkpointPath,
    backlog_path: canonicalArtifactPath(session.path, "backlog"),
    ...(refs !== undefined && refs.length > 0 ? { refs } : {}),
    bindings_invalidated: closure.bindings_invalidated,
    ...(closure.history ? { history: closure.history } : {}),
    ...(closure.history_error !== undefined ? { history_error: closure.history_error } : {}),
  };
  return { sessionClose };
}

interface Closure {
  bindings_invalidated: number;
  history?: { action: string; state: string };
  history_error?: string;
}

/**
 * The whole shared-state mutation of a close, under ONE lock acquisition:
 * invalidate the associations pointing here, write the `.closed` marker, upsert
 * the HISTORY row. HISTORY goes through the lock-free primitive on purpose —
 * its public command takes the lock itself, and nesting would deadlock.
 *
 * The registry goes FIRST: if it cannot be read, the close aborts having
 * mutated nothing, rather than leaving a closed session that conversations are
 * still associated with.
 */
async function closeUnderLock(
  fs: FileSystemPort,
  paths: PathsService,
  session: SessionEntry,
  row: { code: string; refs?: string },
): Promise<Closure | SessionCloseError> {
  // `failure` (not `error`) so the busy-lock envelope `withCwdLock` returns
  // stays distinguishable from a failure raised inside the critical section.
  type Locked = { ok: true; closure: Closure } | { ok: false; failure: SessionCloseError };

  const result = await withCwdLock(fs, paths, async (): Promise<Locked> => {
    const invalidated = await invalidateBindingsTo(fs, paths, session.folder);
    if (!invalidated.ok) {
      return { ok: false, failure: { error: invalidated.reason, code: "SESSION_BINDING_INVALID" } };
    }
    await fs.writeText(join(session.path, CLOSED_MARKER), "");
    const closure: Closure = { bindings_invalidated: invalidated.removed };
    try {
      const history = await upsertHistoryRow(
        fs,
        paths,
        historyFields({ ...row, state: "closed" }, session, row.code),
      );
      closure.history = { action: history.action, state: history.state };
    } catch (err) {
      // Non-fatal, as before: the caller re-runs `aw history-update` on this.
      closure.history_error = err instanceof Error ? err.message : String(err);
    }
    return { ok: true, closure };
  });

  if ("error" in result) return { error: result.error, code: "LOCK_BUSY" };
  return result.ok ? result.closure : result.failure;
}

async function ensureFile(fs: FileSystemPort, path: string, defaultContent: string): Promise<void> {
  if (await fs.exists(path)) return;
  await fs.writeText(path, defaultContent);
}
