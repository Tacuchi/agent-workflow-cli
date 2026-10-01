import { execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GitCliAdapter } from "../../src/adapters/git-cli.js";
import { NodeProcess } from "../../src/adapters/node-process.js";
import { resolveBoundary } from "../../src/application/flow/advance.js";
import { internalActionExecutor } from "../../src/application/flow/internal-actions.js";
import { locateRun, readRun } from "../../src/application/flow/run-state-service.js";
import { submitFlow } from "../../src/application/flow/submit.js";
import { PathsService } from "../../src/application/paths-service.js";
import { semanticDigest } from "../../src/application/semantic-operation/protocol.js";
import {
  birthCustody,
  readCustody,
  writeCustody,
} from "../../src/application/session-custody-service.js";
import { runWorktree } from "../../src/application/worktree-service.js";
import { journeyForState, journeyOfFlow } from "../../src/domain/flow/authority.js";
import {
  newRunState,
  sealRunState,
  serializeRunState,
  withPlanExecBatch,
  withPlanExecBatchLoop,
  withPlanExecBatchUpdate,
  withScope,
} from "../../src/domain/flow/run-state.js";
import { normalizeNamespace } from "../../src/runtime/namespace.js";
import { batchReview } from "../helpers/batch-review.js";
import { FakeEnv } from "../helpers/fake-env.js";
import { NodeFileSystem } from "../helpers/real-fs.js";

const SESSION = "236-commit-plan-exec";
const ALIAS = "codigo";
const PLAN = "docs/plans/071-plan-commit.md";
const MESSAGE = "feat(flow): acredita el lote session236";

