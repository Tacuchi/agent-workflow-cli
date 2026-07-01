import { describe, expect, it } from "vitest";
import { PathsService } from "../../src/application/paths-service.js";
import { loadLogs } from "../../src/cli/tui/data/logs.js";
import type { CliContext } from "../../src/cli/types.js";
import type { DirEntry, FileStat } from "../../src/ports/file-system.js";
import { normalizeNamespace } from "../../src/runtime/namespace.js";

const paths = new PathsService(normalizeNamespace("agent-workflow"), "/home/u", "/cwd");
const LOGS = "/home/u/.agent-workflow/logs";

class FakeFs {
  constructor(
    private entries: DirEntry[],
    private stats: Map<string, FileStat>,
    private throwOnList = false,
  ) {}
  async list(): Promise<DirEntry[]> {
    if (this.throwOnList) throw new Error("ENOENT");
    return this.entries;
  }
  async stat(p: string): Promise<FileStat> {
    const s = this.stats.get(p);
    if (!s) throw new Error(`no stat ${p}`);
    return s;
  }
}

function ctxWith(fs: unknown): CliContext {
  return { fs, paths } as unknown as CliContext;
}

function entry(name: string, type: DirEntry["type"] = "file"): DirEntry {
  return { name, path: `${LOGS}/${name}`, type };
}

describe("loadLogs", () => {
  it("lists only daily log files, newest (mtime) first, with date + size", async () => {
    const entries = [
      entry("agent-workflow-2026-06-30.log"),
      entry("agent-workflow-2026-07-01.log"),
      entry("notes.txt"), // ignored: not a daily log
      entry("subdir", "dir"), // ignored: not a file
    ];
    const stats = new Map<string, FileStat>([
      [
        `${LOGS}/agent-workflow-2026-06-30.log`,
        { mtime: new Date(2026, 5, 30), size: 100, type: "file" },
      ],
      [
        `${LOGS}/agent-workflow-2026-07-01.log`,
        { mtime: new Date(2026, 6, 1), size: 250, type: "file" },
      ],
    ]);
    const logs = await loadLogs(ctxWith(new FakeFs(entries, stats)));
    expect(logs.map((l) => l.name)).toEqual([
      "agent-workflow-2026-07-01.log",
      "agent-workflow-2026-06-30.log",
    ]);
    expect(logs[0]?.date).toBe("2026-07-01");
    expect(logs[0]?.sizeBytes).toBe(250);
    expect(logs[0]?.path).toBe(`${LOGS}/agent-workflow-2026-07-01.log`);
  });

  it("returns [] when the logs dir does not exist", async () => {
    const logs = await loadLogs(ctxWith(new FakeFs([], new Map(), true)));
    expect(logs).toEqual([]);
  });
});
