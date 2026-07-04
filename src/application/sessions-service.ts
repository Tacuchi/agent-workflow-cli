import type { SessionState } from "../domain/types.js";
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
    const sessions = await this.scanFolder(sessionsDir, cwd, input.verbose === true);

    // Legacy .claude/.codex session scan removed: sessions live only under
    // .workflow/sessions now. `legacy` retained as an always-empty field for
    // output-shape compatibility until callers are reworked.
    const legacy: SessionEntry[] = [];

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

  private async scanFolder(dir: string, cwd: string, verbose: boolean): Promise<SessionEntry[]> {
    const folders = await listSessionFolders(this.fs, dir);
    const result: SessionEntry[] = [];
    for (const folder of folders) {
      const built = await buildSessionEntry(this.fs, folder.path, folder.name);
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
export { parseSessionFolder } from "./session-resolver.js";
