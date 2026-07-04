import { join } from "node:path";
import type { EnvPort } from "../ports/env.js";
import type { FileSystemPort } from "../ports/file-system.js";
import { runHistoryUpdate } from "./history-update-service.js";
import type { PathsService } from "./paths-service.js";
import { canonicalArtifactPath } from "./session-artifacts.js";
import { CLOSED_MARKER, resolveSession } from "./session-resolver.js";

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
  /** Non-fatal: close succeeds even if the HISTORY write failed (e.g. busy lock). */
  history_error?: string;
}

export interface SessionCloseFullOutput {
  sessionClose: SessionCloseOutput;
}

export interface SessionCloseError {
  error: string;
}

export async function runSessionClose(
  fs: FileSystemPort,
  env: EnvPort,
  paths: PathsService,
  input: SessionCloseInput,
): Promise<SessionCloseFullOutput | SessionCloseError> {
  if (!input.code) return { error: "--code es obligatorio" };
  const session = await resolveSession(fs, env, paths, input.code, true);
  if (!session) return { error: `Sesión no encontrada: ${input.code}` };

  // Persist the durable artifacts in the session folder (they survive close).
  // CHECKPOINT is a resume safety net (no-op when the loop already wrote one).
  // BACKLOG is NOT fabricated here: the owning loop writes a real BACKLOG.md
  // only when there is deferred/followup content, so close no longer creates
  // an empty boilerplate file. `backlog_path` still reports the canonical path.
  const checkpointPath = canonicalArtifactPath(session.path, "checkpoint");
  const backlogPath = canonicalArtifactPath(session.path, "backlog");
  await ensureFile(fs, checkpointPath, "# CHECKPOINT\n");

  // Mark the session closed via the folder-local sentinel file.
  // Sessions are internal/light: closing does not touch the project block.
  await fs.writeText(join(session.path, CLOSED_MARKER), "");

  const sessionClose: SessionCloseOutput = {
    code: session.code ?? input.code ?? "",
    folder: session.folder,
    closed: true,
    checkpoint_path: checkpointPath,
    backlog_path: backlogPath,
  };
  if (input.refs && input.refs.trim().length > 0) {
    sessionClose.refs = input.refs.trim();
  }

  // Sessions are gitignored (machine-local live log); HISTORY.md is the durable,
  // committable record — close upserts its row here so it actually gets written
  // (doctrine-only wiring proved dead: nothing ever called `aw history-update`).
  // Non-fatal: a busy lock or a write failure never blocks closing.
  try {
    const history = await runHistoryUpdate(fs, env, paths, {
      code: sessionClose.code,
      state: "closed",
      ...(sessionClose.refs !== undefined ? { refs: sessionClose.refs } : {}),
    });
    if ("error" in history) {
      sessionClose.history_error = history.error;
    } else {
      sessionClose.history = { action: history.action, state: history.state };
    }
  } catch (err) {
    sessionClose.history_error = err instanceof Error ? err.message : String(err);
  }

  return { sessionClose };
}

async function ensureFile(fs: FileSystemPort, path: string, defaultContent: string): Promise<void> {
  if (await fs.exists(path)) return;
  await fs.writeText(path, defaultContent);
}
