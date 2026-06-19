import { join } from "node:path";
import type { SessionType } from "../domain/types.js";
import type { EnvPort } from "../ports/env.js";
import type { FileSystemPort } from "../ports/file-system.js";
import type { PathsService } from "./paths-service.js";
import { canonicalArtifactPath } from "./session-artifacts.js";
import { renderSessionMarkdown } from "./templates/session.js";

const VALID_TYPES = ["research", "refine", "exec", "quick"] as const;

export interface SessionCreateInput {
  type?: string;
  name?: string;
  objetivo?: string;
  /** Optional plain origin string (who/where the session was created from). */
  originRaw?: string;
}

export interface SessionCreateRecordOutput {
  type: SessionType;
  name: string;
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
  _env: EnvPort,
  paths: PathsService,
  input: SessionCreateInput,
): Promise<SessionCreateFullOutput | SessionCreateError> {
  const validated = validateInput(input);
  if ("error" in validated) return validated;
  const { type, name, objetivo } = validated;

  const folderInfo = await prepareSessionFolder(fs, paths, name);
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
  sessionPath: string;
  sessionsDir: string;
}

async function prepareSessionFolder(
  fs: FileSystemPort,
  paths: PathsService,
  name: string,
): Promise<FolderInfo | SessionCreateError> {
  const sessionsDir = paths.cwdSessionsDir();
  await fs.mkdirp(sessionsDir);
  // Folder is the --name verbatim (locked decision): no numeric NNN, no type suffix.
  const folder = name;
  const sessionPath = join(sessionsDir, folder);
  if (await fs.exists(sessionPath)) {
    return { error: `Ya existe ${sessionPath}` };
  }
  await fs.mkdirp(sessionPath);
  return { folder, sessionPath, sessionsDir };
}
