import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { GitCliAdapter } from "../../src/adapters/git-cli.js";
import { NodeProcess } from "../../src/adapters/node-process.js";
import { effectsOfTransition } from "../../src/application/flow/advance.js";
import { completeAnswer } from "../../src/application/flow/answer-completion.js";
import { locateRun, readRun } from "../../src/application/flow/run-state-service.js";
import { submitFlow } from "../../src/application/flow/submit.js";
import { PathsService } from "../../src/application/paths-service.js";
import type { FlowDecision } from "../../src/domain/flow/authority.js";
import { journeyOfFlow } from "../../src/domain/flow/authority.js";
import {
  newRunState,
  sealRunState,
  serializeRunState,
  withPlanExecBatch,
  withPlanExecBatchLoop,
  withScope,
} from "../../src/domain/flow/run-state.js";
import { normalizeNamespace } from "../../src/runtime/namespace.js";
import {
  COUNTED_FLOWS,
  type MeasuredRun,
  countAgentCalls,
  openMeasuredRun,
} from "../helpers/agent-calls.js";
import { NodeFileSystem } from "../helpers/real-fs.js";
import { testExecutor } from "../helpers/test-executor.js";

/**
 * The agent's minimal answer to a boundary applies exactly like the complete one
 * (plan 082, F5 · spec 061 AC-06, AC-07): the CLI fills the digest, the sealed
 * invocation, the effects, the evidence id and the checkout proofs, reads a
 * document sent by path and seals its status — and whatever the agent does send
 * is still judged.
 */

const REFERENCE = JSON.parse(
  readFileSync(join(__dirname, "..", "fixtures", "agent-calls-27.0.1.json"), "utf8"),
) as {
  flows: Record<string, Record<"opening" | "submits" | "commands" | "proves" | "total", number>>;
};

let run: MeasuredRun | null = null;
afterEach(async () => {
  await run?.dispose();
  run = null;
});

/** Answer as the minimal agent would until the run stands on `transition`. */
async function walkTo(flow: MeasuredRun["flow"], transition: string): Promise<MeasuredRun> {
  const opened = await openMeasuredRun(flow);
  run = opened;
  let directive = opened.opened;
  for (let step = 0; step < 60; step += 1) {
    const { resolved } = await opened.current();
    if (resolved.stopped?.id === transition) return opened;
    if (resolved.stopped === null) break;
    const plan = await opened.answerFor(directive, resolved);
    const result = await opened.submit(plan.raw, plan.approval);
    if (!result.ok) throw new Error(JSON.stringify(result));
    directive = result.directive;
  }
  throw new Error(`${flow} nunca llegó a ${transition}`);
}

describe("minimal and complete answers are the same answer", () => {
  it("each of the five flows walks the same journey both ways, and only the minimal skips prove", async () => {
    for (const flow of COUNTED_FLOWS) {
      const minimal = await countAgentCalls(flow, { answers: "minimal" });
      const complete = await countAgentCalls(flow, { answers: "complete" });
      expect(
        minimal.stops.map((s) => s.transition),
        flow,
      ).toEqual(complete.stops.map((s) => s.transition));
      expect(minimal.proves, flow).toBe(0);
      // Only the proves differ: the minimal answer drops them and nothing else.
      for (const kind of ["opening", "submits", "commands"] as const) {
        expect(minimal[kind], `${flow} ${kind}`).toBe(complete[kind]);
      }
      // The complete walk is the 27.0.1 agent's: it proves exactly what the frozen
      // reference proves, and costs no more of any kind. The equality holds while no
      // proof-bearing boundary turns internal; the phase that does it updates this
      // expectation in its own commit, never loosens it.
      const frozen = REFERENCE.flows[flow];
      expect(complete.proves, flow).toBe(frozen?.proves);
      for (const kind of ["opening", "submits", "commands", "total"] as const) {
        expect(complete[kind], `${flow} ${kind}`).toBeLessThanOrEqual(frozen?.[kind] ?? 0);
      }
    }
  }, 120_000);

  it("the same minimal answer applies in two consecutive iterations of a batch", async () => {
    const walked = await countAgentCalls("plan-exec", { execPhases: 2 });
    const stops = walked.stops.map((s) => s.transition);
    expect(stops.filter((id) => id === "plan-exec.implementation")).toHaveLength(2);
    expect(stops.filter((id) => id === "plan-exec.validation-execution")).toHaveLength(2);
    expect(stops.at(-1)).toBe("chassis.commit-choice");
  }, 60_000);

  it("a minimal answer resent is applied once and never lands on the next boundary", async () => {
    const at = await walkTo("quick", "quick.entry-gate-signal");
    const answer = { transition: "quick.entry-gate-signal", signals: [], decisions: { paso: "x" } };
    const first = await at.submit(answer);
    expect(first.ok && first.directive.boundary.transition).not.toBe("quick.entry-gate-signal");
    const again = await at.submit(answer);
    expect(again.ok).toBe(false);
    if (!again.ok && "failure" in again) expect(again.failure.code).toBe("FLOW_ANSWER_STALE");
    const { state } = await at.current();
    expect(state.applied.filter((id) => id === "quick.entry-gate-signal")).toHaveLength(1);
  }, 30_000);
});

