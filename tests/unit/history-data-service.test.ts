import { describe, expect, it } from "vitest";
import { runHistoryDataCommand } from "../../src/application/history-data-service.js";
import { PathsService } from "../../src/application/paths-service.js";
import type { EnvPort } from "../../src/ports/env.js";
import type { DirEntry, FileStat, FileSystemPort } from "../../src/ports/file-system.js";
import { normalizeNamespace } from "../../src/runtime/namespace.js";

class FakeEnv implements EnvPort {
  get() {
    return undefined;
  }
  homeDir() {
    return "/home/u";
  }
  cwd() {
    return "/cwd";
  }
}

class FakeFs implements FileSystemPort {
  constructor(
    private files: Map<string, string> = new Map(),
    private dirs: Map<string, DirEntry[]> = new Map(),
  ) {}
  async readText(p: string) {
    const v = this.files.get(p);
    if (v === undefined) throw new Error(`ENOENT: ${p}`);
    return v;
  }
  async writeText(): Promise<void> {}
  async exists(p: string) {
    return this.files.has(p) || this.dirs.has(p);
  }
  async list(p: string): Promise<DirEntry[]> {
    const v = this.dirs.get(p);
    if (v === undefined) throw new Error(`ENOENT: ${p}`);
    return v;
  }
  async mkdirp(): Promise<void> {}
  async stat(p: string): Promise<FileStat> {
    if (this.files.has(p)) {
      return {
        mtime: new Date("2026-01-01"),
        size: (this.files.get(p) ?? "").length,
        type: "file",
      };
    }
    return { mtime: new Date("2026-01-01"), size: 0, type: "dir" };
  }
}

const ns = normalizeNamespace("workflow");
const paths = new PathsService(ns, "/home/u", "/cwd");
const baseSessionsDir = "/cwd/.workflow/sessions";

function fsWithSessions(codes: string[]): FakeFs {
  const files = new Map<string, string>();
  const dirEntries: DirEntry[] = [];
  for (const c of codes) {
    const folder = `session${c}-dev-foo`;
    const path = `${baseSessionsDir}/${folder}`;
    files.set(`${path}/OBJETIVO.md`, `# ${c}`);
    dirEntries.push({ name: folder, path, type: "dir" });
  }
  const dirs = new Map<string, DirEntry[]>([[baseSessionsDir, dirEntries]]);
  for (const c of codes) {
    dirs.set(`${baseSessionsDir}/session${c}-dev-foo`, []);
  }
  return new FakeFs(files, dirs);
}

describe("runHistoryDataCommand --sessions filter", () => {
  it("returns all sessions when no filter", async () => {
    const fs = fsWithSessions(["001", "002", "003"]);
    const result = await runHistoryDataCommand(fs, new FakeEnv(), paths, {});
    expect(result.sessions).toHaveLength(3);
  });

  it("filters discretely by sessions array", async () => {
    const fs = fsWithSessions(["001", "002", "003", "005"]);
    const result = await runHistoryDataCommand(fs, new FakeEnv(), paths, {
      sessions: ["003", "001"],
    });
    expect(result.sessions).toHaveLength(2);
    expect(result.sessions.map((s) => s.code)).toEqual(["001", "003"]);
  });

  it("throws UNKNOWN_SESSION when requested code does not exist", async () => {
    const fs = fsWithSessions(["001"]);
    await expect(
      runHistoryDataCommand(fs, new FakeEnv(), paths, { sessions: ["999"] }),
    ).rejects.toThrow(/999/);
  });

  it("treats sessions=[] as no filter (returns all)", async () => {
    const fs = fsWithSessions(["001", "002"]);
    const result = await runHistoryDataCommand(fs, new FakeEnv(), paths, { sessions: [] });
    expect(result.sessions).toHaveLength(2);
  });

  it("preserves totals counter even when filtered", async () => {
    const fs = fsWithSessions(["001", "002", "003"]);
    const result = await runHistoryDataCommand(fs, new FakeEnv(), paths, {
      sessions: ["002"],
    });
    expect(result.totals?.all).toBe(1);
  });
});
