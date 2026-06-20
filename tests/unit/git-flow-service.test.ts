import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NodeFileSystem } from "../../src/adapters/node-file-system.js";
import { runGitFlow } from "../../src/application/git-flow-service.js";
import { PathsService } from "../../src/application/paths-service.js";
import { renderProjectBlock } from "../../src/application/render/project-block.js";
import { normalizeNamespace } from "../../src/runtime/namespace.js";
import { type GitCall, RecordingGit } from "../helpers/fake-git.js";

const fs = new NodeFileSystem();

interface SourceSpec {
  alias: string;
  path: string;
  main: string;
  work?: string;
  qa?: string;
}

function blockFor(sources: SourceSpec[]): string {
  const workingBranches: Record<string, string> = {};
  const qaBranches: Record<string, string> = {};
  for (const s of sources) {
    if (s.work) workingBranches[s.alias] = s.work;
    if (s.qa) qaBranches[s.alias] = s.qa;
  }
  return renderProjectBlock({
    proyecto: "Test",
    fuentes: sources.map((s) => ({ alias: s.alias, path: s.path, main_branch: s.main })),
    stack: {},
    lastActivity: "2026-01-01 00:00",
    workingBranches,
    qaBranches,
  });
}

/** Only the call ops that touch git (currentBranch/isMerging are probes). */
function opLog(calls: GitCall[]): string[] {
  return calls
    .filter((c) => c.op === "checkout" || c.op === "pull" || c.op === "merge" || c.op === "push")
    .map((c) => (c.arg ? `${c.op} ${c.arg}` : c.op));
}