describe("what the agent sends is still judged", () => {
  it("an explicit `applied` shorter than what the row declares is refused", async () => {
    const at = await walkTo("quick", "quick.convergence-gate");
    const { state, resolved } = await at.current();
    const declared = [...effectsOfTransition(state, resolved.stopped as FlowDecision)];
    expect(declared.length).toBeGreaterThan(0);
    const result = await at.submit({
      transition: "quick.convergence-gate",
      outcome: "completed",
      detail: "salida real",
      effects: { planned: declared, approved: [], applied: [] },
    });
    if (!result.ok) throw new Error(JSON.stringify(result));
    expect(result.directive.error?.code).toBe("FLOW_EFFECT_PARTIAL");
  }, 30_000);

  it("a plan proposed as done is refused instead of silently reopened", async () => {
    const at = await walkTo("plan-new", "plan-new.save-proposal");
    const result = await at.submit({
      transition: "plan-new.save-proposal",
      artifacts: [
        {
          path: "docs/plans/001-plan-medida.md",
          content: "# Plan 001 — medida\n\n> Estado: done\n",
        },
      ],
    });
    expect(result.ok).toBe(false);
    if (!result.ok && "failure" in result)
      expect(result.failure.code).toBe("FLOW_PROPOSAL_PLAN_DONE");
  }, 30_000);

  it("a draft outside the session folder is refused before anything is judged", async () => {
    const at = await walkTo("spec-refine", "spec-refine.save-proposal");
    for (const draft of ["../fuera.md", "/tmp/fuera.md"]) {
      const result = await at.submit({
        transition: "spec-refine.save-proposal",
        artifacts: [{ path: "docs/specs/001-spec-medida.md", draft }],
      });
      expect(result.ok).toBe(false);
      if (!result.ok && "failure" in result)
        expect(result.failure.code).toBe("FLOW_ARTIFACT_DRAFT_OUTSIDE");
    }
  }, 30_000);
});

