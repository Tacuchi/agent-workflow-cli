// Mirror de qtc_core/release.py: cmd_release_data + helpers públicos.
import { join } from "node:path";
import type { EnvPort } from "../ports/env.js";
import type { FileSystemPort } from "../ports/file-system.js";
import { parseProjectBlock } from "./parsers/project-block.js";
import type { PathsService } from "./paths-service.js";
import { relpath } from "./paths.js";
import { type SessionEntry, buildSessionEntry, parseSessionFolder } from "./session-resolver.js";

const ARTIFACT_FILES: Record<string, string> = {
  objetivo: "OBJETIVO.md",
  decisiones: "DECISIONES.md",
  tasks: "TASKS.md",
  dependencias: "DEPENDENCIAS.md",
  checkpoint: "CHECKPOINT.md",
};
const SCRIPTS_SUBDIR = "scripts";

export interface ReleaseSession extends SessionEntry {
  is_legacy_format?: boolean;
  release_eligible?: boolean;
  legacy_warning?: string;
}

export interface GraduatedBundle {
  nnn: string;
  session_code: string;
  slug: string;
  path: string;
  forward_count: number;
  rollback_count: number;
}

export interface ReleaseDataInput {
  since?: string;
  sourceAlias?: string;
  includeGraduated?: boolean;
  includeOpen?: boolean;
  includeClosed?: boolean;
  skipContent?: boolean;
  verbose?: boolean;
}

export interface ReleaseDataOutput {
  workspace_mode: "project" | "hub";
  source_alias: string | null;
  docs_root: string;
  release_root: string;
  sessions: ReleaseSession[];
  sessions_count: number;
  is_hub?: boolean;
  legacy_sessions?: string[];
  since?: string;
  graduated_bundles?: GraduatedBundle[];
}

export interface ReleaseDataError {
  error: string;
  workspace_mode?: "project" | "hub";
}

function sessionCodeInt(code: string | null | undefined): number | null {
  if (!code) return null;
  let s = String(code)
    .trim()
    .replace(/session/g, "");
  s = (s.split("-")[0] ?? "").trim();
  const n = Number.parseInt(s, 10);
  return Number.isNaN(n) ? null : n;
}

export async function listSessionsForRelease(
  fs: FileSystemPort,
  cwd: string,
  paths: PathsService,
  options: { since?: string; includeOpen?: boolean; includeClosed?: boolean } = {},
): Promise<ReleaseSession[]> {
  void cwd;
  const includeOpen = options.includeOpen ?? true;
  const includeClosed = options.includeClosed ?? true;
  const qtcDir = paths.cwdSessionsDir();
  if (!(await fs.exists(qtcDir))) return [];

  const sinceInt = sessionCodeInt(options.since);
  const entries = (await fs.list(qtcDir))
    .filter((e) => e.type === "dir" && /^session\d{3}-/.test(e.name))
    .sort((a, b) => a.name.localeCompare(b.name));

  const result: ReleaseSession[] = [];
  for (const folder of entries) {
    const entry = (await buildSessionEntry(fs, folder.path, folder.name)) as ReleaseSession;
    const codeInt = sessionCodeInt(entry.code);
    if (sinceInt !== null && codeInt !== null && codeInt <= sinceInt) continue;
    if (entry.state === "active" && !includeOpen) continue;
    if (entry.state === "closed" && !includeClosed) continue;

    const hasObjetivo = await fs.exists(join(folder.path, "OBJETIVO.md"));
    const hasRequirements = await fs.exists(join(folder.path, "REQUIREMENTS.md"));
    entry.is_legacy_format = hasRequirements && !hasObjetivo;
    entry.release_eligible = !entry.is_legacy_format;
    result.push(entry);
  }
  return result;
}

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
): Promise<SessionArtifactsResult> {
  void env;
  const qtcDir = paths.cwdSessionsDir();
  const targetInt = sessionCodeInt(sessionCode);
  if (!(await fs.exists(qtcDir)) || targetInt === null) {
    return { error: `session_not_found:${sessionCode}` };
  }
  const folders = (await fs.list(qtcDir)).filter(
    (e) => e.type === "dir" && /^session\d{3}-/.test(e.name),
  );
  const match = folders.find((f) => sessionCodeInt(parseSessionFolder(f.name).code) === targetInt);
  if (!match) return { error: `session_not_found:${sessionCode}` };

  const sessionPath = match.path;
  const folderName = match.name;

  const hasReq = await fs.exists(join(sessionPath, "REQUIREMENTS.md"));
  const hasObj = await fs.exists(join(sessionPath, "OBJETIVO.md"));
  if (hasReq && !hasObj) {
    return {
      error: "legacy_format",
      session: folderName,
      path: sessionPath,
      hint: "La sesión usa REQUIREMENTS.md (formato pre-0.9). Migrar con /qtc-core:migrate --upgrade-topology antes de consumir release.",
    };
  }

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
      const scriptsDir = join(sessionPath, SCRIPTS_SUBDIR);
      if (!(await fs.exists(scriptsDir))) {
        result.scripts = [];
        continue;
      }
      const files = await collectFilesByExt(fs, scriptsDir, ".sql");
      files.sort((a, b) => a.localeCompare(b));
      const items = [];
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
      result.scripts = items;
      continue;
    }
    const filename = ARTIFACT_FILES[kind];
    if (!filename) {
      (result as Record<string, unknown>)[kind] = { error: `unknown_kind:${kind}` };
      continue;
    }
    const artifactPath = join(sessionPath, filename);
    if (await fs.exists(artifactPath)) {
      try {
        const content = await fs.readText(artifactPath);
        const size = (await fs.stat(artifactPath)).size;
        (result as Record<string, unknown>)[kind] = {
          path: artifactPath,
          content,
          size,
        };
      } catch (e) {
        (result as Record<string, unknown>)[kind] = {
          path: artifactPath,
          error: (e as Error).message,
        };
      }
    } else {
      (result as Record<string, unknown>)[kind] = null;
    }
  }
  return result;
}

