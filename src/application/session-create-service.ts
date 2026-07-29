import { join } from "node:path";
import type { SessionType } from "../domain/types.js";
import type { FileSystemPort } from "../ports/file-system.js";
import { withCwdLock } from "./lock-service.js";
import type { PathsService } from "./paths-service.js";
import { canonicalArtifactPath } from "./session-artifacts.js";
import { bindContextToSession, readBindingRegistry } from "./session-binding-service.js";
import { renderSessionMarkdown } from "./templates/session.js";

const VALID_TYPES = ["research", "refine", "exec", "quick"] as const;

export interface SessionCreateInput {
  type?: string;
  name?: string;
  objetivo?: string;
  /** Optional plain origin string (who/where the session was created from). */
  originRaw?: string;
  /** Opaque conversation id; the new session becomes its associated line. */
  contextId?: string;
}

export interface SessionCreateRecordOutput {
  type: SessionType;
  name: string;
  /** Global sequential number assigned by the CLI (zero-padded, e.g. "003"). */
  number: string;
  folder: string;
  path: string;
  session_path: string;
  origin?: string;
}

export interface SessionCreateFullOutput {
  sessionCreate: SessionCreateRecordOutput;
}

export interface SessionCreateError {
  error: string;
  expected?: string[];
  code?: string;
}

export async function runSessionCreate(
  fs: FileSystemPort,
  paths: PathsService,
  input: SessionCreateInput,
): Promise<SessionCreateFullOutput | SessionCreateError> {
  const validated = validateInput(input);
  if ("error" in validated) return validated;
  const { type, name, objetivo } = validated;

  const folderInfo = await claimSessionFolder(fs, paths, name, input.contextId);
  if ("error" in folderInfo) return folderInfo;

  const sessionPath = folderInfo.sessionPath;
  const origin = input.originRaw?.trim();
  const sessionFilePath = canonicalArtifactPath(sessionPath, "session");
  await fs.writeText(
    sessionFilePath,
    renderSessionMarkdown({
      name,
      type,
      objetivo,
      ...(origin && origin.length > 0 ? { origin } : {}),
    }),
  );

  const record: SessionCreateRecordOutput = {
    type,
    name,
    number: folderInfo.number,
    folder: folderInfo.folder,
    path: sessionPath,
    session_path: sessionFilePath,
  };
  if (origin && origin.length > 0) record.origin = origin;

  return { sessionCreate: record };
}

interface ValidatedInput {
  type: SessionType;
  name: string;
  objetivo: string;
}

function validateInput(input: SessionCreateInput): ValidatedInput | SessionCreateError {
  const type = input.type?.trim().toLowerCase();
  if (!type) {
    return {
      error: "--type es obligatorio (research|refine|exec|quick)",
      expected: [...VALID_TYPES],
    };
  }
  if (!(VALID_TYPES as readonly string[]).includes(type)) {
    return {
      error: `--type inválido '${type}'; esperado research|refine|exec|quick`,
      expected: [...VALID_TYPES],
    };
  }
  const name = input.name?.trim();
  if (!name) return { error: "--name es obligatorio" };
  const objetivo = input.objetivo?.trim();
  if (!objetivo) return { error: "--objetivo es obligatorio" };
  return { type: type as SessionType, name, objetivo };
}

interface FolderInfo {
  folder: string;
  number: string;
  sessionPath: string;
}

/**
 * Claim number + folder + conversation association under ONE lock: two
 * concurrent creations must not read the same counter and race for the same
 * `NNN`, and the new line must belong to its conversation the moment it exists.
 */
async function claimSessionFolder(
  fs: FileSystemPort,
  paths: PathsService,
  name: string,
  contextId: string | undefined,
): Promise<FolderInfo | SessionCreateError> {
  const id = contextId?.trim() ?? "";
  // `failure` (not `error`) so the busy-lock envelope `withCwdLock` returns
  // stays distinguishable from a failure raised inside the critical section.
  type Locked = { ok: true; info: FolderInfo } | { ok: false; failure: SessionCreateError };

  const result = await withCwdLock(fs, paths, async (): Promise<Locked> => {
    // Fail before creating anything when the registry cannot be read: a session
    // that exists but could not be associated is worse than one never created.
    if (id.length > 0) {
      const registry = await readBindingRegistry(fs, paths);
      if (!registry.ok) {
        return {
          ok: false,
          failure: { error: registry.reason, code: "SESSION_BINDING_INVALID" },
        };
      }
    }
    const sessionsDir = paths.cwdSessionsDir();
    await fs.mkdirp(sessionsDir);
    // The CLI owns the session number: a single global, sequential counter across
    // ALL sessions in `.workflow/sessions/` (any type), so numbering never resets
    // per type nor collides. Callers pass only the descriptor via `--name`; the
    // `NNN-` prefix is assigned here. A descriptor that already carries a leading
    // `NNN-` is normalized away first so the prefix can't double up.
    const descriptor = name.replace(/^\d{3}-/, "");
    const number = await nextSessionNumber(fs, sessionsDir);
    const folder = `${number}-${descriptor}`;
    const sessionPath = join(sessionsDir, folder);
    if (await fs.exists(sessionPath)) {
      return { ok: false, failure: { error: `Ya existe ${sessionPath}` } };
    }
    await fs.mkdirp(sessionPath);
    if (id.length > 0) await bindContextToSession(fs, paths, id, folder);
    return { ok: true, info: { folder, number, sessionPath } };
  });

  if ("error" in result) return { error: result.error, code: "LOCK_BUSY" };
  return result.ok ? result.info : result.failure;
}

/**
 * Next global session number: scan `.workflow/sessions/` for any entry whose name
 * starts with a 3-digit code and return max+1, zero-padded. Type-agnostic — one
 * sequence for every session regardless of kind. Legacy `sessionNNN-…` folders
 * (no leading digit) don't match and are ignored, so the new sequence starts fresh.
 */
async function nextSessionNumber(fs: FileSystemPort, sessionsDir: string): Promise<string> {
  const entries = await fs.list(sessionsDir);
  let max = 0;
  for (const entry of entries) {
    const m = entry.name.match(/^(\d{3})/);
    if (m?.[1]) max = Math.max(max, Number.parseInt(m[1], 10));
  }
  return String(max + 1).padStart(3, "0");
}
