import { join } from "node:path";
import { compareCorrelatives, sameCorrelative } from "../../domain/correlative.js";
import type { FileSystemPort } from "../../ports/file-system.js";
import type { ResolvedRuntime } from "../../runtime/types.js";
import { SessionsCsvError, validateSessionsExist } from "../parsers/sessions-csv.js";
import type { PathsService } from "../paths-service.js";
import { relpath } from "../paths.js";
import { listExistingArtifacts } from "../session-artifacts.js";
import { type SessionEntry, buildSessionEntry, listSessionFolders } from "../session-resolver.js";
import { sessionCorrelative } from "./common.js";

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

  const sessionsFilter = normalizeSessionFilters(options.sessions);
  const useDiscrete = sessionsFilter !== undefined && sessionsFilter.length > 0;
  if (useDiscrete) {
    await validateSessionsExist(fs, sessionsDir, sessionsFilter);
  }
  const filter: ReleaseFilter = {
    wanted: useDiscrete ? sessionsFilter : null,
    since: useDiscrete ? null : sessionCorrelative(options.since),
    includeOpen,
    includeClosed,
  };

  // Enumerate every session folder — slug-named ones too, not just legacy session###-.
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
  wanted: string[] | null;
  since: string | null;
  includeOpen: boolean;
  includeClosed: boolean;
}

/**
 * `export-*` also replays a sealed scope, and older scopes named a session by
 * its folder rather than only its number. Normalize those input spellings here;
 * the filter and every persisted artifact still use a complete correlative.
 */
function normalizeSessionFilters(input: readonly string[] | undefined): string[] | undefined {
  if (input === undefined) return undefined;
  const normalized: string[] = [];
  for (const raw of input) {
    const code = sessionCorrelative(raw);
    if (code === null) {
      throw new SessionsCsvError(
        "INVALID_INPUT",
        `--sessions: token inválido '${raw}' (esperado: correlativo o carpeta de sesión)`,
      );
    }
    if (normalized.some((existing) => sameCorrelative(existing, code))) {
      throw new SessionsCsvError("INVALID_INPUT", `--sessions: código duplicado '${raw}'`);
    }
    normalized.push(code);
  }
  return normalized;
}

function includeReleaseEntry(entry: ReleaseSession, filter: ReleaseFilter): boolean {
  const code = sessionCorrelative(entry.folder) ?? sessionCorrelative(entry.code);
  if (filter.wanted !== null) {
    const matchesWanted = filter.wanted.some((wanted) => {
      const wantedCode = sessionCorrelative(wanted);
      return wantedCode !== null && code !== null && sameCorrelative(wantedCode, code);
    });
    if (!matchesWanted) {
      return false;
    }
  } else {
    if (filter.since !== null && code !== null && compareCorrelatives(code, filter.since) <= 0) {
      return false;
    }
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