describe("commit aprobado por lote, verificado en git real", () => {
  const fs = new NodeFileSystem();
  const git = new GitCliAdapter(new NodeProcess());
  let root: string;
  let source: string;
  let unit: string;
  let paths: PathsService;
  let env: FakeEnv;

  const command = (repo: string, ...args: string[]) =>
    execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "aw-batch-commit-"));
    source = join(root, "source");
    await mkdir(source);
    paths = new PathsService(normalizeNamespace("workflow"), join(root, "home"), root);
    env = new FakeEnv(join(root, "home"), root);
    await mkdir(join(root, "home"));
    await mkdir(join(paths.cwdSessionsDir(), SESSION), { recursive: true });
    await writeFile(
      join(paths.cwdSessionsDir(), SESSION, "SESSION.md"),
      "# SESSION\n\n## Objective\ncommit por lote\n",
    );
    await writeFile(
      join(root, "CLAUDE.md"),
      `<!-- WORKFLOW-HUB-START -->\n## Hub\nPrueba de commits\n## Fuentes\n| Alias | Path | Rama principal |\n|---|---|---|\n| ${ALIAS} | ${source} | main |\n## Status\n- Ramas de trabajo actuales:\n  - ${ALIAS}: main\n<!-- WORKFLOW-HUB-END -->\n`,
    );
    command(source, "init", "--quiet", "--initial-branch=main");
    command(source, "config", "user.name", "Test");
    command(source, "config", "user.email", "test@example.com");
    await writeFile(join(source, "included.txt"), "base\n");
    await writeFile(join(source, "outside.txt"), "base\n");
    command(source, "add", ".");
    command(
      source,
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.com",
      "commit",
      "--quiet",
      "-m",
      "base",
    );
    const result = await runWorktree(
      { fs, git, env, paths },
      { action: "ensure", alias: ALIAS, sessionCode: SESSION },
    );
    if (!("path" in result)) throw new Error(JSON.stringify(result));
    unit = result.path;
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function seal(options: { approved?: boolean; message?: string; dirty?: string } = {}) {
    await writeFile(join(unit, "included.txt"), options.dirty ?? "lote\n");
    const snapshot = {
      [ALIAS]: {
        head: command(unit, "rev-parse", "HEAD"),
        branch: command(unit, "branch", "--show-current"),
        dirty: [],
      },
    };
    const changes = await git.dirtyPaths(unit);
    const sources = [
      {
        alias: ALIAS,
        paths: ["included.txt"],
        dirty: changes,
        message: options.message ?? MESSAGE,
      },
    ];
    const digest = semanticDigest({ batch: "batch-1", snapshot, sources });
    const batch = {
      id: "batch-1",
      iteration: 1,
      mode: "isolated" as const,
      phases: [1],
      tasks: ["T1.1"],
      plan_digest: "plan",
      stage: "reviewing" as const,
      snapshot,
      base: { [ALIAS]: "base" },
      credit: { [ALIAS]: "proof" },
      review: batchReview(),
      commit_proposal: {
        sources,
        digest,
        ...(options.approved === false ? {} : { approved_digest: digest }),
      },
    };
    let state = withScope(newRunState("plan-exec", SESSION), { plan: PLAN, sources: [ALIAS] });
    state = withPlanExecBatchLoop(withPlanExecBatch(state, batch), { pending: true, iteration: 1 });
    await writeFile(locateRun(paths, SESSION).statePath, serializeRunState(state));
    return state;
  }

  async function commit(stateDigest: string) {
    return internalActionExecutor({ fs, git, env, paths })(
      { operation: "plan-exec.batch-commit" },
      {
        session: SESSION,
        code: SESSION,
        scope: { plan: PLAN, sources: [ALIAS] },
        proposal: null,
        state_digest: stateDigest,
      },
    );
  }

  async function secondUnit(): Promise<{ repo: string; path: string }> {
    const repo = join(root, "other-source");
    await mkdir(repo);
    command(repo, "init", "--quiet", "--initial-branch=main");
    command(repo, "config", "user.name", "Test");
    command(repo, "config", "user.email", "test@example.com");
    await writeFile(join(repo, "other.txt"), "base\n");
    command(repo, "add", ".");
    command(repo, "commit", "--quiet", "-m", "base");
    const block = await readFile(join(root, "CLAUDE.md"), "utf8");
    await writeFile(
      join(root, "CLAUDE.md"),
      block
        .replace("## Status", `| otra | ${repo} | main |\n## Status`)
        .replace("<!-- WORKFLOW-HUB-END -->", "  - otra: main\n<!-- WORKFLOW-HUB-END -->"),
    );
    const added = await runWorktree(
      { fs, git, env, paths },
      { action: "ensure", alias: "otra", sessionCode: SESSION },
    );
    if (!("path" in added)) throw new Error(JSON.stringify(added));
    return { repo, path: added.path };
  }

  it("preflight revisa también la fuente sin rutas antes del primer commit", async () => {
    const state = await seal();
    const other = await secondUnit();
    const next = withPlanExecBatchUpdate(state, "batch-1", (batch) => {
      const snapshot = {
        ...batch.snapshot,
        otra: {
          head: command(other.path, "rev-parse", "HEAD"),
          branch: command(other.path, "branch", "--show-current"),
          dirty: [],
        },
      };
      const sources = batch.commit_proposal?.sources ?? [];
      const digest = semanticDigest({ batch: batch.id, snapshot, sources });
      return { ...batch, snapshot, commit_proposal: { sources, digest, approved_digest: digest } };
    });
    await writeFile(locateRun(paths, SESSION).statePath, serializeRunState(next));
    await writeFile(join(other.path, "other.txt"), "movido después de la propuesta\n");
    expect((await commit(next.digest)).ok).toBe(false);
    expect(command(unit, "rev-parse", "HEAD")).toBe(state.batches?.[0]?.snapshot?.[ALIAS]?.head);
  });

  it("commitea cada fuente afectada con su propio mensaje y únicamente sus rutas aprobadas", async () => {
    const state = await seal();
    const other = await secondUnit();
    await writeFile(join(other.path, "other.txt"), "otro lote\n");
    const secondBase = command(other.path, "rev-parse", "HEAD");
    const dirty = await git.dirtyPaths(other.path);
    const complete = withPlanExecBatchUpdate(state, "batch-1", (batch) => {
      const snapshot = {
        ...batch.snapshot,
        otra: {
          head: secondBase,
          branch: command(other.path, "branch", "--show-current"),
          dirty: [],
        },
      };
      const sources = [
        ...(batch.commit_proposal?.sources ?? []),
        {
          alias: "otra",
          paths: ["other.txt"],
          dirty,
          message: "feat(flow): otra fuente session236",
        },
      ];
      const digest = semanticDigest({ batch: batch.id, snapshot, sources });
      return { ...batch, snapshot, commit_proposal: { sources, digest, approved_digest: digest } };
    });
    await writeFile(locateRun(paths, SESSION).statePath, serializeRunState(complete));
    expect((await commit(complete.digest)).ok).toBe(true);
    const read = await readRun(fs, locateRun(paths, SESSION));
    if (!read.ok) throw new Error(read.failure.message);
    expect(Object.keys(read.state.batches?.[0]?.commit_result ?? {}).sort()).toEqual([
      ALIAS,
      "otra",
    ]);
    expect((await git.commitInfo(unit, command(unit, "rev-parse", "HEAD"))).paths).toEqual([
      "included.txt",
    ]);
    const info = await git.commitInfo(other.path, command(other.path, "rev-parse", "HEAD"));
    expect(info.paths).toEqual(["other.txt"]);
    expect(info.message).toBe("feat(flow): otra fuente session236");
  });

  it("la propuesta sin cambios se vuelve a verificar antes de publicar batch-close", async () => {
    const state = await seal();
    const other = await secondUnit();
    await mkdir(join(root, "docs", "plans"), { recursive: true });
    await writeFile(
      join(root, PLAN),
      "# Plan\n## Tasks\n### F1 — fase\n> Estado: pendiente\n- [ ] T1.1 — trabajo\n",
    );
    await writeFile(join(unit, "included.txt"), "base\n");
    const next = withPlanExecBatchUpdate(state, "batch-1", (batch) => ({
      ...batch,
      snapshot: {
        ...batch.snapshot,
        otra: {
          head: command(other.path, "rev-parse", "HEAD"),
          branch: command(other.path, "branch", "--show-current"),
          dirty: [],
        },
      },
      commit_proposal: { sources: [], digest: "no-changes" },
      commit_result: {},
    }));
    await writeFile(locateRun(paths, SESSION).statePath, serializeRunState(next));
    await writeFile(join(other.path, "other.txt"), "movido\n");
    const result = await internalActionExecutor({ fs, git, env, paths })(
      { operation: "plan-exec.batch-close" },
      {
        session: SESSION,
        code: SESSION,
        scope: { plan: PLAN, sources: [ALIAS, "otra"] },
        proposal: null,
        state_digest: next.digest,
      },
    );
    expect(result.ok).toBe(false);
    expect(result.summary).toContain("otra");
  });

  it("commitea sólo rutas aprobadas, conserva un staged ajeno y reconoce la reentrada", async () => {
    const state = await seal();
    await writeFile(join(unit, "outside.txt"), "ajeno\n");
    command(unit, "add", "outside.txt");
    // The proposal predates this new dirty path: fail closed before any commit.
    expect((await commit(state.digest)).ok).toBe(false);
    expect(command(unit, "rev-parse", "HEAD")).toBe(state.batches?.[0]?.snapshot?.[ALIAS]?.head);
    command(unit, "reset", "--", "outside.txt");
    await writeFile(join(unit, "outside.txt"), "base\n");
    const done = await commit(state.digest);
    expect(done.ok).toBe(true);
    const head = command(unit, "rev-parse", "HEAD");
    expect(command(unit, "show", "--format=%B", "-s", "HEAD")).toBe(MESSAGE);
    expect(command(unit, "diff-tree", "--no-commit-id", "--name-only", "-r", "HEAD")).toBe(
      "included.txt",
    );
    const read = await readRun(fs, locateRun(paths, SESSION));
    if (!read.ok) throw new Error(read.failure.message);
    expect(read.state.batches?.[0]?.commit_result?.[ALIAS]?.after).toBe(head);
    expect((await commit(read.state.digest)).ok).toBe(true);
    expect(command(unit, "rev-parse", "HEAD")).toBe(head);
  });

  it("niega digest sin aprobar, cambios de HEAD y bytes distintos sobre la misma ruta", async () => {
    const unapproved = await seal({ approved: false });
    expect((await commit(unapproved.digest)).ok).toBe(false);
    const approved = await seal();
    await writeFile(join(unit, "included.txt"), "movido\n");
    expect((await commit(approved.digest)).ok).toBe(false);
    const reset = await seal();
    command(
      unit,
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.com",
      "commit",
      "--allow-empty",
      "--quiet",
      "-m",
      "ajeno",
    );
    expect((await commit(reset.digest)).ok).toBe(false);
  });

  it("si git commiteó antes de guardar el recibo reconoce su propio commit sin duplicarlo", async () => {
    const state = await seal();
    const sessionDir = join(paths.cwdSessionsDir(), SESSION);
    await writeCustody(
      fs,
      sessionDir,
      birthCustody({
        subject: { kind: "session", key: SESSION },
        subjectPath: `.workflow/sessions/${SESSION}`,
        parents: [],
        artifacts: [],
        created: "2026-09-27",
      }),
    );
    const committed = await git.commitPaths(unit, MESSAGE, ["included.txt"]);
    const recognized = await commit(state.digest);
    expect(recognized.ok).toBe(true);
    const read = await readRun(fs, locateRun(paths, SESSION));
    if (!read.ok) throw new Error(read.failure.message);
    expect(read.state.batches?.[0]?.commit_result?.[ALIAS]).toEqual(committed);
    expect(command(unit, "rev-list", "--count", `${committed.before}..HEAD`)).toBe("1");
    const custody = await readCustody(fs, sessionDir);
    expect(
      custody.status === "present" &&
        custody.custody.effects.filter(
          (effect) => effect.kind === "commit" && effect.after === committed.after,
        ),
    ).toHaveLength(1);
    expect((await commit(read.state.digest)).ok).toBe(true);
    const repeated = await readCustody(fs, sessionDir);
    expect(
      repeated.status === "present" &&
        repeated.custody.effects.filter(
          (effect) => effect.kind === "commit" && effect.after === committed.after,
        ),
    ).toHaveLength(1);
  });

  it("una instantánea sucia no permite empezar otro lote en la unidad", async () => {
    await writeFile(join(unit, "included.txt"), "pendiente\n");
    const batch = {
      id: "batch-1",
      iteration: 1,
      mode: "isolated" as const,
      phases: [1],
      tasks: ["T1.1"],
      plan_digest: "plan",
      stage: "inferred" as const,
    };
    let state = withScope(newRunState("plan-exec", SESSION), { plan: PLAN, sources: [ALIAS] });
    state = withPlanExecBatchLoop(withPlanExecBatch(state, batch), { pending: true, iteration: 1 });
    await writeFile(locateRun(paths, SESSION).statePath, serializeRunState(state));
    const result = await internalActionExecutor({ fs, git, env, paths })(
      { operation: "worktree.ensure" },
      {
        session: SESSION,
        code: SESSION,
        scope: { plan: PLAN, sources: [ALIAS] },
        proposal: null,
        state_digest: state.digest,
      },
    );
    expect(result.ok).toBe(false);
    expect(JSON.parse(result.output).failure.code).toBe("PLAN_EXEC_BATCH_UNIT_DIRTY");
    const read = await readRun(fs, locateRun(paths, SESSION));
    expect(read.ok && read.state.batches?.[0]?.snapshot).toBeUndefined();
  });

  it("corrida heredada con un lote cerrado sin recibos conserva sus cambios al adquirir el siguiente", async () => {
    await writeFile(join(unit, "included.txt"), "sin commit del lote anterior\n");
    let state = withScope(newRunState("plan-exec", SESSION), { plan: PLAN, sources: [ALIAS] });
    const previous = {
      id: "batch-1",
      iteration: 1,
      mode: "isolated" as const,
      phases: [1],
      tasks: ["T1.1"],
      plan_digest: "before",
      published_plan_digest: "after",
      stage: "closed" as const,
    };
    const current = {
      id: "batch-2",
      iteration: 2,
      mode: "isolated" as const,
      phases: [2],
      tasks: ["T2.1"],
      plan_digest: "after",
      stage: "inferred" as const,
    };
    state = withPlanExecBatchLoop(withPlanExecBatch(withPlanExecBatch(state, previous), current), {
      pending: true,
      iteration: 2,
    });
    await writeFile(locateRun(paths, SESSION).statePath, serializeRunState(state));
    const result = await internalActionExecutor({ fs, git, env, paths })(
      { operation: "worktree.ensure" },
      {
        session: SESSION,
        code: SESSION,
        scope: { plan: PLAN, sources: [ALIAS] },
        proposal: null,
        state_digest: state.digest,
      },
    );
    expect(result.ok).toBe(true);
    const read = await readRun(fs, locateRun(paths, SESSION));
    if (!read.ok) throw new Error(read.failure.message);
    expect(read.state.batches?.[1]?.base?.[ALIAS]).toBeTruthy();
    expect(read.state.batches?.[1]?.snapshot).toBeUndefined();
    expect((await git.dirtyPaths(unit)).map((item) => item.path)).toEqual(["included.txt"]);
  });

  it("commitPaths por sí mismo respeta la lista y devuelve padres, rama y SHAs", async () => {
    const before = command(unit, "rev-parse", "HEAD");
    await writeFile(join(unit, "included.txt"), "lote\n");
    await writeFile(join(unit, "outside.txt"), "ajeno\n");
    command(unit, "add", "outside.txt");
    const receipt = await git.commitPaths(unit, MESSAGE, ["included.txt"]);
    expect(receipt).toMatchObject({
      before,
      branch: command(unit, "branch", "--show-current"),
      parents: [before],
    });
    expect((await git.commitInfo(unit, receipt.after)).paths).toEqual(["included.txt"]);
    expect(command(unit, "diff", "--cached", "--name-only")).toBe("outside.txt");
    expect((await git.dirtyPaths(unit)).map((entry) => entry.path)).toEqual(["outside.txt"]);
  });

  it("rechaza un hook que altera el mensaje aunque git haya movido HEAD", async () => {
    const state = await seal();
    const hook = join(source, ".git", "hooks", "prepare-commit-msg");
    await writeFile(hook, "#!/bin/sh\nprintf 'mensaje cambiado\\n' > \"$1\"\n");
    await chmod(hook, 0o755);
    expect((await commit(state.digest)).ok).toBe(false);
    const read = await readRun(fs, locateRun(paths, SESSION));
    expect(read.ok && read.state.batches?.[0]?.commit_result).toBeUndefined();
    expect(command(unit, "show", "-s", "--format=%B", "HEAD")).toBe("mensaje cambiado");
  });

  it("la propuesta sella mensaje/rutas/hashes; la frontera humana muestra la vista y sólo la aprobación commitea", async () => {
    const original = await seal();
    let state = withPlanExecBatchUpdate(original, "batch-1", (batch) => ({
      ...batch,
      commit_proposal: undefined,
    }));
    const prefix = journeyOfFlow("plan-exec").map((row) => row.id);
    const position = prefix.indexOf("plan-exec.batch-commit-proposal");
    const { digest: _old, ...body } = state;
    state = sealRunState({
      ...body,
      applied: prefix.slice(0, position),
      boundary: "plan-exec.batch-commit-proposal",
    });
    await writeFile(locateRun(paths, SESSION).statePath, serializeRunState(state));
    const executor = internalActionExecutor({ fs, git, env, paths });
    const offered = await submitFlow(fs, paths, {
      code: SESSION,
      raw: JSON.stringify({
        input_digest: resolveBoundary(state, journeyForState(state)).seal,
        decisions: { messages: { [ALIAS]: MESSAGE } },
      }),
      approval: null,
      executor,
      git,
    });
    if (!offered.ok) throw new Error(JSON.stringify(offered));
    expect(offered.directive.boundary.transition, JSON.stringify(offered.directive.error)).toBe(
      "plan-exec.batch-commit-authorization",
    );
    expect(offered.directive.boundary.title).toContain("included.txt");
    expect(offered.directive.boundary.title).toContain(MESSAGE);
    expect(offered.directive.choices.map((choice) => choice.label)).toEqual([
      "Aprobar los commits del lote",
      "Compactar",
      "Cerrar",
    ]);
    const before = command(unit, "rev-parse", "HEAD");
    const authorized = await submitFlow(fs, paths, {
      code: SESSION,
      raw: JSON.stringify({
        input_digest: offered.directive.state_digest,
        choice: "Aprobar los commits del lote",
      }),
      approval: null,
      executor,
      git,
    });
    if (!authorized.ok) throw new Error(JSON.stringify(authorized));
    expect(command(unit, "rev-parse", "HEAD")).not.toBe(before);
    const read = await readRun(fs, locateRun(paths, SESSION));
    if (!read.ok) throw new Error(read.failure.message);
    expect(read.state.batches?.[0]?.commit_result?.[ALIAS]?.before).toBe(before);
    expect(read.state.batches?.[0]?.commit_proposal?.approved_digest).toBe(
      read.state.batches?.[0]?.commit_proposal?.digest,
    );
    expect(read.state.applied).toContain("plan-exec.batch-commit");
  });
});
