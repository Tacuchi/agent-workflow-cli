import { describe, expect, it } from "vitest";
import { runResumeSummary } from "../../src/application/checkpoint-service.js";
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
  public mtimeByPath: Map<string, Date> = new Map();
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
    const mtime = this.mtimeByPath.get(p) ?? new Date();
    if (this.files.has(p)) {
      return { mtime, size: (this.files.get(p) ?? "").length, type: "file" };
    }
    if (this.dirs.has(p)) {
      return { mtime, size: 0, type: "dir" };
    }
    throw new Error(`ENOENT: ${p}`);
  }
}

const ns = normalizeNamespace("workflow");
const paths = new PathsService(ns, "/home/u", "/cwd");
const baseSessionsDir = "/cwd/.workflow/sessions";

function buildAnalyzeSession(
  code: string,
  complete: boolean,
): {
  folder: string;
  path: string;
  artifacts: Record<string, string>;
} {
  const folder = `session${code}-analyze-foo`;
  const path = `${baseSessionsDir}/${folder}`;
  const artifacts: Record<string, string> = {
    [`${path}/OBJECTIVE.md`]: `# ${code}`,
  };
  if (complete) {
    artifacts[`${path}/EVIDENCE.md`] = "# E";
    artifacts[`${path}/FINDINGS.md`] = "# F";
    artifacts[`${path}/CONCLUSIONS.md`] = "# C";
  }
  return { folder, path, artifacts };
}

function buildDevSession(
  code: string,
  totalTasks: number,
  closedTasks: number,
  withDecisions: boolean,
): { folder: string; path: string; artifacts: Record<string, string> } {
  const folder = `session${code}-dev-foo`;
  const path = `${baseSessionsDir}/${folder}`;
  const lines: string[] = [];
  for (let i = 1; i <= totalTasks; i++) {
    const mark = i <= closedTasks ? "x" : " ";
    lines.push(`- [${mark}] T${i} — task ${i}`);
  }
  const artifacts: Record<string, string> = {
    [`${path}/OBJECTIVE.md`]: `# ${code}`,
    [`${path}/TASKS.md`]: `# Tasks\n\n${lines.join("\n")}\n`,
  };
  if (withDecisions) {
    artifacts[`${path}/DECISIONS.md`] = "## DEC-001 — foo";
  }
  return { folder, path, artifacts };
}

function buildDesignSession(
  code: string,
  withDelivery: boolean,
): { folder: string; path: string; artifacts: Record<string, string> } {
  const folder = `session${code}-design-foo`;
  const path = `${baseSessionsDir}/${folder}`;
  const artifacts: Record<string, string> = {
    [`${path}/OBJECTIVE.md`]: `# ${code}`,
  };
  if (withDelivery) {
    artifacts[`${path}/DELIVERY.md`] = "# D";
  }
  return { folder, path, artifacts };
}

function buildFs(
  sessions: Array<{ folder: string; path: string; artifacts: Record<string, string>; mtime: Date }>,
): FakeFs {
  const files = new Map<string, string>();
  const dirs = new Map<string, DirEntry[]>();
  const baseEntries: DirEntry[] = [];
  for (const s of sessions) {
    baseEntries.push({ name: s.folder, path: s.path, type: "dir" });
    const folderFiles: DirEntry[] = [];
    for (const [p, c] of Object.entries(s.artifacts)) {
      files.set(p, c);
      const base = p.slice(p.lastIndexOf("/") + 1);
      folderFiles.push({ name: base, path: p, type: "file" });
    }
    dirs.set(s.path, folderFiles);
  }
  dirs.set(baseSessionsDir, baseEntries);
  const fs = new FakeFs(files, dirs);
  for (const s of sessions) fs.mtimeByPath.set(s.path, s.mtime);
  return fs;
}