describe("git-flow service", () => {
  let cwd: string;

  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), "aw-git-flow-"));
  });
  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  function paths(): PathsService {
    return new PathsService(normalizeNamespace("agent-workflow"), cwd, cwd);
  }

  async function writeBlock(sources: SourceSpec[]): Promise<void> {
    await writeFile(join(cwd, "CLAUDE.md"), blockFor(sources), "utf8");
  }

  it("sync: pull work → checkout prod+pull → checkout work + merge prod", async () => {
    await writeBlock([
      { alias: "core", path: "/repo/core", main: "certificacion", work: "feature/x" },
    ]);
    const git = new RecordingGit({ currentBranch: "feature/x" });

    const result = await runGitFlow(fs, git, paths(), { action: "sync", source: "core" });

    expect(result.status).toBe("ok");
    expect(opLog(git.calls)).toEqual([
      "checkout feature/x",
      "pull feature/x",
      "checkout certificacion",
      "pull certificacion",
      "checkout feature/x",
      "merge certificacion",
    ]);
    expect(result.results[0]?.steps.every((s) => s.status === "ok")).toBe(true);
  });

  it("to-qa: sync + checkout qa+pull + merge prod→qa + merge work→qa + push qa", async () => {
    await writeBlock([
      {
        alias: "core",
        path: "/repo/core",
        main: "certificacion",
        work: "feature/x",
        qa: "desarrollo",
      },
    ]);
    const git = new RecordingGit({ currentBranch: "feature/x" });

    const result = await runGitFlow(fs, git, paths(), { action: "to-qa", source: "core" });

    expect(result.status).toBe("ok");
    expect(opLog(git.calls)).toEqual([
      // sync
      "checkout feature/x",
      "pull feature/x",
      "checkout certificacion",
      "pull certificacion",
      "checkout feature/x",
      "merge certificacion",
      // promote to qa
      "checkout desarrollo",
      "pull desarrollo",
      "merge certificacion",
      "merge feature/x",
      "push desarrollo",
    ]);
  });

  it("to-prod: sync + checkout prod+pull + merge work→prod + push prod", async () => {
    await writeBlock([
      { alias: "core", path: "/repo/core", main: "certificacion", work: "feature/x" },
    ]);
    const git = new RecordingGit({ currentBranch: "feature/x" });

    const result = await runGitFlow(fs, git, paths(), { action: "to-prod", source: "core" });

    expect(result.status).toBe("ok");
    expect(opLog(git.calls)).toEqual([
      // sync
      "checkout feature/x",
      "pull feature/x",
      "checkout certificacion",
      "pull certificacion",
      "checkout feature/x",
      "merge certificacion",
      // promote to prod
      "checkout certificacion",
      "pull certificacion",
      "merge feature/x",
      "push certificacion",
    ]);
  });

  it("--target overrides the destination branch (to-qa)", async () => {
    await writeBlock([
      {
        alias: "core",
        path: "/repo/core",
        main: "certificacion",
        work: "feature/x",
        qa: "desarrollo",
      },
    ]);
    const git = new RecordingGit({ currentBranch: "feature/x" });

    const result = await runGitFlow(fs, git, paths(), {
      action: "to-qa",
      source: "core",
      target: "release/2026",
    });

    expect(result.status).toBe("ok");
    const ops = opLog(git.calls);
    // destination is the override, not the declared qa branch
    expect(ops).toContain("checkout release/2026");
    expect(ops).toContain("push release/2026");
    expect(ops).not.toContain("checkout desarrollo");
    expect(ops).not.toContain("push desarrollo");
  });

  it("--dry-run returns the step list and makes no git calls", async () => {
    await writeBlock([
      {
        alias: "core",
        path: "/repo/core",
        main: "certificacion",
        work: "feature/x",
        qa: "desarrollo",
      },
    ]);
    const git = new RecordingGit({ currentBranch: "feature/x" });

    const result = await runGitFlow(fs, git, paths(), {
      action: "to-qa",
      source: "core",
      dryRun: true,
    });

    expect(result.dry_run).toBe(true);
    expect(result.status).toBe("ok");
    expect(git.calls).toEqual([]);
    expect(result.results[0]?.steps.length).toBeGreaterThan(0);
    expect(result.results[0]?.steps.every((s) => s.status === "skipped")).toBe(true);
  });

  it("pauses on merge conflict, reports paused_at + conflicted files, repo left mid-merge", async () => {
    await writeBlock([
      { alias: "core", path: "/repo/core", main: "certificacion", work: "feature/x" },
    ]);
    // Conflict when merging certificacion (the sync merge prod→work, onto feature/x).
    const git = new RecordingGit({
      currentBranch: "feature/x",
      conflicts: { certificacion: ["a.ts", "b.ts"] },
    });

    const result = await runGitFlow(fs, git, paths(), { action: "sync", source: "core" });

    expect(result.status).toBe("conflict");
    const src = result.results[0];
    expect(src?.status).toBe("conflict");
    expect(src?.paused_at).toBe("feature/x");
    expect(src?.conflicted_files).toEqual(["a.ts", "b.ts"]);
    // The conflicting step is recorded as conflict; no push happened.
    expect(opLog(git.calls)).toEqual([
      "checkout feature/x",
      "pull feature/x",
      "checkout certificacion",
      "pull certificacion",
      "checkout feature/x",
      "merge certificacion",
    ]);
    // Repo is still merging (fake tracks MERGE_HEAD state).
    expect(await git.isMerging("/repo/core")).toBe(true);
  });

  it("resume: re-run after resolving the conflict replays idempotently to completion", async () => {
    await writeBlock([
      {
        alias: "core",
        path: "/repo/core",
        main: "certificacion",
        work: "feature/x",
        qa: "desarrollo",
      },
    ]);
    const git = new RecordingGit({
      currentBranch: "feature/x",
      conflicts: { certificacion: ["x.ts"] },
      resolveAfterFirstConflict: true,
    });
    // Run 1: conflict on the sync merge (prod→work).
    const r1 = await runGitFlow(fs, git, paths(), { action: "to-qa", source: "core" });
    expect(r1.status).toBe("conflict");
    // User resolves + commits the merge → MERGE_HEAD cleared (no longer mid-merge).
    git.resolveMerge();
    git.calls.length = 0;
    // Run 2 (resume): replays from the start; already-applied merges are no-ops; completes.
    const r2 = await runGitFlow(fs, git, paths(), { action: "to-qa", source: "core" });
    expect(r2.status).toBe("ok");
    expect(opLog(git.calls)).toEqual([
      "checkout feature/x",
      "pull feature/x",
      "checkout certificacion",
      "pull certificacion",
      "checkout feature/x",
      "merge certificacion",
      "checkout desarrollo",
      "pull desarrollo",
      "merge certificacion",
      "merge feature/x",
      "push desarrollo",
    ]);
  });

  it("resume works when the conflict was on the SECOND qa merge (work→qa)", async () => {
    // Regression: two merges land on the qa branch (prod→qa, work→qa); a conflict
    // on the LATER one must resume correctly (not redo the earlier merge).
    await writeBlock([
      {
        alias: "core",
        path: "/repo/core",
        main: "certificacion",
        work: "feature/x",
        qa: "desarrollo",
      },
    ]);
    const git = new RecordingGit({
      currentBranch: "feature/x",
      conflicts: { "feature/x": ["y.ts"] }, // merging the WORK branch (work→qa) conflicts
      resolveAfterFirstConflict: true,
    });
    const r1 = await runGitFlow(fs, git, paths(), { action: "to-qa", source: "core" });
    expect(r1.status).toBe("conflict");
    expect(r1.results[0]?.paused_at).toBe("desarrollo"); // work→qa lands on the qa branch
    git.resolveMerge();
    const r2 = await runGitFlow(fs, git, paths(), { action: "to-qa", source: "core" });
    expect(r2.status).toBe("ok");
  });

  it("re-running while the conflict is unresolved (mid-merge) errors, does not redo", async () => {
    await writeBlock([
      { alias: "core", path: "/repo/core", main: "certificacion", work: "feature/x" },
    ]);
    const git = new RecordingGit({
      currentBranch: "feature/x",
      conflicts: { certificacion: ["a.ts"] },
    });
    const r1 = await runGitFlow(fs, git, paths(), { action: "sync", source: "core" });
    expect(r1.status).toBe("conflict");
    // No resolve → still mid-merge.
    const r2 = await runGitFlow(fs, git, paths(), { action: "sync", source: "core" });
    expect(r2.status).toBe("error");
    expect(r2.results[0]?.error).toMatch(/in-progress merge|resolve/i);
  });

  it("aborts when the working tree is dirty (no git ops run)", async () => {
    await writeBlock([
      { alias: "core", path: "/repo/core", main: "certificacion", work: "feature/x" },
    ]);
    const git = new RecordingGit({ currentBranch: "feature/x", dirty: true });

    const result = await runGitFlow(fs, git, paths(), { action: "sync", source: "core" });

    expect(result.status).toBe("error");
    expect(result.results[0]?.error).toMatch(/uncommitted|commit or stash/i);
    expect(opLog(git.calls)).toEqual([]);
  });

  it("reports a git failure (e.g. checkout) as error, not a crash", async () => {
    await writeBlock([
      { alias: "core", path: "/repo/core", main: "certificacion", work: "feature/x" },
    ]);
    const git = new RecordingGit({ currentBranch: "feature/x", throwOn: "checkout" });

    const result = await runGitFlow(fs, git, paths(), { action: "sync", source: "core" });

    expect(result.status).toBe("error");
    expect(result.results[0]?.error).toMatch(/failed/i);
  });

  it("to-qa with --target does not require a declared QA branch", async () => {
    await writeBlock([
      { alias: "core", path: "/repo/core", main: "certificacion", work: "feature/x" }, // no qa
    ]);
    const git = new RecordingGit({ currentBranch: "feature/x" });

    const result = await runGitFlow(fs, git, paths(), {
      action: "to-qa",
      source: "core",
      target: "release/2026",
    });

    expect(result.status).toBe("ok");
    const ops = opLog(git.calls);
    expect(ops).toContain("checkout release/2026");
    expect(ops).toContain("push release/2026");
  });

  it("rejects --target combined with --all", async () => {
    await writeBlock([
      { alias: "core", path: "/repo/core", main: "certificacion", work: "feature/x", qa: "dev" },
    ]);
    const git = new RecordingGit({ currentBranch: "feature/x" });

    const result = await runGitFlow(fs, git, paths(), {
      action: "to-qa",
      all: true,
      target: "x",
    });

    expect(result.status).toBe("error");
    expect(result.error).toMatch(/--target.*--source|not --all/i);
    expect(git.calls).toEqual([]);
  });

  it("--all iterates every source in order", async () => {
    await writeBlock([
      { alias: "core", path: "/repo/core", main: "certificacion", work: "feat-a" },
      { alias: "ui", path: "/repo/ui", main: "main", work: "feat-b" },
    ]);
    const git = new RecordingGit({ currentBranch: "feat-a" });

    const result = await runGitFlow(fs, git, paths(), { action: "sync", all: true });

    expect(result.status).toBe("ok");
    expect(result.results.map((r) => r.source)).toEqual(["core", "ui"]);
    // First source's repo path appears, then the second's.
    const repos = git.calls.filter((c) => c.op === "checkout").map((c) => c.repo);
    expect(repos).toContain("/repo/core");
    expect(repos).toContain("/repo/ui");
  });

  it("--all is fail-stop: a conflict in source 1 prevents source 2 from starting", async () => {
    await writeBlock([
      { alias: "core", path: "/repo/core", main: "certificacion", work: "feat-a" },
      { alias: "ui", path: "/repo/ui", main: "main", work: "feat-b" },
    ]);
    const git = new RecordingGit({
      currentBranch: "feat-a",
      conflicts: { certificacion: ["c.ts"] },
    });

    const result = await runGitFlow(fs, git, paths(), { action: "sync", all: true });

    expect(result.status).toBe("conflict");
    // Only the first source ran; the second was never started.
    expect(result.results.map((r) => r.source)).toEqual(["core"]);
    const repos = new Set(git.calls.map((c) => c.repo));
    expect(repos.has("/repo/core")).toBe(true);
    expect(repos.has("/repo/ui")).toBe(false);
  });

  it("validation: to-qa without a declared QA branch errors clearly (no git calls)", async () => {
    await writeBlock([
      { alias: "core", path: "/repo/core", main: "certificacion", work: "feature/x" },
    ]);
    const git = new RecordingGit({ currentBranch: "feature/x" });

    const result = await runGitFlow(fs, git, paths(), { action: "to-qa", source: "core" });

    expect(result.status).toBe("error");
    expect(result.results[0]?.error).toMatch(/QA branch/i);
    expect(git.calls).toEqual([]);
  });

  it("validation: missing working branch errors clearly", async () => {
    await writeBlock([{ alias: "core", path: "/repo/core", main: "certificacion" }]);
    const git = new RecordingGit({ currentBranch: "certificacion" });

    const result = await runGitFlow(fs, git, paths(), { action: "sync", source: "core" });

    expect(result.status).toBe("error");
    expect(result.results[0]?.error).toMatch(/working branch/i);
  });

  it("errors on an unknown source alias", async () => {
    await writeBlock([
      { alias: "core", path: "/repo/core", main: "certificacion", work: "feature/x" },
    ]);
    const git = new RecordingGit();

    const result = await runGitFlow(fs, git, paths(), { action: "sync", source: "nope" });

    expect(result.status).toBe("error");
    expect(result.error).toMatch(/unknown source/i);
  });

  it("errors when no sources are declared", async () => {
    const git = new RecordingGit();
    const result = await runGitFlow(fs, git, paths(), { action: "sync", source: "core" });
    expect(result.status).toBe("error");
    expect(result.error).toBe("no_sources_declared");
  });

  it("errors on an invalid action", async () => {
    await writeBlock([
      { alias: "core", path: "/repo/core", main: "certificacion", work: "feature/x" },
    ]);
    const git = new RecordingGit();
    const result = await runGitFlow(fs, git, paths(), {
      action: "bogus" as never,
      source: "core",
    });
    expect(result.status).toBe("error");
    expect(result.error).toMatch(/unknown action/i);
  });
});
