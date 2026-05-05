import { join } from "node:path";
import type { Phase, SessionState } from "../domain/types.js";
import type { EnvPort } from "../ports/env.js";
import type { FileSystemPort } from "../ports/file-system.js";
import type { PathsService } from "./paths-service.js";
import {
  type SessionEntry,
  buildSessionEntry,
  listSessionFolders,
  serializeSessionEntry,
} from "./session-resolver.js";

export type { SessionEntry };

export interface ListSessionsInput {
  includeLegacy?: boolean;
  state?: SessionState | "all";
  verbose?: boolean;
}

export interface ListSessionsOutput {
  sessions: SessionEntry[];
  active_count: number;
  closed_count: number;
  total_count: number;
  next_correlative: string;
  legacy?: SessionEntry[];
  history_exists?: boolean;
}

export class SessionsService {
  constructor(
    private readonly fs: FileSystemPort,
    private readonly env: EnvPort,
    private readonly paths: PathsService,
  ) {}

  async list(input: ListSessionsInput = {}): Promise<ListSessionsOutput> {
    const cwd = this.env.cwd();
    const sessionsDir = this.paths.cwdSessionsDir();
    const sessions = await this.scanFolder(sessionsDir, undefined, cwd, input.verbose === true);

    const legacyEntries: SessionEntry[] = [];
    if (input.includeLegacy === true) {
      for (const prefix of [".claude", ".codex"] as const) {
        const dir = join(cwd, prefix, "sessions");
        const entries = await this.scanFolder(dir, prefix, cwd, input.verbose === true);
        legacyEntries.push(...entries);
      }
    }

    const qtcCodes = new Set(sessions.map((s) => s.code).filter((c): c is string => c !== null));
    const legacy = legacyEntries.filter((l) => l.code === null || !qtcCodes.has(l.code));

    const numericCodes = sessions
      .map((s) => s.code)
      .filter((c): c is string => c !== null && /^\d+$/.test(c))
      .map((c) => Number.parseInt(c, 10));
    const nextCorr =
      numericCodes.length > 0 ? String(Math.max(...numericCodes) + 1).padStart(3, "0") : "001";

    const activeCount = sessions.filter((s) => s.state === "active").length;
    const closedCount = sessions.filter((s) => s.state === "closed").length;

    const filtered = applyFilter(sessions, input);

    const payload: ListSessionsOutput = {
      sessions: filtered,
      active_count: activeCount,
      closed_count: closedCount,
      total_count: sessions.length,
      next_correlative: nextCorr,
    };

    if (input.includeLegacy === true || legacy.length > 0) {
      payload.legacy = legacy;
    }
    if (input.verbose === true) {
      payload.history_exists = await this.fs.exists(this.paths.cwdHistoryFile());
    }

    return payload;
  }

  private async scanFolder(
    dir: string,
    legacySource: string | undefined,
    cwd: string,
    verbose: boolean,
  ): Promise<SessionEntry[]> {
    const folders = await listSessionFolders(this.fs, dir);
    const result: SessionEntry[] = [];
    for (const folder of folders) {
      const opts: { verbose: boolean; legacySource?: string } = { verbose };
      if (legacySource !== undefined) {
        opts.legacySource = legacySource;
      }
      const built = await buildSessionEntry(this.fs, folder.path, folder.name, opts);
      result.push(serializeSessionEntry(built, cwd, { verbose }));
    }
    return result;
  }
}

function applyFilter(sessions: SessionEntry[], input: ListSessionsInput): SessionEntry[] {
  if (input.state && input.state !== "all") {
    return sessions.filter((s) => s.state === input.state);
  }
  if (input.state === "all" || input.verbose === true) {
    return sessions;
  }
  return sessions.filter((s) => s.state === "active");
}

// Backwards-compat re-export. Other modules may import { parseSessionFolder } from this file.
export { parseSessionFolder, KNOWN_FLOWS } from "./session-resolver.js";

// Suppress unused-import warning for type Phase used elsewhere historically.
export type { Phase };
