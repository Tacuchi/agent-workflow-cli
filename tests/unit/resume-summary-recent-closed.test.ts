import { describe, expect, it } from "vitest";
import { runResumeSummary } from "../../src/application/checkpoint-service.js";
import { PathsService } from "../../src/application/paths-service.js";
import { normalizeNamespace } from "../../src/runtime/namespace.js";
import { FakeEnv } from "../helpers/fake-env.js";
import { MemFs } from "../helpers/mem-fs.js";

const ns = normalizeNamespace("workflow");
const paths = new PathsService(ns, "/home/u", "/cwd");
const baseSessionsDir = "/cwd/.workflow/sessions";

interface SessionSpec {
  folder: string;
  path: string;
  artifacts: Record<string, string>;
}

/**
 * A closed session carries the `.closed` sentinel. Completeness in the new model
 * is type-agnostic: CONCLUSIONS.md or ANALYSIS-FILE.md present.
 */
function buildClosedSession(
  code: string,
  opts: { conclusions?: boolean; analysisFile?: boolean; closed?: boolean } = {},
): SessionSpec {
  const folder = `session${code}-foo`;
  const path = `${baseSessionsDir}/${folder}`;
  const artifacts: Record<string, string> = {
    [`${path}/OBJECTIVE.md`]: `# ${code}`,
  };
  if (opts.closed !== false) artifacts[`${path}/.closed`] = "";
  if (opts.conclusions) artifacts[`${path}/CONCLUSIONS.md`] = "# C";
  if (opts.analysisFile) artifacts[`${path}/ANALYSIS-FILE.md`] = "# A";
  return { folder, path, artifacts };
}

function buildFs(sessions: Array<SessionSpec & { mtime: Date }>): MemFs {
  const fs = new MemFs();
  fs.dir(baseSessionsDir);
  for (const s of sessions) {
    // Seed the session-dir mtime BEFORE its artifacts so it survives the
    // new Date(0) that file auto-registration would otherwise assign.
    fs.dir(s.path, s.mtime);
    for (const [p, c] of Object.entries(s.artifacts)) fs.file(p, c);
  }
  return fs;
}

describe("runResumeSummary --include-recent-closed", () => {
  it("returns undefined recent_closed_with_artifacts when flag not set (default off)", async () => {
    const now = new Date("2026-05-18T22:00:00Z");
    const s1 = buildClosedSession("062", { conclusions: true });
    const fs = buildFs([{ ...s1, mtime: now }]);
    const result = await runResumeSummary(fs, new FakeEnv("/home/u", "/cwd"), paths);
    expect(result.recent_closed_with_artifacts).toBeUndefined();
  });

  it("returns empty array when flag set but no closed sessions in window", async () => {
    const fs = buildFs([]);
    const result = await runResumeSummary(fs, new FakeEnv("/home/u", "/cwd"), paths, {
      includeRecentClosed: true,
    });
    expect(result.recent_closed_with_artifacts).toEqual([]);
  });

  it("detects closed session with CONCLUSIONS as complete", async () => {
    const recentMtime = new Date(Date.now() - 1000 * 60 * 60); // 1 hour ago
    const s1 = buildClosedSession("062", { conclusions: true });
    const fs = buildFs([{ ...s1, mtime: recentMtime }]);
    const result = await runResumeSummary(fs, new FakeEnv("/home/u", "/cwd"), paths, {
      includeRecentClosed: true,
    });
    expect(result.recent_closed_with_artifacts).toHaveLength(1);
    const entry = result.recent_closed_with_artifacts?.[0];
    expect(entry?.code).toBe("062");
    expect(entry?.complete).toBe(true);
    expect(entry?.artifact_signal).toBe("CONCLUSIONS");
  });

  it("detects closed session with ANALYSIS-FILE as complete", async () => {
    const recentMtime = new Date(Date.now() - 1000);
    const s1 = buildClosedSession("063", { analysisFile: true });
    const fs = buildFs([{ ...s1, mtime: recentMtime }]);
    const result = await runResumeSummary(fs, new FakeEnv("/home/u", "/cwd"), paths, {
      includeRecentClosed: true,
    });
    expect(result.recent_closed_with_artifacts).toHaveLength(1);
    expect(result.recent_closed_with_artifacts?.[0]?.artifact_signal).toBe("ANALYSIS-FILE");
  });

  it("excludes closed session without any closure artifact", async () => {
    const recentMtime = new Date(Date.now() - 1000);
    const s1 = buildClosedSession("062", {});
    const fs = buildFs([{ ...s1, mtime: recentMtime }]);
    const result = await runResumeSummary(fs, new FakeEnv("/home/u", "/cwd"), paths, {
      includeRecentClosed: true,
    });
    expect(result.recent_closed_with_artifacts).toEqual([]);
  });

  it("excludes sessions that are NOT closed (no .closed sentinel)", async () => {
    const recentMtime = new Date(Date.now() - 1000);
    const s1 = buildClosedSession("062", { conclusions: true, closed: false });
    const fs = buildFs([{ ...s1, mtime: recentMtime }]);
    const result = await runResumeSummary(fs, new FakeEnv("/home/u", "/cwd"), paths, {
      includeRecentClosed: true,
    });
    expect(result.recent_closed_with_artifacts).toEqual([]);
  });

  it("excludes sessions outside the recentDays window", async () => {
    const oldMtime = new Date(Date.now() - 1000 * 60 * 60 * 24 * 10); // 10 days ago
    const s = buildClosedSession("062", { conclusions: true });
    const fs = buildFs([{ ...s, mtime: oldMtime }]);
    const result = await runResumeSummary(fs, new FakeEnv("/home/u", "/cwd"), paths, {
      includeRecentClosed: true,
      recentDays: 7,
    });
    expect(result.recent_closed_with_artifacts).toEqual([]);
  });

  it("respects custom recentDays window", async () => {
    const mtime = new Date(Date.now() - 1000 * 60 * 60 * 24 * 5); // 5 days ago
    const s = buildClosedSession("062", { conclusions: true });
    const fs = buildFs([{ ...s, mtime }]);
    const r1 = await runResumeSummary(fs, new FakeEnv("/home/u", "/cwd"), paths, {
      includeRecentClosed: true,
      recentDays: 7,
    });
    expect(r1.recent_closed_with_artifacts).toHaveLength(1);
    const r2 = await runResumeSummary(fs, new FakeEnv("/home/u", "/cwd"), paths, {
      includeRecentClosed: true,
      recentDays: 3,
    });
    expect(r2.recent_closed_with_artifacts).toEqual([]);
  });

  it("sorts results by code descending (most recent first)", async () => {
    const recentMtime = new Date(Date.now() - 1000);
    const s1 = buildClosedSession("055", { conclusions: true });
    const s2 = buildClosedSession("062", { conclusions: true });
    const s3 = buildClosedSession("049", { conclusions: true });
    const fs = buildFs([
      { ...s1, mtime: recentMtime },
      { ...s2, mtime: recentMtime },
      { ...s3, mtime: recentMtime },
    ]);
    const result = await runResumeSummary(fs, new FakeEnv("/home/u", "/cwd"), paths, {
      includeRecentClosed: true,
    });
    expect(result.recent_closed_with_artifacts?.map((e) => e.code)).toEqual(["062", "055", "049"]);
  });
});
