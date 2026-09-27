import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NodeFileSystem } from "../../src/adapters/node-file-system.js";
import {
  ALL_REJECTED_FOR_PROD,
  type GitFlowInput,
  PROD_CONSENT_REQUIRED,
  runGitFlow,
} from "../../src/application/git-flow-service.js";
import type {
  DefaultBranches,
  ProjectBlockMarkers,
} from "../../src/application/parsers/project-block.js";
import { PathsService } from "../../src/application/paths-service.js";
import {
  type ProdConsent,
  attributeTuiKeypress,
  grantProdConsent,
} from "../../src/application/prod-consent.js";
import { renderProjectBlock } from "../../src/application/render/project-block.js";
import { normalizeNamespace } from "../../src/runtime/namespace.js";
import { type GitCall, RecordingGit } from "../helpers/fake-git.js";

// RecordingGit models repositories under /repo; make that synthetic filesystem
// coordinate observable while leaving the workspace's real files on disk.
const fs = new (class extends NodeFileSystem {
  override async exists(path: string): Promise<boolean> {
    return path.startsWith("/repo/") || super.exists(path);
  }
})();

interface SourceSpec {
  alias: string;
  path: string;
  main: string;
  work?: string;
  qa?: string;
}

function blockFor(
  sources: SourceSpec[],
  defaults: DefaultBranches | undefined,
  markers: ProjectBlockMarkers,
): string {
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
    markers,
  });
}

import { FakeEnv } from "../helpers/fake-env.js";

/** The git ops that move a branch or bring one (currentBranch/isMerging/aheadBehind are probes). */
const MOVING_OPS = new Set(["checkout", "fetch", "ff", "merge", "push"]);

