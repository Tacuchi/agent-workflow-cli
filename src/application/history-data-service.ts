import type { EnvPort } from "../ports/env.js";
import type { FileSystemPort } from "../ports/file-system.js";
import { validateSessionsExist } from "./parsers/sessions-csv.js";
import type { PathsService } from "./paths-service.js";
import {
  type SessionEntry,
  buildSessionEntry,
  listSessionFolders,
  parseSessionFolder,
  serializeSessionEntry,
} from "./session-resolver.js";

const HISTORY_ROW_RE = /^\|\s*(\d{3})\s*\|/gm;

export interface HistoryDataInput {
  verbose?: boolean;
  includeDocs?: boolean;
  sessions?: string[];
}

export interface HistoryDocsInfo {
  manuales: string[];
  decisiones: string[];
  unlinked_manuales: string[];
  unlinked_decisiones: string[];
}

export interface HistoryDataOutput {
  sessions: SessionEntry[];
  totals?: { active: number; closed: number; all: number };
  existing_history_rows: string[];
  docs?: HistoryDocsInfo;
}

export async function runHistoryDataCommand(
  fs: FileSystemPort,
  env: EnvPort,
  paths: PathsService,
  input: HistoryDataInput,
): Promise<HistoryDataOutput> {
  const cwd = env.cwd();
  const sessionsDir = paths.cwdSessionsDir();
  const allFolders = await listSessionFolders(fs, sessionsDir);
  const verbose = input.verbose === true;
  const includeDocs = input.includeDocs === true;

  let folders = allFolders;
  if (input.sessions !== undefined && input.sessions.length > 0) {
    await validateSessionsExist(fs, sessionsDir, input.sessions);
    const wanted = new Set(input.sessions);
    folders = allFolders.filter((f) => {
      const { code } = parseSessionFolder(f.name);
      return code !== null && wanted.has(code);
    });
  }

  const sessions: SessionEntry[] = [];
  for (const folder of folders) {
    const built = await buildSessionEntry(fs, folder.path, folder.name, { verbose });
    const entry = serializeSessionEntry(built, cwd, { verbose });
    if (verbose || includeDocs) {
      // Python adds refs={mt,mf,dec[]} when verbose or include_docs.
      (
        entry as SessionEntry & { refs: { mt: string | null; mf: string | null; dec: string[] } }
      ).refs = {
        mt: null,
        mf: null,
        dec: [],
      };
    }
    sessions.push(entry);
  }

  const docsInfo: HistoryDocsInfo = {
    manuales: [],
    decisiones: [],
    unlinked_manuales: [],
    unlinked_decisiones: [],
  };
  // Docs scanning is currently unused in tests/fixtures; deferred until needed.

  const historyPath = paths.cwdHistoryFile();
  const existingRows: string[] = [];
  if (await fs.exists(historyPath)) {
    const text = await fs.readText(historyPath);
    let m: RegExpExecArray | null = HISTORY_ROW_RE.exec(text);
    while (m !== null) {
      if (m[1] !== undefined) existingRows.push(m[1]);
      m = HISTORY_ROW_RE.exec(text);
    }
    HISTORY_ROW_RE.lastIndex = 0;
  }

  if (!verbose) {
    const active = sessions.filter((s) => s.state === "active").length;
    const closed = sessions.filter((s) => s.state === "closed").length;
    const compact: HistoryDataOutput = {
      sessions,
      totals: { active, closed, all: sessions.length },
      existing_history_rows: existingRows,
    };
    if (includeDocs) {
      compact.docs = docsInfo;
    }
    return compact;
  }

  return {
    sessions,
    docs: docsInfo,
    existing_history_rows: existingRows,
  };
}
