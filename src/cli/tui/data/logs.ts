import type { CliContext } from "../../types.js";

/** A daily operational log file surfaced in the [Status] tab's "Logs" section. */
export interface LogEntry {
  /** Absolute path to the log file. */
  path: string;
  /** File name, e.g. `agent-workflow-2026-07-01.log`. */
  name: string;
  /** Calendar day parsed from the name (`YYYY-MM-DD`). */
  date: string;
  /** Size in bytes. */
  sizeBytes: number;
  /** Last-modified time (used for ordering). */
  mtime: Date;
}

const DAILY_LOG = /^agent-workflow-(\d{4}-\d{2}-\d{2})\.log$/;

/**
 * The global, user-level daily logs (`~/.${ns}/logs/agent-workflow-YYYY-MM-DD.log`),
 * newest first by mtime. Returns `[]` when the dir is absent (nothing logged yet).
 */
export async function loadLogs(ctx: CliContext): Promise<LogEntry[]> {
  // Best-effort shell data: any failure (missing dir, fs error) yields [].
  let entries: Awaited<ReturnType<typeof ctx.fs.list>>;
  try {
    entries = await ctx.fs.list(ctx.paths.userLogsDir());
  } catch {
    return [];
  }
  const logs: LogEntry[] = [];
  for (const entry of entries) {
    if (entry.type !== "file") continue;
    const match = DAILY_LOG.exec(entry.name);
    if (!match) continue;
    try {
      const s = await ctx.fs.stat(entry.path);
      logs.push({
        path: entry.path,
        name: entry.name,
        date: match[1] ?? "",
        sizeBytes: s.size,
        mtime: s.mtime,
      });
    } catch {
      // Vanished between list and stat — skip it.
    }
  }
  logs.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
  return logs;
}
