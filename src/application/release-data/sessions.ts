import { join } from "node:path";
import type { FileSystemPort } from "../../ports/file-system.js";
import type { ResolvedRuntime } from "../../runtime/types.js";
import { validateSessionsExist } from "../parsers/sessions-csv.js";
import type { PathsService } from "../paths-service.js";
import { relpath } from "../paths.js";
import { listExistingArtifacts } from "../session-artifacts.js";
import { type SessionEntry, buildSessionEntry, listSessionFolders } from "../session-resolver.js";
import { sessionCodeInt } from "./common.js";

export interface ReleaseSession extends SessionEntry {
  is_legacy_format?: boolean;
  release_eligible?: boolean;
  legacy_warning?: string;
}

export async function listSessionsForRelease(
  fs: FileSystemPort,
  cwd: string,
  paths: PathsService,
  options: {
    since?: string;
    includeOpen?: boolean;
    includeClosed?: boolean;
    sessions?: string[];
  } = {},
): Promise<ReleaseSession[]> {
  void cwd;
  const includeOpen = options.includeOpen ?? true;
  const includeClosed = options.includeClosed ?? true;
  const sessionsDir = paths.cwdSessionsDir();
  if (!(await fs.exists(sessionsDir))) return [];

  const sessionsFilter = options.sessions;
  const useDiscrete = sessionsFilter !== undefined && sessionsFilter.length > 0;
  if (useDiscrete) {
    await validateSessionsExist(fs, sessionsDir, sessionsFilter);
  }
  const filter: ReleaseFilter = {
    wanted: useDiscrete ? new Set(sessionsFilter) : null,
    sinceInt: useDiscrete ? null : sessionCodeInt(options.since),
    includeOpen,
    includeClosed,
  };

  // New model: enumerate every session folder (slug-named), not just legacy session###-.
  const result: ReleaseSession[] = [];
  for (const folder of await listSessionFolders(fs, sessionsDir)) {
    const entry = (await buildSessionEntry(fs, folder.path, folder.name)) as ReleaseSession;
    if (!includeReleaseEntry(entry, filter)) continue;
    await annotateReleaseEntry(entry, folder.path, fs);
    result.push(entry);
  }
  return result;
}

interface ReleaseFilter {
  wanted: Set<string> | null;
  sinceInt: number | null;
  includeOpen: boolean;
  includeClosed: boolean;
}

function includeReleaseEntry(entry: ReleaseSession, filter: ReleaseFilter): boolean {
  if (filter.wanted !== null) {
    if (entry.code === null || !filter.wanted.has(entry.code)) return false;
  } else {
    const codeInt = sessionCodeInt(entry.code);
    if (filter.sinceInt !== null && codeInt !== null && codeInt <= filter.sinceInt) return false;
  }
  if (entry.state === "active" && !filter.includeOpen) return false;
  if (entry.state === "closed" && !filter.includeClosed) return false;
  return true;
}

async function annotateReleaseEntry(
  entry: ReleaseSession,
  folderPath: string,
  fs: FileSystemPort,
): Promise<void> {
  const present = await listExistingArtifacts(folderPath, fs);
  const hasObjetivo = present.session !== null || present.objective !== null;
  // REQUIREMENTS.md is a pre-0.9 marker (no longer a tracked kind): probe directly.
  const hasRequirements = await fs.exists(join(folderPath, "REQUIREMENTS.md"));
  entry.is_legacy_format = hasRequirements && !hasObjetivo;
  entry.release_eligible = !entry.is_legacy_format;
}

export function enrichSessionsWithLegacyMeta(
  sessions: ReleaseSession[],
  cwd: string,
  runtime: ResolvedRuntime | undefined,
): { enriched: ReleaseSession[]; legacy: string[] } {
  const migrateCmd = runtime?.slashCommands?.migrate ?? "(run namespace-specific migrate command)";
  const enriched: ReleaseSession[] = [];
  const legacy: string[] = [];
  for (const s of sessions) {
    const item = { ...s };
    if (s.is_legacy_format) {
      legacy.push(s.folder);
      item.legacy_warning = `Sesión usa formato pre-0.9 (REQUIREMENTS.md). Migrar con ${migrateCmd} --upgrade-topology antes de release.`;
    }
    if (item.path) item.path = relpath(item.path, cwd);
    enriched.push(item);
  }
  return { enriched, legacy };
}
