import type { FileSystemPort } from "../../ports/file-system.js";
import type { ResolvedRuntime } from "../../runtime/types.js";
import type { PathsService } from "../paths-service.js";
import { relpath } from "../paths.js";
import { listExistingArtifacts } from "../session-artifacts.js";
import { type SessionEntry, buildSessionEntry } from "../session-resolver.js";
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

    const present = await listExistingArtifacts(folder.path, fs);
    const hasObjetivo = present.objective !== null;
    const hasRequirements = present.requirements !== null;
    entry.is_legacy_format = hasRequirements && !hasObjetivo;
    entry.release_eligible = !entry.is_legacy_format;
    result.push(entry);
  }
  return result;
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
