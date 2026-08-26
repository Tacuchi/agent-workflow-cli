import type { SessionState } from "../domain/types.js";
import type { EnvPort } from "../ports/env.js";
import type { FileSystemPort } from "../ports/file-system.js";
import type { PathsService } from "./paths-service.js";
import {
  type SessionEntry,
  buildSessionEntry,
  listSessionFolders,
  nextSessionCorrelative,
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
    _env: EnvPort,
    private readonly paths: PathsService,
  ) {}

  async list(input: ListSessionsInput = {}): Promise<ListSessionsOutput> {
    const cwd = this.paths.workspaceDir();
    const sessionsDir = this.paths.cwdSessionsDir();
    const sessions = await this.scanFolder(sessionsDir, cwd, input.verbose === true);

    // Legacy .claude/.codex session scan removed: sessions live only under
    // .workflow/sessions now. `legacy` retained as an always-empty field for
    // output-shape compatibility until callers are reworked.
    const legacy: SessionEntry[] = [];

    // The number this reports is the number `session-create` will assign: one
    // derivation, no chance of announcing a correlative somebody else spends.
    // It used to filter all-digit codes over a field that holds the whole folder
    // name in the current model, so it counted the legacy folders and nothing
    // else.
    const nextCorr = await nextSessionCorrelative(this.fs, this.paths);

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