function opLog(calls: GitCall[]): string[] {
  return calls.filter((c) => MOVING_OPS.has(c.op)).map((c) => (c.arg ? `${c.op} ${c.arg}` : c.op));
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
    const landsQa =
      (c.op === "merge" && c.arg === qa) || (c.op === "ff" && c.arg === `refs/heads/${qa}`);
    if (landsQa && current === prod) return true;
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

  /**
   * The consent the person's yes builds for `input`: its preview is asked
   * first, and the consent covers exactly that plan and its sources.
   */
  async function consentFor(input: GitFlowInput): Promise<ProdConsent> {
    const preview = await runGitFlow(fs, new RecordingGit(), paths(), input);
    const need = preview.consent_required;
    if (need === undefined) throw new Error("the input publishes nothing in PROD");
    const consent = grantProdConsent(attributeTuiKeypress(new FakeEnv()), need.sources, need.plan);
    if (consent === null) throw new Error("a person attribution always grants");
    return consent;
  }

  /** `input` as the person's yes lets it run. */
  async function consented(input: GitFlowInput): Promise<GitFlowInput> {
    return { ...input, consent: await consentFor(input) };
  }

  async function writeBlock(sources: SourceSpec[], defaults?: DefaultBranches): Promise<void> {
    await writeFile(
      join(cwd, "CLAUDE.md"),
      blockFor(sources, defaults, paths().blockMarkers()),
      "utf8",
    );
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
      "fetch feature/x",
      "merge origin/feature/x",
      "checkout certificacion",
      "fetch certificacion",
      "ff refs/remotes/origin/certificacion",
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
      "fetch feature/x",
      "merge origin/feature/x",
      "checkout certificacion",
      "fetch certificacion",
      "ff refs/remotes/origin/certificacion",
      "checkout feature/x",
      "merge certificacion",
      // promote to qa
      "checkout desarrollo",
      "fetch desarrollo",
      "merge origin/desarrollo",
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
      "fetch feature/x",
      "merge origin/feature/x",
      "checkout certificacion",
      "fetch certificacion",
      "ff refs/remotes/origin/certificacion",
      "checkout feature/x",
      "merge certificacion",
      // promote to dev — espejo de to-qa
      "checkout develop",
      "fetch develop",
      "merge origin/develop",
      "merge certificacion",
      "merge feature/x",
      "push develop",
    ]);
  });

  it("to-dev termina ok SIN merges cuando la rama de trabajo ya es la de desarrollo", async () => {
    // Una rama de trabajo explícita puede coincidir con desarrollo.
    await writeBlock(
      [{ alias: "core", path: "/repo/core", main: "certificacion", work: "develop" }],
      {
        desarrollo: "develop",
      },
    );
    const git = new RecordingGit({ currentBranch: "develop" });

    const result = await runGitFlow(fs, git, paths(), { action: "to-dev", source: "core" });

    expect(result.status).toBe("ok");
    expect(result.results[0]?.status).toBe("ok");
    expect(result.results[0]?.steps[0]?.detail).toMatch(/nada que enviar/i);
    expect(git.calls).toEqual([]); // ni siquiera se toca el repo
  });

  it("to-dev con --target SÍ promociona aunque work coincida con el default de desarrollo", async () => {
    // El guard mira el destino EFECTIVO: sin `target ??` una promoción legítima
    // se convertiría en un salto silencioso. El destino es una rama de entorno
    // (la de QA): hacia una rama de trabajo, PR-04 rechazaría llevar develop.
    await writeBlock(
      [
        {
          alias: "core",
          path: "/repo/core",
          main: "certificacion",
          work: "develop",
          qa: "integration",
        },
      ],
      { desarrollo: "develop" },
    );
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
        { alias: "core", path: "/repo/core", main: "certificacion", work: "develop" },
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

    const result = await runGitFlow(
      fs,
      git,
      paths(),
      await consented({
        action: "to-prod",
        source: "core",
      }),
    );

    expect(result.status).toBe("ok");
    expect(opLog(git.calls)).toEqual([
      // sync
      "checkout feature/x",
      "fetch feature/x",
      "merge origin/feature/x",
      "checkout certificacion",
      "fetch certificacion",
      "ff refs/remotes/origin/certificacion",
      "checkout feature/x",
      "merge certificacion",
      // promote to prod (no re-pull; syncPlan already pulled certificacion),
      // landing work by fast-forward: no merge commit of its own on PROD
      "checkout certificacion",
      "ff refs/heads/feature/x",
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
      const result = await runGitFlow(
        fs,
        git,
        paths(),
        action === "to-prod"
          ? await consented({ action, source: "core" })
          : { action, source: "core" },
      );
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
      "fetch feature/x",
      "merge origin/feature/x",
      "checkout certificacion",
      "fetch certificacion",
      "ff refs/remotes/origin/certificacion",
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
      "fetch feature/x",
      "merge origin/feature/x",
      "checkout certificacion",
      "fetch certificacion",
      "ff refs/remotes/origin/certificacion",
      "checkout feature/x",
      "merge certificacion",
      "checkout desarrollo",
      "fetch desarrollo",
      "merge origin/desarrollo",
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
    expect(r2.results[0]?.error).toMatch(/merge a medias.*resolvelo/i);
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

  it("--all continúa tras un conflicto: la fuente 2 se procesa igualmente", async () => {
    await writeBlock([
      { alias: "core", path: "/repo/core", main: "certificacion", work: "feat-a" },
      { alias: "ui", path: "/repo/ui", main: "main", work: "feat-b" },
    ]);
    const git = new RecordingGit({
      currentBranch: "feat-a",
      conflicts: { certificacion: ["c.ts"] }, // solo la 1ª fuente mergea `certificacion`
    });

    const result = await runGitFlow(fs, git, paths(), { action: "sync", all: true });

    // Entrada por CADA fuente declarada, y la 2ª realmente se ejecutó.
    expect(result.results.map((r) => r.source)).toEqual(["core", "ui"]);
    expect(result.results[0]?.status).toBe("conflict");
    expect(result.results[1]?.status).toBe("ok");
    expect(new Set(git.calls.map((c) => c.repo)).has("/repo/ui")).toBe(true);
    // Solo conflictos → el global es conflict (exit 2).
    expect(result.status).toBe("conflict");
  });

  it("--all: 3 fuentes, la 2ª con el árbol sucio — la 1ª y la 3ª se alinean igual (escenario spec 008)", async () => {
    await writeBlock([
      { alias: "core", path: "/repo/core", main: "main", work: "feat-a" },
      { alias: "ui", path: "/repo/ui", main: "main", work: "feat-b" },
      { alias: "api", path: "/repo/api", main: "main", work: "feat-c" },
    ]);
    const git = new RecordingGit({ currentBranch: "feat-a", dirtyRepos: ["/repo/ui"] });

    const result = await runGitFlow(fs, git, paths(), { action: "sync", all: true });

    // Una entrada por cada fuente, con su estado y su motivo.
    expect(result.results.map((r) => r.source)).toEqual(["core", "ui", "api"]);
    expect(result.results.map((r) => r.status)).toEqual(["ok", "error", "ok"]);
    expect(result.results[1]?.error).toMatch(/uncommitted|commit or stash/i);
    // La 1ª y la 3ª SÍ hicieron trabajo real.
    const repos = new Set(git.calls.filter((c) => c.op === "checkout").map((c) => c.repo));
    expect(repos.has("/repo/core")).toBe(true);
    expect(repos.has("/repo/api")).toBe(true);
    // Peor caso = error, aunque la última fuente termine ok.
    expect(result.status).toBe("error");
  });

  it("--all: un error NO queda tapado por un conflicto posterior", async () => {
    await writeBlock([
      { alias: "core", path: "/repo/core", main: "certificacion", work: "feat-a" }, // error
      { alias: "ui", path: "/repo/ui", main: "main", work: "feat-b" }, // conflict
    ]);
    const git = new RecordingGit({
      currentBranch: "feat-a",
      dirtyRepos: ["/repo/core"],
      conflicts: { main: ["d.ts"] },
    });

    const result = await runGitFlow(fs, git, paths(), { action: "sync", all: true });

    expect(result.results.map((r) => r.status)).toEqual(["error", "conflict"]);
    expect(result.status).toBe("error"); // error > conflict
  });

  it("--all: un error en la 1ª fuente domina sobre un ok posterior (peor caso)", async () => {
    await writeBlock([
      { alias: "core", path: "/repo/core", main: "certificacion", work: "feat-a" },
      { alias: "ui", path: "/repo/ui", main: "main", work: "feat-b" },
    ]);
    // checkout revienta en TODAS las fuentes → error en ambas; el global es error.
    const gitErr = new RecordingGit({ currentBranch: "feat-a", throwOn: "checkout" });
    const errored = await runGitFlow(fs, gitErr, paths(), { action: "sync", all: true });
    expect(errored.results.map((r) => r.source)).toEqual(["core", "ui"]);
    expect(errored.status).toBe("error");

    // Y un conflicto NO degrada un error previo a conflict.
    const gitMixed = new RecordingGit({
      currentBranch: "feat-a",
      conflicts: { main: ["d.ts"] }, // la 2ª fuente conflicta
      throwOn: "push", // nadie hace push en sync → no afecta
    });
    const mixed = await runGitFlow(fs, gitMixed, paths(), { action: "sync", all: true });
    expect(mixed.results[0]?.status).toBe("ok");
    expect(mixed.results[1]?.status).toBe("conflict");
    expect(mixed.status).toBe("conflict");
  });

  it("--all: una fuente cuyo repo no es usable NO tumba el lote", async () => {
    // Las precondiciones (isMerging/isDirty) LANZAN en el adaptador real cuando el
    // path no es un repo usable: sin capturarlo, la excepción se llevaba por
    // delante todas las fuentes restantes.
    await writeBlock([
      { alias: "core", path: "/repo/core", main: "main", work: "feat-a" },
      { alias: "ghost", path: "/repo/ghost", main: "main", work: "feat-b" },
      { alias: "ui", path: "/repo/ui", main: "main", work: "feat-c" },
    ]);
    const git = new RecordingGit({ currentBranch: "feat-a", throwOnRepos: ["/repo/ghost"] });

    const result = await runGitFlow(fs, git, paths(), { action: "sync", all: true });

    expect(result.results.map((r) => r.source)).toEqual(["core", "ghost", "ui"]);
    expect(result.results.map((r) => r.status)).toEqual(["ok", "error", "ok"]);
    expect(result.results[1]?.error).toMatch(/not a git repository/i);
    expect(result.status).toBe("error");
  });

  it("--all: el peor caso y el exit se agregan igual en las TRES acciones que no publican en PROD", async () => {
    for (const action of ["sync", "to-dev", "to-qa"] as const) {
      await writeBlock(
        [
          { alias: "core", path: "/repo/core", main: "main", work: "feat-a", qa: "qa-a" },
          { alias: "ui", path: "/repo/ui", main: "main", work: "feat-b", qa: "qa-b" },
        ],
        { desarrollo: "develop" },
      );
      const git = new RecordingGit({ currentBranch: "feat-a", dirtyRepos: ["/repo/ui"] });

      const result = await runGitFlow(fs, git, paths(), { action, all: true });

      // La 1ª trabaja, la 2ª falla su precondición, y el global es el peor caso.
      expect(
        result.results.map((r) => r.source),
        `acción ${action}`,
      ).toEqual(["core", "ui"]);
      expect(result.results[0]?.status, `acción ${action}`).toBe("ok");
      expect(result.results[1]?.status, `acción ${action}`).toBe("error");
      expect(result.status, `acción ${action}`).toBe("error");
    }
  });

  it("--all: el mid-merge de una fuente no contamina a las demás", async () => {
    // Regresión del fake compartido: con continue-on-failure, un conflicto en la
    // 1ª dejaba a la 2ª «con merge en curso», un cascadeo imposible entre repos.
    await writeBlock([
      { alias: "core", path: "/repo/core", main: "certificacion", work: "feat-a" },
      { alias: "ui", path: "/repo/ui", main: "main", work: "feat-b" },
    ]);
    const git = new RecordingGit({
      currentBranch: "feat-a",
      conflicts: { certificacion: ["c.ts"] },
    });

    const result = await runGitFlow(fs, git, paths(), { action: "sync", all: true });

    expect(result.results[1]?.error).toBeUndefined();
    expect(result.results[1]?.status).toBe("ok");
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

  it("refuses a source without a working branch before preview or git mutation", async () => {
    await writeBlock([{ alias: "core", path: "/repo/core", main: "certificacion" }], {
      desarrollo: "develop",
    });
    const git = new RecordingGit({ currentBranch: "certificacion" });

    const result = await runGitFlow(fs, git, paths(), {
      action: "to-prod",
      source: "core",
      dryRun: true,
    });

    expect(result.status).toBe("error");
    expect(result.results[0]?.error).toContain("aw set-working-branch core <rama>");
    expect(opLog(git.calls)).toEqual([]);
    const explicit = await runGitFlow(fs, git, paths(), {
      action: "sync",
      source: "core",
      target: "feature/x",
      dryRun: true,
    });
    expect(explicit.status).toBe("ok");
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

  describe("cada rama se actualiza sólo desde su homónima, y PROD sólo por fast-forward", () => {
    const core: SourceSpec = {
      alias: "core",
      path: "/repo/core",
      main: "certificacion",
      work: "feature/x",
    };

    it("una rama sin homónima en origin omite su paso y el flujo sigue", async () => {
      await writeBlock([core]);
      const git = new RecordingGit({ currentBranch: "feature/x", remoteMissing: ["feature/x"] });

      const result = await runGitFlow(fs, git, paths(), { action: "sync", source: "core" });

      expect(result.status).toBe("ok");
      const first = result.results[0]?.steps[0];
      expect(first).toMatchObject({ step: "pull feature/x", status: "skipped" });
      expect(first?.detail).toMatch(/origin no tiene feature\/x/);
      expect(opLog(git.calls)).not.toContain("fetch feature/x");
      expect(opLog(git.calls)).toContain("merge certificacion");
    });

    it("sin el remoto de PROD, sync se detiene sin mover PROD ni la rama de trabajo", async () => {
      await writeBlock([core]);
      const git = new RecordingGit({
        currentBranch: "feature/x",
        remoteMissing: ["certificacion"],
      });

      const result = await runGitFlow(fs, git, paths(), { action: "sync", source: "core" });

      expect(result.status).toBe("error");
      expect(result.results[0]?.error).toMatch(/origin no tiene certificacion/);
      const ops = opLog(git.calls);
      expect(ops).not.toContain("fetch certificacion");
      expect(ops.some((op) => op.startsWith("ff "))).toBe(false);
      expect(ops).not.toContain("merge certificacion");
    });

    it("PROD divergida de su remoto se detiene sin fast-forward", async () => {
      await writeBlock([core]);
      const git = new RecordingGit({
        currentBranch: "feature/x",
        aheadBehind: { certificacion: { ahead: 1, behind: 2 } },
      });

      const result = await runGitFlow(fs, git, paths(), { action: "sync", source: "core" });

      expect(result.status).toBe("error");
      expect(result.results[0]?.error).toMatch(/certificacion divergió de origin\/certificacion/);
      expect(opLog(git.calls).some((op) => op.startsWith("ff "))).toBe(false);
      expect(opLog(git.calls)).not.toContain("merge certificacion");
    });

    it("PROD adelantada con commits ajenos a la rama de trabajo se detiene y los nombra", async () => {
      await writeBlock([core]);
      const git = new RecordingGit({
        currentBranch: "feature/x",
        aheadBehind: { certificacion: { ahead: 1, behind: 0 } },
        revList: ["0123456789abcdef"],
      });

      const result = await runGitFlow(
        fs,
        git,
        paths(),
        await consented({
          action: "to-prod",
          source: "core",
        }),
      );

      expect(result.status).toBe("error");
      expect(result.results[0]?.error).toMatch(/commits que no son de feature\/x: 0123456/);
      expect(git.calls.find((c) => c.op === "revList")?.arg).toBe(
        "refs/heads/certificacion --not refs/remotes/origin/certificacion refs/heads/feature/x",
      );
      expect(opLog(git.calls).some((op) => op.startsWith("push"))).toBe(false);
    });

    it("PROD adelantada sólo con commits de la rama de trabajo retoma el push fallido", async () => {
      await writeBlock([core]);
      const git = new RecordingGit({
        currentBranch: "feature/x",
        aheadBehind: { certificacion: { ahead: 3, behind: 0 } },
        revList: [],
      });

      const result = await runGitFlow(
        fs,
        git,
        paths(),
        await consented({
          action: "to-prod",
          source: "core",
        }),
      );

      expect(result.status).toBe("ok");
      const pullProd = result.results[0]?.steps.find((s) => s.step === "pull certificacion");
      expect(pullProd?.detail).toMatch(/sólo con commits de feature\/x \(3\)/);
      expect(opLog(git.calls)).not.toContain("ff refs/remotes/origin/certificacion");
      expect(opLog(git.calls)).toContain("push certificacion");
    });

    it("sync con destino PROD la trae por fast-forward, nunca con un merge de su remoto", async () => {
      await writeBlock([core]);
      const git = new RecordingGit({
        currentBranch: "feature/x",
        aheadBehind: { certificacion: { ahead: 1, behind: 1 } },
      });

      const result = await runGitFlow(fs, git, paths(), {
        action: "sync",
        source: "core",
        target: "certificacion",
      });

      expect(result.status).toBe("error");
      expect(result.results[0]?.error).toMatch(/divergió/);
      expect(opLog(git.calls)).not.toContain("merge origin/certificacion");
    });

    it("con desarrollo por defecto igual a PROD, sync sigue trayendo PROD (no es PR-04)", async () => {
      await writeBlock([core], { desarrollo: "certificacion" });
      const git = new RecordingGit({ currentBranch: "feature/x" });

      const result = await runGitFlow(fs, git, paths(), { action: "sync", source: "core" });

      expect(result.status).toBe("ok");
      expect(opLog(git.calls)).toContain("merge certificacion");
    });

    it("con --target en PROD, el destino también avanza sólo por fast-forward", async () => {
      await writeBlock([{ ...core, qa: "desarrollo" }]);
      const git = new RecordingGit({ currentBranch: "feature/x" });

      await runGitFlow(
        fs,
        git,
        paths(),
        await consented({
          action: "to-dev",
          source: "core",
          target: "certificacion",
        }),
      );

      const ops = opLog(git.calls);
      expect(ops.filter((op) => op === "ff refs/remotes/origin/certificacion")).toHaveLength(2);
      expect(ops).not.toContain("merge origin/certificacion");
      // prod→prod y work→prod aterrizan por fast-forward, sin merge propio en PROD
      expect(ops).toContain("ff refs/heads/feature/x");
    });
  });

  describe("publicar en PROD exige el consentimiento de la persona", () => {
    const two: SourceSpec[] = [
      { alias: "core", path: "/repo/core", main: "certificacion", work: "feature/x" },
      { alias: "ui", path: "/repo/ui", main: "main", work: "feature/y" },
    ];

    it("sin consentimiento, to-prod devuelve la vista previa con las ramas reales y no llama a git", async () => {
      await writeBlock(two);
      const git = new RecordingGit({ currentBranch: "feature/x" });

      const result = await runGitFlow(fs, git, paths(), { action: "to-prod", source: "core" });

      expect(git.calls).toEqual([]);
      expect(result.status).toBe("error");
      expect(result.error).toBe(PROD_CONSENT_REQUIRED);
      expect(result.consent_required?.sources).toEqual(["core"]);
      const steps = result.results[0]?.steps ?? [];
      // Las etiquetas por rol se conservan; la vista previa nombra las ramas reales.
      expect(steps.map((s) => s.step)).toContain("merge work→prod");
      expect(steps.map((s) => s.preview)).toEqual([
        "pull feature/x (desde origin/feature/x, si existe)",
        "checkout certificacion",
        "pull certificacion (sólo fast-forward hasta origin/certificacion)",
        "checkout feature/x",
        "merge certificacion→feature/x",
        "checkout certificacion",
        "merge feature/x→certificacion",
        "push certificacion",
      ]);
    });

    it("to-dev --target en la rama de PROD también es una publicación en PROD", async () => {
      await writeBlock(two);
      const git = new RecordingGit({ currentBranch: "feature/x" });

      const result = await runGitFlow(fs, git, paths(), {
        action: "to-dev",
        source: "core",
        target: "certificacion",
      });

      expect(result.consent_required?.sources).toEqual(["core"]);
      expect(git.calls).toEqual([]);
    });

    it("un objeto con la forma de un consentimiento no publica: sólo cuenta el que se otorgó", async () => {
      await writeBlock(two);
      const git = new RecordingGit({ currentBranch: "feature/x" });

      const result = await runGitFlow(fs, git, paths(), {
        action: "to-prod",
        source: "core",
        consent: { sources: ["core"] },
      });

      expect(result.consent_required).toBeDefined();
      expect(git.calls).toEqual([]);
    });

    it("el consentimiento vale una sola vez y sólo para las fuentes que lista", async () => {
      await writeBlock(two);
      const consent = await consentFor({ action: "to-prod", source: "core" });

      const other = new RecordingGit({ currentBranch: "feature/x" });
      const wrong = await runGitFlow(fs, other, paths(), {
        action: "to-prod",
        sources: ["core", "ui"],
        consent,
      });
      expect(wrong.consent_required?.sources).toEqual(["core", "ui"]);
      expect(other.calls).toEqual([]);

      // Y al revés: el de las dos fuentes no publica una sola.
      const both = await consentFor({ action: "to-prod", sources: ["core", "ui"] });
      const narrower = new RecordingGit({ currentBranch: "feature/x" });
      const one = await runGitFlow(fs, narrower, paths(), {
        action: "to-prod",
        source: "core",
        consent: both,
      });
      expect(one.consent_required).toBeDefined();
      expect(narrower.calls).toEqual([]);

      const first = new RecordingGit({ currentBranch: "feature/x" });
      expect(
        (await runGitFlow(fs, first, paths(), { action: "to-prod", source: "core", consent }))
          .status,
      ).toBe("ok");
      const again = new RecordingGit({ currentBranch: "feature/x" });
      const replay = await runGitFlow(fs, again, paths(), {
        action: "to-prod",
        source: "core",
        consent,
      });
      expect(replay.consent_required).toBeDefined();
      expect(again.calls).toEqual([]);
    });

    it("--source repetido publica exactamente las fuentes nombradas, en ese orden", async () => {
      await writeBlock([...two, { alias: "api", path: "/repo/api", main: "main", work: "f-c" }]);
      const git = new RecordingGit({ currentBranch: "feature/x" });

      const result = await runGitFlow(
        fs,
        git,
        paths(),
        await consented({
          action: "to-prod",
          sources: ["ui", "core"],
        }),
      );

      expect(result.status).toBe("ok");
      expect(result.results.map((r) => r.source)).toEqual(["ui", "core"]);
      const pushed = git.calls.filter((c) => c.op === "push").map((c) => c.repo);
      expect(pushed).toEqual(["/repo/ui", "/repo/core"]);
    });

    it("--all sobre una publicación en PROD se rechaza pidiendo la lista, aun con consentimiento", async () => {
      await writeBlock(two);
      const git = new RecordingGit({ currentBranch: "feature/x" });

      const result = await runGitFlow(fs, git, paths(), {
        action: "to-prod",
        all: true,
        consent: await consentFor({ action: "to-prod", sources: ["core", "ui"] }),
      });

      expect(result.status).toBe("error");
      expect(result.error).toBe(ALL_REJECTED_FOR_PROD);
      expect(git.calls).toEqual([]);
    });

    it("una atribución escrita a mano no otorga nada: sólo la que lee el entorno", async () => {
      expect(grantProdConsent({ person: true }, ["core"], "x")).toBeNull();
    });

    it("si el plan cambió entre la vista previa y el sí, no publica y vuelve a mostrarlo", async () => {
      await writeBlock(two);
      const consent = await consentFor({ action: "to-prod", source: "core" });
      // Otra sesión reescribe la rama de trabajo mientras la pregunta espera.
      await writeBlock([{ ...(two[0] as SourceSpec), work: "feature/otra" }, two[1] as SourceSpec]);
      const git = new RecordingGit({ currentBranch: "feature/x" });

      const result = await runGitFlow(fs, git, paths(), {
        action: "to-prod",
        source: "core",
        consent,
      });

      expect(result.consent_required).toBeDefined();
      expect(result.results[0]?.steps.map((s) => s.preview)).toContain(
        "merge feature/otra→certificacion",
      );
      expect(git.calls).toEqual([]);
    });

    for (const target of [
      "heads/certificacion",
      "refs/heads/certificacion",
      "@{-1}",
      "-certificacion",
    ]) {
      it(`--target ${target} no es un nombre de rama simple y se rechaza antes de planear`, async () => {
        await writeBlock(two);
        const git = new RecordingGit({ currentBranch: "feature/x" });

        const result = await runGitFlow(fs, git, paths(), {
          action: "to-qa",
          source: "core",
          target,
        });

        expect(result.status).toBe("error");
        expect(result.error).toMatch(/no es un nombre de rama simple/);
        expect(git.calls).toEqual([]);
      });
    }

    it("--target que difiere de PROD sólo en mayúsculas se rechaza", async () => {
      await writeBlock(two);
      const git = new RecordingGit({ currentBranch: "feature/x" });

      const result = await runGitFlow(fs, git, paths(), {
        action: "to-qa",
        source: "core",
        target: "Certificacion",
      });

      expect(result.results[0]?.error).toMatch(/sólo en mayúsculas/);
      expect(git.calls).toEqual([]);
    });

    it("to-qa --target en la rama de PROD también pide consentimiento", async () => {
      await writeBlock(two);
      const git = new RecordingGit({ currentBranch: "feature/x" });

      const result = await runGitFlow(fs, git, paths(), {
        action: "to-qa",
        source: "core",
        target: "certificacion",
      });

      expect(result.consent_required?.sources).toEqual(["core"]);
      expect(git.calls).toEqual([]);
    });

    it("--source repetido con la misma fuente y --target cuenta como una sola fuente", async () => {
      await writeBlock(two);
      const result = await runGitFlow(fs, new RecordingGit(), paths(), {
        action: "to-qa",
        sources: ["core", "core"],
        target: "release/1",
      });
      expect(result.status).toBe("ok");
    });

    it("--target sigue exigiendo una sola fuente", async () => {
      await writeBlock(two);
      const result = await runGitFlow(fs, new RecordingGit(), paths(), {
        action: "to-qa",
        sources: ["core", "ui"],
        target: "release/1",
      });
      expect(result.error).toMatch(/--target with a single --source/);
    });

    it("desarrollo y QA siguen publicando sin pedir nada, y --dry-run de to-prod no lo pide", async () => {
      await writeBlock(two);
      for (const action of ["to-dev", "to-qa"] as const) {
        const git = new RecordingGit({ currentBranch: "feature/x" });
        const result = await runGitFlow(fs, git, paths(), { action, all: true });
        expect(result.status, action).toBe("ok");
        expect(result.consent_required, action).toBeUndefined();
      }
      const dry = await runGitFlow(fs, new RecordingGit(), paths(), {
        action: "to-prod",
        all: true,
        dryRun: true,
      });
      expect(dry.status).toBe("ok");
      expect(dry.results[0]?.steps.at(-1)?.preview).toBe("push certificacion");
    });
  });

  describe("un merge a medias nombra la rama donde quedó y la que lo trajo (AC-06)", () => {
    const core: SourceSpec = {
      alias: "core",
      path: "/repo/core",
      main: "certificacion",
      work: "feature/x",
    };

    it("un merge anterior se reporta con la rama actual y la de MERGE_HEAD", async () => {
      await writeBlock([core]);
      const git = new RecordingGit({
        currentBranch: "feature/x",
        merging: true,
        mergeOrigin: "desarrollo",
      });

      const result = await runGitFlow(fs, git, paths(), { action: "sync", source: "core" });

      const src = result.results[0];
      expect(src?.status).toBe("error");
      expect(src?.paused_at).toBe("feature/x");
      expect(src?.merge_origin).toBe("desarrollo");
      expect(src?.error).toMatch(/sobre feature\/x, traído por desarrollo/);
      expect(opLog(git.calls)).toEqual([]);
    });

    it("si git no sabe nombrar la rama que lo trajo, lo dice en vez de omitirla", async () => {
      await writeBlock([core]);
      const git = new RecordingGit({ currentBranch: "feature/x", merging: true });

      const result = await runGitFlow(fs, git, paths(), { action: "sync", source: "core" });

      expect(result.results[0]?.merge_origin).toBeNull();
      expect(result.results[0]?.error).toMatch(/traído por una rama que git no sabe nombrar/);
    });

    it("con HEAD desacoplado lo dice, en vez de llamarlo rama", async () => {
      await writeBlock([core]);
      const git = new RecordingGit({ currentBranch: "HEAD", merging: true, mergeOrigin: "x" });

      const result = await runGitFlow(fs, git, paths(), { action: "sync", source: "core" });

      expect(result.results[0]?.error).toMatch(
        /sobre un HEAD desacoplado, sin rama que git sepa nombrar/,
      );
    });

    it("un conflicto de esta corrida nombra la rama del paso en conflicto", async () => {
      await writeBlock([core]);
      const git = new RecordingGit({
        currentBranch: "feature/x",
        conflicts: { "origin/feature/x": ["a.ts"] },
      });

      const result = await runGitFlow(fs, git, paths(), { action: "sync", source: "core" });

      expect(result.results[0]).toMatchObject({
        status: "conflict",
        paused_at: "feature/x",
        merge_origin: "origin/feature/x",
      });
    });
  });

  describe("PR-04: ningún plan mezcla la rama de desarrollo en una rama de trabajo", () => {
    // Incluso declarada explícitamente, desarrollo no fluye hacia una feature o aw/*.
    for (const target of ["feature/y", "aw/215-salvaguardas-de-produccion-plan-exec"]) {
      it(`to-qa --target ${target} se rechaza antes de tocar git`, async () => {
        await writeBlock(
          [{ alias: "core", path: "/repo/core", main: "certificacion", work: "develop" }],
          {
            desarrollo: "develop",
          },
        );
        const git = new RecordingGit({ currentBranch: "develop" });

        const result = await runGitFlow(fs, git, paths(), {
          action: "to-qa",
          source: "core",
          target,
        });

        expect(result.status).toBe("error");
        expect(result.results[0]?.error).toMatch(
          new RegExp(`PR-04.*develop.*${target.replace("/", "\\/")}`),
        );
        expect(git.calls).toEqual([]);
      });
    }

    it("también en --dry-run: el plan prohibido no se muestra como ejecutable", async () => {
      await writeBlock(
        [{ alias: "core", path: "/repo/core", main: "certificacion", work: "develop" }],
        {
          desarrollo: "develop",
        },
      );
      const git = new RecordingGit({ currentBranch: "develop" });

      const result = await runGitFlow(fs, git, paths(), {
        action: "to-qa",
        source: "core",
        target: "feature/y",
        dryRun: true,
      });

      expect(result.results[0]?.status).toBe("error");
      expect(result.results[0]?.error).toMatch(/PR-04/);
    });

    it("promover la rama de trabajo hacia desarrollo o QA sigue permitido", async () => {
      await writeBlock([
        { alias: "core", path: "/repo/core", main: "certificacion", work: "feature/x", qa: "qa" },
      ]);
      for (const action of ["to-dev", "to-qa"] as const) {
        const git = new RecordingGit({ currentBranch: "feature/x" });
        const result = await runGitFlow(fs, git, paths(), { action, source: "core" });
        expect(result.status, action).toBe("ok");
      }
    });
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
