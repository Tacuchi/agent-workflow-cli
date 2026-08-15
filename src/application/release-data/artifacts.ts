import { join } from "node:path";
import type { FileSystemPort } from "../../ports/file-system.js";
import type { ResolvedRuntime } from "../../runtime/types.js";
import type { PathsService } from "../paths-service.js";
import { type ArtifactKind, findArtifact } from "../session-artifacts.js";
import { type SessionResolutionError, resolveSessionTarget } from "../session-resolver.js";
import { collectFilesByExt } from "./common.js";

// Each request-kind maps to an ordered list of on-disk ArtifactKinds tried in
// turn (first match wins). The descriptor request-kind `objetivo` reads the new
// SESSION.md, then the legacy OBJECTIVE.md/OBJETIVO.md. The result key stays
// `objetivo` so it does NOT collide with the top-level `session` folder-name
// field on the result object.
const KIND_TO_ARTIFACT: Record<string, readonly ArtifactKind[]> = {
  objetivo: ["session", "objective"],
  decisiones: ["decisions"],
  conclusiones: ["conclusions"],
  tasks: ["tasks"],
  checkpoint: ["checkpoint"],
  backlog: ["backlog"],
};
const SCRIPTS_SUBDIR = "scripts";

export interface SessionArtifactsResult {
  session?: string;
  path?: string;
  code?: string | null;
  state?: string;
  scripts?: { name: string; path: string; size: number | null; is_rollback: boolean }[];
  /** Canonical resolution failure (code + message + candidates + action). */
  sessionError?: SessionResolutionError;
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
  paths: PathsService,
  sessionCode: string,
  kinds?: string[],
  runtime?: ResolvedRuntime,
): Promise<SessionArtifactsResult> {
  // This is a session-scoped READ reached by `aw session-artifacts --dump --code`.
  // It used to carry its own folder matcher (`sessionCodeInt` over a filtered
  // listing) — the last resolver besides the canonical one. `allowClosed` is on
  // (dumping a finished session's artifacts is the normal case) and `bind` is
  // off: a release/inspection dump is not how a conversation picks its line.
  const resolution = await resolveSessionTarget(fs, paths, {
    intent: "read",
    code: sessionCode,
    allowClosed: true,
  });
  if (resolution.outcome !== "resolved") return { sessionError: resolution };

  const sessionPath = resolution.session.path;
  const folderName = resolution.session.folder;

  const legacyCheck = await detectLegacyFormat(fs, sessionPath, folderName, runtime);
  if (legacyCheck) return legacyCheck;

  const entry = resolution.session;
  const result: SessionArtifactsResult = {
    session: entry.folder,
    path: entry.path,
    code: entry.code,
    state: entry.state,
  };

  const targetKinds = kinds ?? [...Object.keys(KIND_TO_ARTIFACT), "scripts"];
  for (const kind of targetKinds) {
    if (kind === "scripts") {
      result.scripts = await readScriptsArtifacts(fs, sessionPath);
    } else {
      (result as Record<string, unknown>)[kind] = await readArtifactKind(fs, sessionPath, kind);
    }
  }
  return result;
}

async function detectLegacyFormat(
  fs: FileSystemPort,
  sessionPath: string,
  folderName: string,
  runtime: ResolvedRuntime | undefined,
): Promise<SessionArtifactsResult | null> {
  // REQUIREMENTS.md is a pre-0.9 format marker (no longer a tracked kind):
  // probe the filename directly. SESSION.md / OBJECTIVE.md mark the current format.
  const hasReq = await fs.exists(join(sessionPath, "REQUIREMENTS.md"));
  const hasObj =
    (await findArtifact(sessionPath, "session", fs)) !== null ||
    (await findArtifact(sessionPath, "objective", fs)) !== null;
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
  const artifactKinds = KIND_TO_ARTIFACT[kind];
  if (!artifactKinds) return { error: `unknown_kind:${kind}` };
  let artifactPath: string | null = null;
  for (const artifactKind of artifactKinds) {
    artifactPath = await findArtifact(sessionPath, artifactKind, fs);
    if (artifactPath) break;
  }
  if (!artifactPath) return null;
  try {
    const content = await fs.readText(artifactPath);
    const size = (await fs.stat(artifactPath)).size;
    return { path: artifactPath, content, size };
  } catch (e) {
    return { path: artifactPath, error: (e as Error).message };
  }
}