describe("runResumeSummary --include-recent-closed", () => {
  it("returns undefined recent_closed_with_artifacts when flag not set (default off)", async () => {
    const now = new Date("2026-05-18T22:00:00Z");
    const s1 = buildAnalyzeSession("062", true);
    const fs = buildFs([{ ...s1, mtime: now }]);
    const result = await runResumeSummary(fs, new FakeEnv(), paths);
    expect(result.recent_closed_with_artifacts).toBeUndefined();
  });

  it("returns empty array when flag set but no closed sessions in window", async () => {
    const fs = buildFs([]);
    const result = await runResumeSummary(fs, new FakeEnv(), paths, {
      includeRecentClosed: true,
    });
    expect(result.recent_closed_with_artifacts).toEqual([]);
  });

  it("detects analyze session with EVIDENCE+FINDINGS+CONCLUSIONS as complete", async () => {
    const now = Date.now();
    const recentMtime = new Date(now - 1000 * 60 * 60); // 1 hora atrás
    const s1 = buildAnalyzeSession("062", true);
    const fs = buildFs([{ ...s1, mtime: recentMtime }]);
    const result = await runResumeSummary(fs, new FakeEnv(), paths, {
      includeRecentClosed: true,
    });
    expect(result.recent_closed_with_artifacts).toHaveLength(1);
    const entry = result.recent_closed_with_artifacts?.[0];
    expect(entry?.code).toBe("062");
    expect(entry?.flow).toBe("analyze");
    expect(entry?.complete).toBe(true);
    expect(entry?.artifact_signal).toBe("EVIDENCE+FINDINGS+CONCLUSIONS");
  });

  it("excludes analyze session without CONCLUSIONS", async () => {
    const recentMtime = new Date(Date.now() - 1000);
    const s1 = buildAnalyzeSession("062", false);
    const fs = buildFs([{ ...s1, mtime: recentMtime }]);
    const result = await runResumeSummary(fs, new FakeEnv(), paths, {
      includeRecentClosed: true,
    });
    expect(result.recent_closed_with_artifacts).toEqual([]);
  });

  it("detects dev session with >=50% tasks closed + DECISIONS as complete", async () => {
    const recentMtime = new Date(Date.now() - 1000);
    const s = buildDevSession("057", 4, 3, true); // 75% closed
    const fs = buildFs([{ ...s, mtime: recentMtime }]);
    const result = await runResumeSummary(fs, new FakeEnv(), paths, {
      includeRecentClosed: true,
    });
    expect(result.recent_closed_with_artifacts).toHaveLength(1);
    expect(result.recent_closed_with_artifacts?.[0]?.complete).toBe(true);
    expect(result.recent_closed_with_artifacts?.[0]?.artifact_signal).toContain("TASKS>=50%");
  });

  it("excludes dev session with <50% tasks closed", async () => {
    const recentMtime = new Date(Date.now() - 1000);
    const s = buildDevSession("057", 4, 1, true); // 25% closed
    const fs = buildFs([{ ...s, mtime: recentMtime }]);
    const result = await runResumeSummary(fs, new FakeEnv(), paths, {
      includeRecentClosed: true,
    });
    expect(result.recent_closed_with_artifacts).toEqual([]);
  });

  it("excludes dev session without DECISIONS even if tasks ok", async () => {
    const recentMtime = new Date(Date.now() - 1000);
    const s = buildDevSession("057", 4, 4, false);
    const fs = buildFs([{ ...s, mtime: recentMtime }]);
    const result = await runResumeSummary(fs, new FakeEnv(), paths, {
      includeRecentClosed: true,
    });
    expect(result.recent_closed_with_artifacts).toEqual([]);
  });

  it("detects design session with DELIVERY as complete", async () => {
    const recentMtime = new Date(Date.now() - 1000);
    const s = buildDesignSession("056", true);
    const fs = buildFs([{ ...s, mtime: recentMtime }]);
    const result = await runResumeSummary(fs, new FakeEnv(), paths, {
      includeRecentClosed: true,
    });
    expect(result.recent_closed_with_artifacts).toHaveLength(1);
    expect(result.recent_closed_with_artifacts?.[0]?.artifact_signal).toBe("DELIVERY");
  });

  it("excludes design session without DELIVERY", async () => {
    const recentMtime = new Date(Date.now() - 1000);
    const s = buildDesignSession("056", false);
    const fs = buildFs([{ ...s, mtime: recentMtime }]);
    const result = await runResumeSummary(fs, new FakeEnv(), paths, {
      includeRecentClosed: true,
    });
    expect(result.recent_closed_with_artifacts).toEqual([]);
  });

  it("excludes sessions outside the recentDays window", async () => {
    const oldMtime = new Date(Date.now() - 1000 * 60 * 60 * 24 * 10); // 10 días atrás
    const s = buildAnalyzeSession("062", true);
    const fs = buildFs([{ ...s, mtime: oldMtime }]);
    const result = await runResumeSummary(fs, new FakeEnv(), paths, {
      includeRecentClosed: true,
      recentDays: 7,
    });
    expect(result.recent_closed_with_artifacts).toEqual([]);
  });

  it("respects custom recentDays window", async () => {
    const mtime = new Date(Date.now() - 1000 * 60 * 60 * 24 * 5); // 5 días atrás
    const s = buildAnalyzeSession("062", true);
    const fs = buildFs([{ ...s, mtime }]);
    const r1 = await runResumeSummary(fs, new FakeEnv(), paths, {
      includeRecentClosed: true,
      recentDays: 7,
    });
    expect(r1.recent_closed_with_artifacts).toHaveLength(1);
    const r2 = await runResumeSummary(fs, new FakeEnv(), paths, {
      includeRecentClosed: true,
      recentDays: 3,
    });
    expect(r2.recent_closed_with_artifacts).toEqual([]);
  });

  it("sorts results by code descending (most recent first)", async () => {
    const recentMtime = new Date(Date.now() - 1000);
    const s1 = buildAnalyzeSession("055", true);
    const s2 = buildAnalyzeSession("062", true);
    const s3 = buildAnalyzeSession("049", true);
    const fs = buildFs([
      { ...s1, mtime: recentMtime },
      { ...s2, mtime: recentMtime },
      { ...s3, mtime: recentMtime },
    ]);
    const result = await runResumeSummary(fs, new FakeEnv(), paths, {
      includeRecentClosed: true,
    });
    expect(result.recent_closed_with_artifacts?.map((e) => e.code)).toEqual(["062", "055", "049"]);
  });
});