describe("a document travels by path, and its status is the CLI's", () => {
  const BODY =
    "# Spec 001 — medida\n\n## Objective\n\nMedir.\n\n## Acceptance criteria\n\n- [ ] AC-01: se recorre.\n";

  async function proposed(byPath: boolean): Promise<{ digest: string; published: string }> {
    const at = await walkTo("spec-refine", "spec-refine.save-proposal");
    const path = "docs/specs/001-spec-medida.md";
    if (byPath) {
      await writeFile(join(at.paths.cwdSessionsDir(), at.session, "draft.md"), BODY, "utf8");
    }
    const proposal = await at.submit({
      transition: "spec-refine.save-proposal",
      artifacts: [byPath ? { path, draft: "draft.md" } : { path, content: BODY }],
    });
    if (!proposal.ok) throw new Error(JSON.stringify(proposal));
    const { state } = await at.current();
    const digest = state.proposal?.digest ?? "";
    const approved = await at.submit({
      transition: "spec-refine.save-confirmation",
      choice: "Aprobar y guardar",
    });
    if (!approved.ok) throw new Error(JSON.stringify(approved));
    const published = await readFile(join(at.root, path), "utf8");
    await at.dispose();
    run = null;
    return { digest, published };
  }

  it("by path and inline seal the same digest, with status: ready-for-plan", async () => {
    const inline = await proposed(false);
    const byPath = await proposed(true);
    expect(byPath.digest).toBe(inline.digest);
    expect(byPath.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(byPath.published).toBe(inline.published);
    expect(byPath.published.startsWith("---\nstatus: ready-for-plan\n---\n")).toBe(true);
  }, 60_000);
});

describe("a batch of several sources gets one captured proof per source", () => {
  let root: string | null = null;
  afterEach(async () => {
    if (root !== null) await rm(root, { recursive: true, force: true });
    root = null;
  });

  const MINIMAL = JSON.stringify({
    transition: "plan-exec.validation-execution",
    outcome: "completed",
    detail: "vitest: 3 passed",
  });

  /** An in-place plan-exec standing on its phase validation over two real sources. */
  async function atValidation(scopeSources: string[]) {
    root = await mkdtemp(join(tmpdir(), "aw-minimal-sources-"));
    const home = join(root, "home");
    await mkdir(home);
    const repos: Record<string, string> = {};
    for (const alias of ["uno", "dos"]) {
      const repo = join(root, alias);
      await mkdir(repo);
      const git = (...args: string[]) => execFileSync("git", args, { cwd: repo });
      git("init", "--quiet", "--initial-branch=main");
      git("config", "user.email", "t@example.com");
      git("config", "user.name", "T");
      await writeFile(join(repo, "base.txt"), "base\n");
      git("add", "-A");
      git("commit", "--quiet", "-m", "base");
      await writeFile(join(repo, "run.txt"), "cambio del lote\n");
      repos[alias] = repo;
    }
    await writeFile(
      join(root, "CLAUDE.md"),
      `<!-- WORKFLOW-HUB-START -->\n## Hub\nPrueba\n## Fuentes\n| Alias | Path | Rama principal |\n|---|---|---|\n| uno | ${repos.uno} | main |\n| dos | ${repos.dos} | main |\n## Status\n- Modo de edición: in-place\n<!-- WORKFLOW-HUB-END -->\n`,
    );
    await mkdir(join(root, "docs", "plans"), { recursive: true });
    await writeFile(
      join(root, "docs", "plans", "072-plan-test.md"),
      "# Plan 072 — fuentes\n\n> Standalone: dos fuentes\n> Límite de ejecución: checkout\n\n## Tasks\n\n### F1 — dos fuentes\n> Estado: pendiente\n> Fuentes: uno, dos\n\n- [ ] T1.1 — tocar las dos _(fuentes: uno, dos)_\n",
    );
    const fs = new NodeFileSystem();
    const paths = new PathsService(normalizeNamespace("workflow"), home, root);
    const session = "301-fuentes-plan-exec";
    await mkdir(join(paths.cwdSessionsDir(), session), { recursive: true });
    await writeFile(
      join(paths.cwdSessionsDir(), session, "SESSION.md"),
      "# S\n\n## Objective\nx\n",
    );
    const scope = {
      plan: "docs/plans/072-plan-test.md",
      sources: scopeSources,
      isolation: "in-place" as const,
    };
    const ids = journeyOfFlow("plan-exec").map((row) => row.id);
    const batched = withPlanExecBatchLoop(
      withPlanExecBatch(withScope(newRunState("plan-exec", session), scope), {
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
    const { digest: _digest, ...body } = batched;
    const state = sealRunState({
      ...body,
      applied: ids.slice(0, ids.indexOf("plan-exec.validation-execution")),
      boundary: "plan-exec.validation-execution",
    });
    await writeFile(locateRun(paths, session).statePath, serializeRunState(state));
    const git = new GitCliAdapter(new NodeProcess());
    const read = async () => {
      const current = await readRun(fs, locateRun(paths, session));
      if (!current.ok) throw new Error(current.failure.code);
      return current.state;
    };
    const submit = (raw: string) =>
      submitFlow(fs, paths, {
        code: session,
        raw,
        approval: null,
        executor: testExecutor(fs, paths),
        git,
      });
    return { fs, paths, session, repos, git, read, submit };
  }

  it("the phase validation credits both sources from a minimal answer", async () => {
    const at = await atValidation(["uno", "dos"]);
    const result = await at.submit(MINIMAL);
    if (!result.ok) throw new Error(JSON.stringify(result));
    expect(result.directive.error).toBeNull();
    expect(Object.keys((await at.read()).batches?.[0]?.credit ?? {}).sort()).toEqual([
      "dos",
      "uno",
    ]);
  }, 30_000);

  it("a proof the CLI cannot capture is refused as prove refuses it, and costs no attempt", async () => {
    const at = await atValidation(["uno", "tres"]);
    const result = await at.submit(MINIMAL);
    expect(result.ok).toBe(false);
    if (!result.ok && "failure" in result) {
      expect(result.failure.code).toBe("WORKLINE_CHECKOUT_PROOF_INVALID");
      expect(result.failure.message).toContain("'tres'");
    }
    expect((await at.read()).attempts).toEqual([]);
  }, 30_000);

  it("a source whose root is no checkout is refused as prove refuses it, and costs no attempt", async () => {
    const at = await atValidation(["uno", "dos"]);
    await rm(join(at.repos.dos as string, ".git"), { recursive: true, force: true });
    const result = await at.submit(MINIMAL);
    expect(result.ok).toBe(false);
    if (!result.ok && "failure" in result) {
      expect(result.failure.code).toBe("FLOW_PROVE_CHECKOUT_UNOBSERVABLE");
    }
    expect((await at.read()).attempts).toEqual([]);
  }, 30_000);

  it("the attempt identity keeps the measured checkouts: a changed tree is a new attempt", async () => {
    const at = await atValidation(["uno", "dos"]);
    const identity = async () => {
      const done = await completeAnswer(at.fs, at.paths, {
        raw: MINIMAL,
        session: at.session,
        git: at.git,
      });
      if (!done.ok) throw new Error(JSON.stringify(done));
      return done.identity;
    };
    const first = await identity();
    expect(await identity()).toBe(first);
    await writeFile(join(at.repos.uno as string, "run.txt"), "otro cambio\n");
    expect(await identity()).not.toBe(first);
  }, 30_000);
});
