import { join } from "node:path";
import type { EnvPort } from "../ports/env.js";
import type { FileSystemPort } from "../ports/file-system.js";
import type { PathsService } from "./paths-service.js";
import { canonicalArtifactPath } from "./session-artifacts.js";
import { CLOSED_MARKER, resolveSession } from "./session-resolver.js";

export interface SessionCloseInput {
  code?: string;
  /** Optional free-form refs string persisted alongside the session. */
  refs?: string;
}

export interface SessionCloseOutput {
  code: string;
  folder: string;
  closed: boolean;
  checkpoint_path: string;
  backlog_path: string;
  refs?: string;
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
  // Sessions are internal/light: closing no longer touches the project block.
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

  return { sessionClose };
}

async function ensureFile(fs: FileSystemPort, path: string, defaultContent: string): Promise<void> {
  if (await fs.exists(path)) return;
  await fs.writeText(path, defaultContent);
}
