import { join } from "node:path";
import type { EnvPort } from "../ports/env.js";
import type { FileSystemPort } from "../ports/file-system.js";
import { type CheckpointFields, readLatestCheckpoint } from "./checkpoint-service.js";
import type { PathsService } from "./paths-service.js";
import { relpath } from "./paths.js";
import { findArtifact } from "./session-artifacts.js";
import { CLOSED_MARKER, resolveSession } from "./session-resolver.js";

export interface SessionResumeInput {
  code?: string;
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
  code: string | null;
}

export async function runSessionResume(
  fs: FileSystemPort,
  env: EnvPort,
  paths: PathsService,
  input: SessionResumeInput,
): Promise<SessionResumeOutput | SessionResumeError> {
  const session = await resolveSession(fs, env, paths, input.code, true);
  if (!session) {
    return { error: "session_not_found", code: input.code ?? null };
  }

  // Inter-turn continuity (operating context, row 2): when explicitly resuming
  // to continue, a closed session is REOPENED — drop the `.closed` sentinel so
  // it becomes active again. `remove` is idempotent; a no-op when already active.
  let state = session.state;
  if (input.reopen === true && state === "closed") {
    await fs.remove(join(session.path, CLOSED_MARKER));
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
