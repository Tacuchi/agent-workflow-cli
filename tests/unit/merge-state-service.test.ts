import { describe, expect, it } from "vitest";
import { runMergeState } from "../../src/application/merge-state-service.js";
import { PathsService } from "../../src/application/paths-service.js";
import { renderProjectBlock } from "../../src/application/render/project-block.js";
import type { EnvPort } from "../../src/ports/env.js";
import type { DirEntry, FileStat, FileSystemPort } from "../../src/ports/file-system.js";
import { normalizeNamespace } from "../../src/runtime/namespace.js";
import { RecordingGit } from "../helpers/fake-git.js";

// ── minimal in-memory fs (block read only) ──────────────────────────────────

class FakeFs implements FileSystemPort {
  private files = new Map<string, string>();
  private dirs = new Set<string>();
  private children = new Map<string, Map<string, DirEntry>>();

  file(path: string, content: string): this {
    this.files.set(path, content);
    this.register(path, "file");
    return this;
  }
  private register(path: string, type: DirEntry["type"]): void {
    const parent = path.slice(0, path.lastIndexOf("/")) || "/";
    if (parent === path) return;
    const kids = this.children.get(parent) ?? new Map<string, DirEntry>();
    kids.set(path.slice(path.lastIndexOf("/") + 1), {
      name: path.slice(path.lastIndexOf("/") + 1),
      path,
      type,
    });
    this.children.set(parent, kids);
    this.dirs.add(parent);
    this.register(parent, "dir");
  }
  async readText(p: string): Promise<string> {
    const v = this.files.get(p);
    if (v === undefined) throw new Error(`ENOENT: ${p}`);
    return v;
  }
  async writeText(p: string, c: string): Promise<void> {
    this.file(p, c);
  }
  async writeTextExclusive(p: string, c: string): Promise<{ created: boolean }> {
    if (this.files.has(p)) return { created: false };
    this.file(p, c);
    return { created: true };
  }
  async remove(p: string): Promise<void> {
    this.files.delete(p);
  }
  async exists(p: string): Promise<boolean> {
    return this.files.has(p) || this.dirs.has(p);
  }
  async list(p: string): Promise<DirEntry[]> {
    const kids = this.children.get(p);
    if (kids === undefined) throw new Error(`ENOENT: ${p}`);
    return [...kids.values()];
  }
  async mkdirp(p: string): Promise<void> {
    this.dirs.add(p);
  }
  async stat(p: string): Promise<FileStat> {
    if (this.files.has(p))
      return { mtime: new Date(0), size: (this.files.get(p) ?? "").length, type: "file" };
    if (this.dirs.has(p)) return { mtime: new Date(0), size: 0, type: "dir" };
    throw new Error(`ENOENT: ${p}`);
  }
}

const env: EnvPort = { get: () => undefined, homeDir: () => "/home", cwd: () => "/cwd" };

function paths(): PathsService {
  return new PathsService(normalizeNamespace("agent-workflow"), "/cwd", "/cwd");
}

function blockWith(fs: FakeFs, fuentes: { alias: string; path: string }[]): FakeFs {
  fs.file(
    "/cwd/CLAUDE.md",
    renderProjectBlock({
      proyecto: "Test",
      fuentes: fuentes.map((f) => ({ alias: f.alias, path: f.path, main_branch: "main" })),
      stack: {},
      lastActivity: "2026-01-01 00:00",
      workingBranches: {},
      qaBranches: {},
    }),
  );
  return fs;
}

// ── tests ────────────────────────────────────────────────────────────────────

describe("runMergeState — single repo (cwd, workspace-independent)", () => {
  it("no merge in progress → is_merging false, empty conflicts", async () => {
    const git = new RecordingGit({ currentBranch: "main" });
    const out = await runMergeState(new FakeFs(), git, env, paths(), {});
    expect(out.any_merging).toBe(false);
    expect(out.repos).toHaveLength(1);
    expect(out.repos[0]).toEqual({
      alias: null,
      path: "/cwd",
      is_repo: true,
      is_merging: false,
      current_branch: "main",
      merge_origin: null,
      conflicted_files: [],
      dirty: false,
    });
  });

  it("merge in progress → origin (theirs), destination (ours), conflicted files", async () => {
    const git = new RecordingGit({
      currentBranch: "main",
      merging: true,
      conflicted: ["src/a.ts", "src/b.ts"],
      mergeOrigin: "feature/x",
    });
    const out = await runMergeState(new FakeFs(), git, env, paths(), {});
    expect(out.any_merging).toBe(true);
    expect(out.repos[0]).toMatchObject({
      is_merging: true,
      current_branch: "main", // destination (ours)
      merge_origin: "feature/x", // origin (theirs)
      conflicted_files: ["src/a.ts", "src/b.ts"],
    });
  });

  it("not a git repo → is_repo false, everything null/empty (graceful)", async () => {
    const git = new RecordingGit({ isRepo: false });
    const out = await runMergeState(new FakeFs(), git, env, paths(), {});
    expect(out.repos[0]).toMatchObject({
      is_repo: false,
      is_merging: false,
      current_branch: null,
      merge_origin: null,
      conflicted_files: [],
    });
  });

  it("explicit path arg → inspects that repo (no workspace needed)", async () => {
    const git = new RecordingGit({
      currentBranch: "release",
      merging: true,
      mergeOrigin: "hotfix",
    });
    const out = await runMergeState(new FakeFs(), git, env, paths(), { path: "/elsewhere/repo" });
    expect(out.repos).toHaveLength(1);
    expect(out.repos[0]).toMatchObject({
      alias: null,
      path: "/elsewhere/repo",
      is_merging: true,
      merge_origin: "hotfix",
    });
  });
});

describe("runMergeState — workspace sources", () => {
  it("--all scans every source in the WORKSPACE block", async () => {
    const fs = blockWith(new FakeFs(), [
      { alias: "core", path: "/repo/core" },
      { alias: "ui", path: "/repo/ui" },
    ]);
    const git = new RecordingGit({ currentBranch: "main", merging: true, mergeOrigin: "feat" });
    const out = await runMergeState(fs, git, env, paths(), { all: true });
    expect(out.repos).toHaveLength(2);
    expect(out.repos.map((r) => r.alias).sort()).toEqual(["core", "ui"]);
    expect(out.repos.map((r) => r.path).sort()).toEqual(["/repo/core", "/repo/ui"]);
    expect(out.any_merging).toBe(true);
  });

  it("--source <alias> inspects only that source", async () => {
    const fs = blockWith(new FakeFs(), [
      { alias: "core", path: "/repo/core" },
      { alias: "ui", path: "/repo/ui" },
    ]);
    const git = new RecordingGit({ currentBranch: "main" });
    const out = await runMergeState(fs, git, env, paths(), { source: "core" });
    expect(out.repos).toHaveLength(1);
    expect(out.repos[0]).toMatchObject({ alias: "core", path: "/repo/core" });
  });

  it("--all with no workspace block → empty repos (graceful, no throw)", async () => {
    const git = new RecordingGit({ currentBranch: "main" });
    const out = await runMergeState(new FakeFs(), git, env, paths(), { all: true });
    expect(out.repos).toEqual([]);
    expect(out.any_merging).toBe(false);
  });
});
