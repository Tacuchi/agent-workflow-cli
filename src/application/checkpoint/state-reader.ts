import { join } from "node:path";
import type { DirEntry, FileSystemPort } from "../../ports/file-system.js";
import type { DiffNumstatEntry, GitPort } from "../../ports/git.js";
import type { PathsService } from "../paths-service.js";
import { findArtifact, listExistingArtifacts } from "../session-artifacts.js";

export interface SessionState {
  code: string | null;
  name: string;
  folder: string;
  branches: string[];
  tasks: { open: number; closed: number; total: number };
  progress_pct: number | null;
  decisions_count: number;
  last_decision: { id: string; excerpt: string } | null;
  artefacts: Record<string, boolean | number>;
  files_touched: DiffNumstatEntry[];
  origen: string | null;
  timestamp: string;
}

export async function extractSessionState(
  fs: FileSystemPort,
  git: GitPort,
  cwd: string,
  _paths: PathsService,
  sessionPath: string,
): Promise<SessionState> {
  const folder = sessionPath.split(/[\\/]/).pop() ?? "";
  const parsed = parseSessionFolder(folder);
  // Intentionally empty: sessions are not registered in the project block, so
  // there is no branch tracking at session level.
  const branches: string[] = [];

  const tasks = await countTasks(fs, sessionPath);
  const progressPct = tasks.total > 0 ? Math.round((100 * tasks.closed) / tasks.total) : null;
  const decisions = await countDecisions(fs, sessionPath);
  const lastDecision = await readLastDecision(fs, sessionPath);
  const artefacts = await listArtefacts(fs, sessionPath);
  const filesTouched = await git.diffNumstat(cwd);
  const origen = await readOrigen(fs, sessionPath);

  return {
    code: parsed.code,
    name: parsed.name,
    folder,
    branches,
    tasks,
    progress_pct: progressPct,
    decisions_count: decisions,
    last_decision: lastDecision,
    artefacts,
    files_touched: filesTouched,
    origen,
    timestamp: formatNowMinute(),
  };
}

function parseSessionFolder(folder: string): {
  code: string | null;
  name: string;
} {
  const m = folder.match(/^session(\d{3})-(.+)/);
  if (!m || !m[1] || !m[2]) return { code: null, name: folder };
  return { code: m[1], name: m[2] };
}

async function countTasks(
  fs: FileSystemPort,
  sessionPath: string,
): Promise<{ open: number; closed: number; total: number }> {
  const path = await findArtifact(sessionPath, "tasks", fs);
  if (!path) return { open: 0, closed: 0, total: 0 };
  const text = await fs.readText(path);
  const open = (text.match(/^\s*[-*]\s*\[\s\]/gm) ?? []).length;
  const closed = (text.match(/^\s*[-*]\s*\[[xX]\]/gm) ?? []).length;
  return { open, closed, total: open + closed };
}

async function countDecisions(fs: FileSystemPort, sessionPath: string): Promise<number> {
  const path = await findArtifact(sessionPath, "decisions", fs);
  if (!path) return 0;
  const text = await fs.readText(path);
  return (text.match(/^#{2,3}\s+DEC[- ]\d+/gm) ?? []).length;
}

async function readLastDecision(
  fs: FileSystemPort,
  sessionPath: string,
): Promise<{ id: string; excerpt: string } | null> {
  const path = await findArtifact(sessionPath, "decisions", fs);
  if (!path) return null;
  const text = await fs.readText(path);
  const matches = [...text.matchAll(/^#{2,3}\s+(DEC[- ]\d+[^\n]*)$/gm)];
  if (matches.length === 0) return null;
  const last = matches[matches.length - 1];
  if (!last || !last[1]) return null;
  const id = last[1].trim();
  const restStart = (last.index ?? 0) + last[0].length;
  const rest = text.slice(restStart);
  const body = rest.split("\n##", 1)[0] ?? "";
  const firstLine =
    body
      .split("\n")
      .map((l) => l.trim())
      .find((l) => l.length > 0) ?? "";
  return { id, excerpt: firstLine.slice(0, 140) };
}

async function listArtefacts(
  fs: FileSystemPort,
  sessionPath: string,
): Promise<Record<string, boolean | number>> {
  const present = await listExistingArtifacts(sessionPath, fs);
  const scriptsDir = join(sessionPath, "scripts");
  const scriptsCount = (await fs.exists(scriptsDir))
    ? (await listSqlFiles(fs, scriptsDir)).length
    : 0;
  return {
    session: present.session !== null || present.objective !== null,
    tasks: present.tasks !== null,
    decisiones: present.decisions !== null,
    conclusiones: present.conclusions !== null,
    analysis_file: present.analysis_file !== null,
    scripts_count: scriptsCount,
  };
}

async function listSqlFiles(fs: FileSystemPort, dir: string): Promise<string[]> {
  const entries: DirEntry[] = await fs.list(dir);
  const result: string[] = [];
  for (const entry of entries) {
    if (entry.type === "file" && entry.name.endsWith(".sql")) {
      result.push(entry.name);
    }
  }
  return result.sort();
}

async function readOrigen(fs: FileSystemPort, sessionPath: string): Promise<string | null> {
  const path =
    (await findArtifact(sessionPath, "session", fs)) ??
    (await findArtifact(sessionPath, "objective", fs));
  if (!path) return null;
  const text = await fs.readText(path);
  const lines = text.split("\n");
  let inOrigen = false;
  for (const line of lines) {
    if (line.match(/^##\s+(Origen|Origin)\s*$/i)) {
      inOrigen = true;
      continue;
    }
    if (inOrigen) {
      if (line.startsWith("##")) break;
      const trimmed = line.trim();
      if (trimmed.length > 0) return trimmed.slice(0, 140);
    }
  }
  return null;
}

function formatNowMinute(): string {
  const now = new Date();
  const yyyy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const dd = String(now.getDate()).padStart(2, "0");
  const hh = String(now.getHours()).padStart(2, "0");
  const mi = String(now.getMinutes()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd} ${hh}:${mi}`;
}
