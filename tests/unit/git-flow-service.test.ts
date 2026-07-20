import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NodeFileSystem } from "../../src/adapters/node-file-system.js";
import { runGitFlow } from "../../src/application/git-flow-service.js";
import type { DefaultBranches } from "../../src/application/parsers/project-block.js";
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

function blockFor(sources: SourceSpec[], defaults?: DefaultBranches): string {
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
    ...(defaults ? { defaultBranches: defaults } : {}),
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

/**
 * True if any merge brings the qa branch ONTO the prod branch — the forbidden
 * `desarrollo→certificacion` promotion that would drag unreleased work to prod.
 * Tracks the current branch via checkouts; a `merge <qa>` while on `prod` is the
 * violation.
 */
function mergesQaOntoProd(calls: GitCall[], qa: string, prod: string): boolean {
  let current = "";
  for (const c of calls) {
    if (c.op === "checkout") current = c.arg ?? current;
    if (c.op === "merge" && c.arg === qa && current === prod) return true;
  }
  return false;
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

  async function writeBlock(sources: SourceSpec[], defaults?: DefaultBranches): Promise<void> {
    await writeFile(join(cwd, "CLAUDE.md"), blockFor(sources, defaults), "utf8");
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
    // Las ETIQUETAS son contractuales (docs/design/git-flow-per-source.md) y se
    // pintan en FlowResultView: el refactor a promotePlan debía preservarlas.
    expect(result.results[0]?.steps.map((s) => s.step)).toEqual([
      "pull feature/x",
      "checkout certificacion",
      "pull certificacion",
      "checkout feature/x",
      "merge prod→work",
      "checkout desarrollo",
      "pull desarrollo",
      "merge prod→qa",
      "merge work→qa",
      "push desarrollo",
    ]);
  });

  it("to-qa con --target etiqueta con la rama literal, no con el rol", async () => {
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

    const steps = result.results[0]?.steps.map((s) => s.step) ?? [];
    expect(steps).toContain("merge work→release/2026");
    expect(steps).not.toContain("merge work→qa");
  });

  it("to-qa NO se salta cuando la rama qa coincide con la de trabajo (el guard es solo de to-dev)", async () => {
    await writeBlock([
      {
        alias: "core",
        path: "/repo/core",
        main: "certificacion",
        work: "desarrollo",
        qa: "desarrollo",
      },
    ]);
    const git = new RecordingGit({ currentBranch: "desarrollo" });

    const result = await runGitFlow(fs, git, paths(), { action: "to-qa", source: "core" });

    expect(result.status).toBe("ok");
    expect(opLog(git.calls)).toContain("push desarrollo");
    expect(result.results[0]?.steps.some((s) => s.detail?.includes("nada que enviar"))).toBe(false);
  });

  it("to-dev: sync + checkout dev+pull + merge prod→dev + merge work→dev + push dev", async () => {
    await writeBlock(
      [{ alias: "core", path: "/repo/core", main: "certificacion", work: "feature/x" }],
      { desarrollo: "develop" },
    );
    const git = new RecordingGit({ currentBranch: "feature/x" });

    const result = await runGitFlow(fs, git, paths(), { action: "to-dev", source: "core" });

    expect(result.status).toBe("ok");
    expect(opLog(git.calls)).toEqual([
      // sync
      "checkout feature/x",
      "pull feature/x",
      "checkout certificacion",
      "pull certificacion",
      "checkout feature/x",
      "merge certificacion",
      // promote to dev — espejo de to-qa
      "checkout develop",
      "pull develop",
      "merge certificacion",
      "merge feature/x",
      "push develop",
    ]);
  });

  it("to-dev termina ok SIN merges cuando la rama de trabajo ya es la de desarrollo", async () => {
    // Sin rama de trabajo declarada, work y dev resuelven ambos al default.
    await writeBlock([{ alias: "core", path: "/repo/core", main: "certificacion" }], {
      desarrollo: "develop",
    });
    const git = new RecordingGit({ currentBranch: "develop" });

    const result = await runGitFlow(fs, git, paths(), { action: "to-dev", source: "core" });

    expect(result.status).toBe("ok");
    expect(result.results[0]?.status).toBe("ok");
    expect(result.results[0]?.steps[0]?.detail).toMatch(/nada que enviar/i);
    expect(git.calls).toEqual([]); // ni siquiera se toca el repo
  });

  it("to-dev con --target SÍ promociona aunque work coincida con el default de desarrollo", async () => {
    // El guard mira el destino EFECTIVO: sin `target ??` una promoción legítima
    // se convertiría en un salto silencioso.
    await writeBlock([{ alias: "core", path: "/repo/core", main: "certificacion" }], {
      desarrollo: "develop",
    });
    const git = new RecordingGit({ currentBranch: "develop" });

    const result = await runGitFlow(fs, git, paths(), {
      action: "to-dev",
      source: "core",
      target: "integration",
    });

    expect(result.status).toBe("ok");
    const ops = opLog(git.calls);
    expect(ops).toContain("checkout integration");
    expect(ops).toContain("push integration");
    expect(result.results[0]?.steps.some((s) => s.detail?.includes("nada que enviar"))).toBe(false);
  });

  it("to-dev --all: una fuente degenerada no impide procesar el resto", async () => {
    await writeBlock(
      [
        { alias: "core", path: "/repo/core", main: "certificacion" }, // sin work → no-op
        { alias: "ui", path: "/repo/ui", main: "main", work: "feature/y" },
      ],
      { desarrollo: "develop" },
    );
    const git = new RecordingGit({ currentBranch: "feature/y" });

    const result = await runGitFlow(fs, git, paths(), { action: "to-dev", all: true });

    expect(result.status).toBe("ok");
    expect(result.results.map((r) => r.source)).toEqual(["core", "ui"]);
    expect(result.results[0]?.steps[0]?.detail).toMatch(/nada que enviar/i);
    expect(git.calls.some((c) => c.op === "push" && c.repo === "/repo/ui")).toBe(true);
  });

  it("to-dev respeta --target por encima del default de desarrollo", async () => {
    await writeBlock(
      [{ alias: "core", path: "/repo/core", main: "certificacion", work: "feature/x" }],
      { desarrollo: "develop" },
    );
    const git = new RecordingGit({ currentBranch: "feature/x" });

    const result = await runGitFlow(fs, git, paths(), {
      action: "to-dev",
      source: "core",
      target: "integration",
    });

    expect(result.status).toBe("ok");
    const ops = opLog(git.calls);
    expect(ops).toContain("push integration");
    expect(ops).not.toContain("push develop");
  });

  it("invariante: to-dev nunca lleva dev a prod", async () => {
    await writeBlock(
      [{ alias: "core", path: "/repo/core", main: "certificacion", work: "feature/x" }],
      { desarrollo: "develop" },
    );
    const git = new RecordingGit({ currentBranch: "feature/x" });

    await runGitFlow(fs, git, paths(), { action: "to-dev", source: "core" });

    expect(mergesQaOntoProd(git.calls, "develop", "certificacion")).toBe(false);
  });

  it("to-prod: sync + checkout prod + merge work→prod + push prod (no qa→prod)", async () => {
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
      // promote to prod (no re-pull; syncPlan already pulled certificacion)
      "checkout certificacion",
      "merge feature/x",
      "push certificacion",
    ]);
  });

  it("invariant: no flow ever merges qa→prod (desarrollo→certificacion)", async () => {
    await writeBlock([
      {
        alias: "core",
        path: "/repo/core",
        main: "certificacion",
        work: "feature/x",
        qa: "desarrollo",
      },
    ]);
    for (const action of ["sync", "to-qa", "to-prod"] as const) {
      const git = new RecordingGit({ currentBranch: "feature/x" });
      const result = await runGitFlow(fs, git, paths(), { action, source: "core" });
      expect(result.status).toBe("ok");
      expect(mergesQaOntoProd(git.calls, "desarrollo", "certificacion")).toBe(false);
    }
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

  it("to-qa without a declared QA branch falls back to the workspace default", async () => {
    await writeBlock(
      [{ alias: "core", path: "/repo/core", main: "certificacion", work: "feature/x" }], // no qa
      { qa: "release/qa" },
    );
    const git = new RecordingGit({ currentBranch: "feature/x" });

    const result = await runGitFlow(fs, git, paths(), { action: "to-qa", source: "core" });

    expect(result.status).toBe("ok");
    const ops = opLog(git.calls);
    expect(ops).toContain("checkout release/qa");
    expect(ops).toContain("push release/qa");
  });

  it("to-qa with no QA anywhere uses the hardcoded 'qa' fallback", async () => {
    await writeBlock([
      { alias: "core", path: "/repo/core", main: "certificacion", work: "feature/x" },
    ]);
    const git = new RecordingGit({ currentBranch: "feature/x" });

    const result = await runGitFlow(fs, git, paths(), { action: "to-qa", source: "core" });

    expect(result.status).toBe("ok");
    expect(opLog(git.calls)).toContain("push qa");
  });

  it("a source with no working branch resolves work to the workspace 'desarrollo' default", async () => {
    await writeBlock([{ alias: "core", path: "/repo/core", main: "certificacion" }], {
      desarrollo: "develop",
    });
    const git = new RecordingGit({ currentBranch: "certificacion" });

    const result = await runGitFlow(fs, git, paths(), { action: "sync", source: "core" });

    expect(result.status).toBe("ok");
    expect(opLog(git.calls)).toEqual([
      "checkout develop",
      "pull develop",
      "checkout certificacion",
      "pull certificacion",
      "checkout develop",
      "merge certificacion",
    ]);
  });

  it("a declared per-source branch wins over the workspace default", async () => {
    await writeBlock(
      [
        {
          alias: "core",
          path: "/repo/core",
          main: "certificacion",
          work: "feature/x",
          qa: "staging",
        },
      ],
      { qa: "release/qa" },
    );
    const git = new RecordingGit({ currentBranch: "feature/x" });

    const result = await runGitFlow(fs, git, paths(), { action: "to-qa", source: "core" });

    expect(result.status).toBe("ok");
    const ops = opLog(git.calls);
    expect(ops).toContain("push staging");
    expect(ops).not.toContain("push release/qa");
  });

  it("an empty 'Rama principal' cell resolves prod to the workspace 'principal' default", async () => {
    await writeBlock([{ alias: "core", path: "/repo/core", main: "", work: "feature/x" }], {
      principal: "trunk",
    });
    const git = new RecordingGit({ currentBranch: "feature/x" });

    const result = await runGitFlow(fs, git, paths(), { action: "sync", source: "core" });

    expect(result.status).toBe("ok");
    expect(opLog(git.calls)).toContain("checkout trunk");
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
