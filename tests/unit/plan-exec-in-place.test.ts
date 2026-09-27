import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { GitCliAdapter } from "../../src/adapters/git-cli.js";
import { NodeProcess } from "../../src/adapters/node-process.js";
import { resolveBoundary } from "../../src/application/flow/advance.js";
import { resolveCheckoutCandidates } from "../../src/application/flow/checkout-observation.js";
import { preserveBoundaryClose } from "../../src/application/flow/close-artifacts.js";
import { internalActionExecutor } from "../../src/application/flow/internal-actions.js";
import { proveFlowBoundary } from "../../src/application/flow/prove.js";
import { locateRun, readRun } from "../../src/application/flow/run-state-service.js";
import { submitFlow } from "../../src/application/flow/submit.js";
import { PathsService } from "../../src/application/paths-service.js";
import { semanticDigest } from "../../src/application/semantic-operation/protocol.js";
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

let root: string;
afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});

it("commitea sólo las rutas declaradas en la rama del checkout, sin crear aw/*", async () => {
  root = await mkdtemp(join(tmpdir(), "aw-in-place-"));
  const repo = join(root, "source");
  const home = join(root, "home");
  const session = "244-in-place-plan-exec";
  await mkdir(repo);
  await mkdir(home);
  const command = (...args: string[]) =>
    execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
  command("init", "--quiet", "--initial-branch=main");
  command("config", "user.name", "Test");
  command("config", "user.email", "test@example.com");
  await writeFile(join(repo, "user.txt"), "base\n");
  await writeFile(join(repo, "run.txt"), "base\n");
  command("add", ".");
  command("commit", "--quiet", "-m", "base");
  command("switch", "--quiet", "-c", "feature/verificaciones-rechazo");
  await writeFile(join(repo, "user.txt"), "edición del usuario\n");
  await writeFile(
    join(root, "CLAUDE.md"),
    `<!-- WORKFLOW-PROJECT-START -->\n## Proyecto\nPrueba\n## Fuentes\n| Alias | Path | Rama principal |\n|---|---|---|\n| codigo | ${repo} | main |\n## Status\n- Modo de edición: in-place\n<!-- WORKFLOW-PROJECT-END -->\n`,
  );
  const fs = new NodeFileSystem();
  const git = new GitCliAdapter(new NodeProcess());
  const paths = new PathsService(normalizeNamespace("workflow"), home, root);
  const env = new FakeEnv(home, root);
  await mkdir(join(paths.cwdSessionsDir(), session), { recursive: true });
  const scope = {
    plan: "docs/plans/072-plan-test.md",
    sources: ["codigo"],
    isolation: "in-place" as const,
  };
  let state = withScope(newRunState("plan-exec", session), scope);
  state = withPlanExecBatchLoop(
    withPlanExecBatch(state, {
      id: "batch-1",
      iteration: 1,
      mode: "isolated",
      phases: [1],
      tasks: ["T1.1"],
      plan_digest: "plan",
      stage: "implementing",
    }),
    { pending: true, iteration: 1 },
  );
  await writeFile(locateRun(paths, session).statePath, serializeRunState(state));
  const rootCandidate = await resolveCheckoutCandidates(fs, paths, session);
  expect(rootCandidate.find((candidate) => candidate.source === "codigo")?.root).toBe(repo);
  const acquired = await internalActionExecutor({ fs, git, env, paths })(
    { operation: "worktree.ensure" },
    { session, code: session, scope, proposal: null, state_digest: state.digest },
  );
  expect(acquired.ok).toBe(true);
  expect(acquired.summary).toContain("in-place: sin unidad");
  expect(command("branch", "--list", "aw/*")).toBe("");
  const live = await readRun(fs, locateRun(paths, session));
  if (!live.ok) throw new Error(JSON.stringify(live));
  const snapshot = live.state.batches?.[0]?.snapshot;
  expect(snapshot?.codigo?.dirty.map((entry) => entry.path)).toEqual(["user.txt"]);
  await writeFile(join(repo, "run.txt"), "edición de la corrida\n");
  await writeFile(join(repo, "stranger.txt"), "ruta nueva ajena\n");
  const validation = journeyOfFlow("plan-exec").map((row) => row.id);
  const { digest: _oldValidation, ...validationBody } = live.state;
  const atValidation = sealRunState({
    ...validationBody,
    applied: validation.slice(0, validation.indexOf("plan-exec.validation-execution")),
    boundary: "plan-exec.validation-execution",
  });
  await writeFile(locateRun(paths, session).statePath, serializeRunState(atValidation));
  const proof = await proveFlowBoundary(fs, paths, { code: session, source: "codigo", git });
  expect(proof.ok).toBe(true);
  if (!proof.ok) throw new Error(JSON.stringify(proof));
  expect(proof.receipt.checkout.root).toBe(repo);
  const proposalReady = withPlanExecBatchUpdate(live.state, "batch-1", (batch) => ({
    ...batch,
    credit: { codigo: "proof" },
    review: batchReview(),
  }));
  const prefix = journeyOfFlow("plan-exec").map((row) => row.id);
  const position = prefix.indexOf("plan-exec.batch-commit-proposal");
  const { digest: _oldDigest, ...body } = proposalReady;
  const atProposal = sealRunState({
    ...body,
    applied: prefix.slice(0, position),
    boundary: "plan-exec.batch-commit-proposal",
  });
  await writeFile(locateRun(paths, session).statePath, serializeRunState(atProposal));
  await writeFile(join(repo, "user.txt"), "usuario y corrida tocaron esta ruta\n");
  const collision = await submitFlow(fs, paths, {
    code: session,
    raw: JSON.stringify({
      input_digest: resolveBoundary(atProposal, journeyForState(atProposal)).seal,
      decisions: {
        messages: { codigo: "feat: corrida in-place" },
        paths: { codigo: ["user.txt"] },
      },
    }),
    approval: null,
    executor: internalActionExecutor({ fs, git, env, paths }),
    git,
  });
  if (!collision.ok) throw new Error(JSON.stringify(collision));
  expect(collision.directive.error?.code).toBe("PLAN_EXEC_BATCH_SHARED_PATH");
  expect(command("log", "-1", "--format=%s")).toBe("base");
  await writeFile(join(repo, "user.txt"), "edición del usuario\n");
  const offered = await submitFlow(fs, paths, {
    code: session,
    raw: JSON.stringify({
      input_digest: collision.directive.state_digest,
      decisions: {
        messages: { codigo: "feat: corrida in-place" },
        paths: { codigo: ["run.txt"] },
      },
    }),
    approval: null,
    executor: internalActionExecutor({ fs, git, env, paths }),
    git,
  });
  if (!offered.ok) throw new Error(JSON.stringify(offered));
  expect(offered.directive.boundary.title).toContain("stranger.txt");
  expect(offered.directive.boundary.title).toContain("user.txt");
  expect(offered.directive.boundary.title).toContain("run.txt");
  expect(command("log", "-1", "--format=%s")).toBe("base");
  const beforeClose = await readRun(fs, locateRun(paths, session));
  if (!beforeClose.ok) throw new Error(JSON.stringify(beforeClose));
  const pending = await preserveBoundaryClose(fs, paths, git, beforeClose.state, []);
  expect(pending.join(" ")).toContain("run.txt");
  expect(pending.join(" ")).not.toContain("user.txt");
  expect(pending.join(" ")).not.toContain("stranger.txt");
  const dirty = (await git.dirtyPaths(repo)).filter((entry) => entry.path === "run.txt");
  const sources = [
    {
      alias: "codigo",
      paths: ["run.txt"],
      dirty,
      message: "feat: corrida in-place",
      foreign_paths: ["stranger.txt", "user.txt"],
    },
  ];
  const digest = semanticDigest({ batch: "batch-1", snapshot, sources });
  const updated = withPlanExecBatchUpdate(live.state, "batch-1", (batch) => ({
    ...batch,
    credit: { codigo: "proof" },
    review: batchReview(),
    commit_proposal: { sources, digest, approved_digest: digest },
  }));
  await writeFile(locateRun(paths, session).statePath, serializeRunState(updated));
  await writeFile(join(repo, "user.txt"), "edición concurrente del usuario\n");
  const shared = await internalActionExecutor({ fs, git, env, paths })(
    { operation: "plan-exec.batch-commit" },
    { session, code: session, scope, proposal: null, state_digest: updated.digest },
  );
  expect(shared.ok).toBe(false);
  expect(command("log", "-1", "--format=%s")).toBe("base");
  await writeFile(join(repo, "user.txt"), "edición del usuario\n");
  const committed = await internalActionExecutor({ fs, git, env, paths })(
    { operation: "plan-exec.batch-commit" },
    { session, code: session, scope, proposal: null, state_digest: updated.digest },
  );
  expect(committed.ok).toBe(true);
  expect(command("branch", "--show-current")).toBe("feature/verificaciones-rechazo");
  expect(command("show", "--format=", "--name-only", "HEAD")).toBe("run.txt");
  expect(command("status", "--short")).toContain("user.txt");
  expect(command("status", "--short")).toContain("stranger.txt");
  const afterClose = await readRun(fs, locateRun(paths, session));
  if (!afterClose.ok) throw new Error(JSON.stringify(afterClose));
  const finished = await preserveBoundaryClose(fs, paths, git, afterClose.state, []);
  expect(finished.join(" ")).not.toContain("sin commitear");
  expect(command("branch", "--list", "aw/*")).toBe("");
});