export async function listGraduatedBundles(
  fs: FileSystemPort,
  cwd: string,
  paths: PathsService,
  options: { sessionCode?: string; sourceAlias?: string } = {},
): Promise<GraduatedBundle[]> {
  let docsDir: string;
  try {
    docsDir = await getDocsDir(fs, cwd, paths, options.sourceAlias);
  } catch {
    return [];
  }
  const scriptsDir = join(docsDir, "scripts");
  if (!(await fs.exists(scriptsDir))) return [];

  const targetCode = options.sessionCode ? sessionCodeInt(options.sessionCode) : null;
  const dirEntries = (await fs.list(scriptsDir))
    .filter((e) => e.type === "dir")
    .sort((a, b) => a.name.localeCompare(b.name));

  const bundles: GraduatedBundle[] = [];
  for (const entry of dirEntries) {
    const m = entry.name.match(/^(\d{3})-session(\d{3})-(.+)$/);
    if (!m || !m[1] || !m[2] || !m[3]) continue;
    const nnn = m[1];
    const sessionNnn = m[2];
    const slug = m[3];
    if (targetCode !== null && Number.parseInt(sessionNnn, 10) !== targetCode) continue;
    const sqlFiles = await collectFilesByExt(fs, entry.path, ".sql");
    const rollback = sqlFiles.filter((f) => f.endsWith(".rollback.sql"));
    const forward = sqlFiles.filter((f) => !f.endsWith(".rollback.sql"));
    bundles.push({
      nnn,
      session_code: sessionNnn,
      slug,
      path: entry.path,
      forward_count: forward.length,
      rollback_count: rollback.length,
    });
  }
  return bundles;
}

async function getDocsDir(
  fs: FileSystemPort,
  cwd: string,
  paths: PathsService,
  sourceAlias: string | undefined,
): Promise<string> {
  if (!sourceAlias) return join(cwd, "docs");
  const sources = await readSources(fs, cwd, paths);
  const found = sources.find((s) => s.alias === sourceAlias);
  if (!found) {
    throw new Error(
      `Fuente '${sourceAlias}' no encontrada. Aliases disponibles: ${sources
        .map((s) => s.alias)
        .join(", ")}`,
    );
  }
  return join(found.path, "docs");
}

async function getReleaseDir(
  fs: FileSystemPort,
  cwd: string,
  paths: PathsService,
  sourceAlias: string | undefined,
): Promise<string> {
  return join(await getDocsDir(fs, cwd, paths, sourceAlias), "release");
}

