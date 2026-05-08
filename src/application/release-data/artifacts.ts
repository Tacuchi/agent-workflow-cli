import { join } from "node:path";
import type { EnvPort } from "../../ports/env.js";
import type { FileSystemPort } from "../../ports/file-system.js";
import type { ResolvedRuntime } from "../../runtime/types.js";
import type { PathsService } from "../paths-service.js";
import { buildSessionEntry, parseSessionFolder } from "../session-resolver.js";
import { collectFilesByExt, sessionCodeInt } from "./common.js";

const ARTIFACT_FILES: Record<string, string> = {
  objetivo: "OBJETIVO.md",
  decisiones: "DECISIONES.md",
  tasks: "TASKS.md",
  dependencias: "DEPENDENCIAS.md",
  checkpoint: "CHECKPOINT.md",
};
const SCRIPTS_SUBDIR = "scripts";

export interface SessionArtifactsResult {
  session?: string;
  path?: string;
  code?: string | null;
  flow?: string | null;
  state?: string;
  phase?: string;
  scripts?: { name: string; path: string; size: number | null; is_rollback: boolean }[];
  error?: string;
  hint?: string;
  [k: string]:
    | unknown
    | { path: string; content: string; size: number }
    | { path: string; error: string }
    | { error: string }
    | null;
}

export async function readSessionArtifacts(
  fs: FileSystemPort,
  env: EnvPort,
  paths: PathsService,
  sessionCode: string,
  kinds?: string[],
  runtime?: ResolvedRuntime,
): Promise<SessionArtifactsResult> {
  void env;
  const found = await findSessionFolder(fs, paths.cwdSessionsDir(), sessionCode);
  if (!found) return { error: `session_not_found:${sessionCode}` };

  const { sessionPath, folderName } = found;

  const legacyCheck = await detectLegacyFormat(fs, sessionPath, folderName, runtime);
  if (legacyCheck) return legacyCheck;

  const entry = await buildSessionEntry(fs, sessionPath, folderName);
  const result: SessionArtifactsResult = {
    session: entry.folder,
    path: entry.path,
    code: entry.code,
    flow: entry.flow,
    state: entry.state,
    phase: entry.phase,
  };

  const targetKinds = kinds ?? [...Object.keys(ARTIFACT_FILES), "scripts"];
  for (const kind of targetKinds) {
    if (kind === "scripts") {
      result.scripts = await readScriptsArtifacts(fs, sessionPath);
    } else {
      (result as Record<string, unknown>)[kind] = await readArtifactKind(fs, sessionPath, kind);
    }
  }
  return result;
}

async function findSessionFolder(
  fs: FileSystemPort,
  qtcDir: string,
  sessionCode: string,
): Promise<{ sessionPath: string; folderName: string } | null> {
  const targetInt = sessionCodeInt(sessionCode);
  if (!(await fs.exists(qtcDir)) || targetInt === null) return null;
  const folders = (await fs.list(qtcDir)).filter(
    (e) => e.type === "dir" && /^session\d{3}-/.test(e.name),
  );
  const match = folders.find((f) => sessionCodeInt(parseSessionFolder(f.name).code) === targetInt);
  if (!match) return null;
  return { sessionPath: match.path, folderName: match.name };
}

async function detectLegacyFormat(
  fs: FileSystemPort,
  sessionPath: string,
  folderName: string,
  runtime: ResolvedRuntime | undefined,
): Promise<SessionArtifactsResult | null> {
  const hasReq = await fs.exists(join(sessionPath, "REQUIREMENTS.md"));
  const hasObj = await fs.exists(join(sessionPath, "OBJETIVO.md"));
  if (!hasReq || hasObj) return null;
  const migrateCmd = runtime?.slashCommands?.migrate ?? "(run namespace-specific migrate command)";
  return {
    error: "legacy_format",
    session: folderName,
    path: sessionPath,
    hint: `La sesión usa REQUIREMENTS.md (formato pre-0.9). Migrar con ${migrateCmd} --upgrade-topology antes de consumir release.`,
  };
}

async function readScriptsArtifacts(
  fs: FileSystemPort,
  sessionPath: string,
): Promise<{ name: string; path: string; size: number | null; is_rollback: boolean }[]> {
  const scriptsDir = join(sessionPath, SCRIPTS_SUBDIR);
  if (!(await fs.exists(scriptsDir))) return [];
  const files = await collectFilesByExt(fs, scriptsDir, ".sql");
  files.sort((a, b) => a.localeCompare(b));
  const items: { name: string; path: string; size: number | null; is_rollback: boolean }[] = [];
  for (const f of files) {
    let size: number | null = null;
    try {
      size = (await fs.stat(f)).size;
    } catch {
      // ignore
    }
    items.push({
      name: f.split("/").pop() ?? f,
      path: f,
      size,
      is_rollback: f.endsWith(".rollback.sql"),
    });
  }
  return items;
}

async function readArtifactKind(
  fs: FileSystemPort,
  sessionPath: string,
  kind: string,
): Promise<unknown> {
  const filename = ARTIFACT_FILES[kind];
  if (!filename) return { error: `unknown_kind:${kind}` };
  const artifactPath = join(sessionPath, filename);
  if (!(await fs.exists(artifactPath))) return null;
  try {
    const content = await fs.readText(artifactPath);
    const size = (await fs.stat(artifactPath)).size;
    return { path: artifactPath, content, size };
  } catch (e) {
    return { path: artifactPath, error: (e as Error).message };
  }
}