async function readSources(
  fs: FileSystemPort,
  cwd: string,
  paths: PathsService,
): Promise<{ alias: string; path: string }[]> {
  for (const file of [join(cwd, "CLAUDE.md"), join(cwd, "AGENTS.md")]) {
    if (!(await fs.exists(file))) continue;
    const block = parseProjectBlock(await fs.readText(file), paths.blockMarkers());
    if (block) return block.fuentes;
  }
  return [];
}

async function readWorkspaceMode(
  fs: FileSystemPort,
  cwd: string,
  paths: PathsService,
): Promise<"project" | "hub"> {
  for (const file of [join(cwd, "CLAUDE.md"), join(cwd, "AGENTS.md")]) {
    if (!(await fs.exists(file))) continue;
    const block = parseProjectBlock(await fs.readText(file), paths.blockMarkers());
    if (block) return block.mode;
  }
  return "project";
}

async function collectFilesByExt(fs: FileSystemPort, dir: string, ext: string): Promise<string[]> {
  const result: string[] = [];
  const stack: string[] = [dir];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) break;
    let entries: Awaited<ReturnType<FileSystemPort["list"]>>;
    try {
      entries = await fs.list(current);
    } catch {
      continue;
    }
    for (const e of entries) {
      if (e.type === "dir") stack.push(e.path);
      else if (e.type === "file" && e.name.endsWith(ext)) result.push(e.path);
    }
  }
  return result;
}

export async function runReleaseData(
  fs: FileSystemPort,
  env: EnvPort,
  paths: PathsService,
  input: ReleaseDataInput,
): Promise<ReleaseDataOutput | ReleaseDataError> {
  const cwd = env.cwd();
  const verbose = input.verbose ?? false;
  const includeGraduated = input.includeGraduated ?? false;
  const includeOpen = input.includeOpen ?? true;
  const includeClosed = input.includeClosed ?? true;

  const workspaceMode = await readWorkspaceMode(fs, cwd, paths);

  let docsRoot: string;
  let releaseRoot: string;
  try {
    docsRoot = await getDocsDir(fs, cwd, paths, input.sourceAlias);
    releaseRoot = await getReleaseDir(fs, cwd, paths, input.sourceAlias);
  } catch (e) {
    return { error: (e as Error).message, workspace_mode: workspaceMode };
  }

  const sinceOpts: { since?: string; includeOpen?: boolean; includeClosed?: boolean } = {
    includeOpen,
    includeClosed,
  };
  if (input.since !== undefined) sinceOpts.since = input.since;
  const sessions = await listSessionsForRelease(fs, cwd, paths, sinceOpts);

  const enriched: ReleaseSession[] = [];
  const legacy: string[] = [];
  for (const s of sessions) {
    const item = { ...s };
    if (s.is_legacy_format) {
      legacy.push(s.folder);
      item.legacy_warning =
        "Sesión usa formato pre-0.9 (REQUIREMENTS.md). Migrar con /qtc-core:migrate --upgrade-topology antes de release.";
    }
    // Mirror Python build_session_entry compact=True: path always relative.
    if (item.path) item.path = relpath(item.path, cwd);
    enriched.push(item);
  }

  const payload: ReleaseDataOutput = {
    workspace_mode: workspaceMode,
    source_alias: input.sourceAlias ?? null,
    docs_root: verbose ? docsRoot : relpath(docsRoot, cwd),
    release_root: verbose ? releaseRoot : relpath(releaseRoot, cwd),
    sessions: enriched,
    sessions_count: enriched.length,
  };
  if (verbose) {
    payload.is_hub = workspaceMode === "hub";
    payload.legacy_sessions = legacy;
    if (input.since !== undefined) payload.since = input.since;
  } else {
    if (legacy.length > 0) payload.legacy_sessions = legacy;
    if (input.since !== undefined) payload.since = input.since;
  }

  if (includeGraduated) {
    const opts: { sourceAlias?: string } = {};
    if (input.sourceAlias !== undefined) opts.sourceAlias = input.sourceAlias;
    payload.graduated_bundles = await listGraduatedBundles(fs, cwd, paths, opts);
  }
  return payload;
}
