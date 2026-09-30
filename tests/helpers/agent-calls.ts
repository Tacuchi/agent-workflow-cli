import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitCliAdapter } from "../../src/adapters/git-cli.js";
import { NodeProcess } from "../../src/adapters/node-process.js";
import type { WorklineFlow } from "../../src/application/capability/compose.js";
import { effectsOfTransition, resolveBoundary } from "../../src/application/flow/advance.js";
import { advanceFlow } from "../../src/application/flow/flow-service.js";
import { startFlow } from "../../src/application/flow/flow-start.js";
import { proveFlowBoundary } from "../../src/application/flow/prove.js";
import { journeyForRun } from "../../src/application/flow/run-journey.js";
import { locateRun, readRun } from "../../src/application/flow/run-state-service.js";
import { submitFlow } from "../../src/application/flow/submit.js";
import { PathsService } from "../../src/application/paths-service.js";
import { ALL_COMMANDS } from "../../src/cli/commands/index.js";
import {
  type FlowDecision,
  internalActionOf,
  proposalContractOf,
} from "../../src/domain/flow/authority.js";
import type { FlowDirective } from "../../src/domain/flow/directive.js";
import type { FlowRunState } from "../../src/domain/flow/run-state.js";
import { SOURCE_BOUNDED_EVIDENCE } from "../../src/domain/source-boundary.js";
import { normalizeNamespace } from "../../src/runtime/namespace.js";
import { worklineMarkerContent } from "../../src/runtime/workline-marker.js";
import { batchReview } from "./batch-review.js";
import { RecordingGit } from "./fake-git.js";
import { NodeFileSystem } from "./real-fs.js";
import { testExecutor } from "./test-executor.js";

/**
 * How many calls to `aw` an agent spends on one run of a flow, read from the
 * directive stream instead of from a fixed script.
 *
 * A scripted agent answers whatever boundary the CLI stands on, over the same
 * minimal workspace every time, and each directive is priced by what it asks
 * of the agent:
 *
 * - opening a run costs what the CLI surface demands: one call when `aw flow`
 *   offers `start`, three otherwise (`session-create`, `context-plan`,
 *   `flow advance --adopt`);
 * - a semantic, human or authorization stop costs one `submit`;
 * - an external execution stop costs the command plus its `submit`;
 * - each source-bounded proof the CLI does not capture itself costs one
 *   `aw flow prove`.
 *
 * Only the answers are scripted; the journey, its skips and its internal rows
 * are the CLI's own, so a boundary the CLI stops asking for stops costing.
 */

export interface AgentCallCount {
  flow: WorklineFlow;
  opening: number;
  submits: number;
  commands: number;
  proves: number;
  total: number;
  /** The boundaries the agent answered, in order, with what each cost. */
  stops: { transition: string; kind: string; calls: number }[];
}

export const COUNTED_FLOWS: readonly WorklineFlow[] = [
  "spec-refine",
  "plan-new",
  "plan-refine",
  "plan-exec",
  "quick",
];

const ALIAS = "acme";
const SPEC_DOC = "docs/specs/001-spec-medida.md";
const PLAN_DOC = "docs/plans/001-plan-medida.md";

const workspaceBlock = (source: string) => `<!-- AGENT-WORKFLOW-PROJECT-START -->
## Proyecto

Medida de llamadas.

## Fuentes

| Alias | Path | Rama principal |
|---|---|---|
| ${ALIAS} | ${source} | main |

## Pipeline

- ${ALIAS}: build \`npm run build\` · test \`npm test\`

## Status

- Ramas de trabajo actuales:
  - ${ALIAS}: main
<!-- AGENT-WORKFLOW-PROJECT-END -->
`;

const SPEC = `---
status: ready-for-plan
---

# Spec 001 — medida

## Objective

Medir las llamadas del agente.

## Acceptance criteria

- [ ] AC-01: el tramo se recorre entero.
`;

const PLAN = `# Plan 001 — medida

> Derived from ${SPEC_DOC}
> Estado: open
> Límite de ejecución: checkout

## Tasks

### F1 — el tramo se recorre
> Estado: pendiente
> Fuentes: ${ALIAS}

**Resultado:** el tramo se recorre entero.

- [ ] T1.1 — recorrer el tramo _(fuentes: ${ALIAS})_

**Validación de fase:** \`npm test\` pasa en el checkout.
**Condición de salida:** la prueba local queda verde.

## Execution batches

- B1 · isolated · F1

## Validations

- Validación final · \`${ALIAS}\` · build \`npm run build\` · tests \`npm test\`
`;

/**
 * plan-exec runs over the reserved `workspace` source: the count is about the
 * boundaries it asks, and an isolation unit in a real repository would only add
 * git to what is measured. `phases` isolated batches, each with one task.
 */
function execPlan(phases: number): string {
  const blocks = Array.from({ length: phases }, (_, index) => {
    const n = index + 1;
    return `### F${n} — el tramo ${n} se recorre
> Estado: pendiente
> Fuentes: workspace

**Resultado:** el tramo ${n} se recorre entero.

- [ ] T${n}.1 — recorrer el tramo ${n} _(fuentes: workspace)_

**Validación de fase:** \`npm test\` pasa en el checkout.
**Condición de salida:** la prueba local queda verde.
`;
  });
  const batches = Array.from({ length: phases }, (_, i) => `- B${i + 1} · isolated · F${i + 1}`);
  return `# Plan 001 — medida

> Derived from ${SPEC_DOC}
> Standalone: medida de llamadas
> Estado: open
> Límite de ejecución: checkout

## Tasks

${blocks.join("\n")}
## Execution batches

${batches.join("\n")}
`;
}

/** The session each flow runs in, and the documents it starts from. */
const SESSIONS: Record<WorklineFlow, string> = {
  "spec-new": "001-medida-spec-new",
  "spec-refine": "001-medida-spec-refine",
  "plan-new": "001-medida-plan-new",
  "plan-refine": "001-medida-plan-refine",
  "plan-exec": "001-medida-plan-exec",
  quick: "001-medida-quick",
};

export interface WalkOptions {
  /**
   * `minimal`: the transition, the judgment and the real output, and nothing the
   * CLI knows. `complete`: every field, with proofs taken by `aw flow prove`,
   * as a 27.0.1 agent answers. Default: minimal where the CLI completes answers.
   */
  answers?: "minimal" | "complete";
  /** plan-exec only: how many one-phase batches its plan declares. */
  execPhases?: number;
}

type Resolved = ReturnType<typeof resolveBoundary>;

/** One run of a flow over its own fresh workspace, answered as a scripted agent. */
export interface MeasuredRun {
  flow: WorklineFlow;
  root: string;
  paths: PathsService;
  session: string;
  opened: FlowDirective;
  /** What opening this run cost: 1 through `flow start`, 3 without it. */
  openingCalls: number;
  /** The boundary the run stands on now. */
  current(): Promise<{ state: FlowRunState; resolved: Resolved }>;
  /** Submit `raw` as the agent would, with the live checkout reader. */
  submit(raw: unknown, approval?: string | null): ReturnType<typeof submitFlow>;
  /** The answer the options ask for at the boundary in force. */
  answerFor(directive: FlowDirective, resolved: Resolved): Promise<AnswerPlan>;
  dispose(): Promise<void>;
}

interface AnswerPlan {
  raw: Record<string, unknown>;
  approval: string | null;
  proves: number;
}

/** `true` once `aw flow` offers the one-call opening. */
function offersStart(): boolean {
  const flow = ALL_COMMANDS.find((command) => command.name === "flow");
  return "start" in (flow?.flags.actions ?? {});
}

/** `true` once the directive publishes `proofs_captured`: the CLI completes minimal answers. */
function completesAnswers(directive: FlowDirective): boolean {
  return "proofs_captured" in directive.expects;
}

const fs = new NodeFileSystem();

async function seed(root: string, paths: PathsService, flow: WorklineFlow, phases: number) {
  const session = join(paths.cwdSessionsDir(), SESSIONS[flow]);
  await mkdir(join(session, "scripts"), { recursive: true });
  await writeFile(
    join(session, "SESSION.md"),
    "# SESSION — medida\n\n## Objective\nrecorrer el flujo entero\n\n## Success criteria\n- [x] el tramo se recorre entero\n",
    "utf8",
  );
  await writeFile(join(session, "CHECKPOINT.md"), "# CHECKPOINT\n\nsembrado\n", "utf8");
  await writeFile(join(root, "CLAUDE.md"), workspaceBlock(join(root, ALIAS)), "utf8");
  for (const dir of ["docs/specs", "docs/plans"]) await mkdir(join(root, dir), { recursive: true });
  await writeFile(join(root, SPEC_DOC), SPEC, "utf8");
  if (flow === "plan-refine") await writeFile(join(root, PLAN_DOC), PLAN, "utf8");
  if (flow === "plan-exec") await writeFile(join(root, PLAN_DOC), execPlan(phases), "utf8");
  await writeFile(
    join(root, ".agent-workflow", "workline.json"),
    worklineMarkerContent("agent-workflow"),
  );
  // The declared source exists, so the plan's aliases resolve.
  await mkdir(join(root, ALIAS), { recursive: true });
  await writeFile(join(root, ALIAS, ".keep"), "", "utf8");
  // A real checkout, so the proofs taken measure something.
  for (const args of [
    ["init", "--quiet", "--initial-branch=main"],
    ["config", "user.email", "medida@example.com"],
    ["config", "user.name", "Medida"],
    ["add", "-A"],
    ["commit", "--quiet", "-m", "medida"],
  ]) {
    execFileSync("git", args, { cwd: root });
  }
}

/** The document bytes an authoring boundary delivers. */
function artifactFor(stopped: FlowDecision) {
  const destination = proposalContractOf(stopped)?.destinations[0] ?? "docs";
  return destination.includes("plans")
    ? { path: PLAN_DOC, content: PLAN }
    : { path: `${destination}/001-spec-medida.md`, content: SPEC };
}

const ROUTE = {
  summary: { finding: "medida", diagnosis: "medida", solution: "medida" },
  basis: {
    intention: "medida",
    checkout: "medida",
    conventions: "medida",
    adopted_decisions: "medida",
  },
  controls: [],
};

/** The judgement a semantic boundary asks for, by the contract its row declares. */
function decisionsFor(stopped: FlowDecision): Record<string, unknown> {
  if (stopped.id === "chassis.route-evaluation") return { route: ROUTE };
  if (stopped.scopes_sources === true) return { plan: PLAN_DOC, sources: ["workspace"] };
  if (stopped.answer_contract === "batch-review") return { review: batchReview() };
  if (stopped.id === "plan-exec.batch-commit-proposal") return { messages: {} };
  if (stopped.id === "quick.fix-preview") {
    return { preview: { files: [], intent: "medida", diff: "sin cambios" } };
  }
  return { paso: stopped.id };
}

/** What the agent judges at a boundary, the same in both answer modes. */
function judgment(directive: FlowDirective, resolved: Resolved): Record<string, unknown> {
  const stopped = resolved.stopped as FlowDecision;
  if (resolved.kind === "execution") {
    return { outcome: "completed", detail: `salida real de ${directive.boundary.transition}` };
  }
  if (resolved.kind === "authorization") return { choice: "Autorizar el efecto" };
  if (resolved.kind !== "semantic") return { choice: directive.choices[0]?.label ?? "" };
  if (proposalContractOf(stopped) !== null) return { artifacts: [artifactFor(stopped)] };
  return { signals: [], decisions: decisionsFor(stopped) };
}

/** The sources whose proof a boundary demands: one per batch source, the document's elsewhere. */
function proofSources(state: FlowRunState, stopped: FlowDecision): string[] {
  return stopped.id === "plan-exec.validation-execution"
    ? [...(state.scope?.sources ?? [])]
    : ["workspace"];
}

export async function openMeasuredRun(
  flow: WorklineFlow,
  options: WalkOptions = {},
): Promise<MeasuredRun> {
  const root = await mkdtemp(join(tmpdir(), `aw-calls-${flow}-`));
  const paths = new PathsService(normalizeNamespace("agent-workflow"), root, root);
  const recording = new RecordingGit();
  const live = new GitCliAdapter(new NodeProcess());
  const executor = testExecutor(fs, paths, { git: recording });
  const session = SESSIONS[flow];
  const code = session.slice(0, 3);
  await seed(root, paths, flow, options.execPhases ?? 1);
  // The opening is credited by what really opened the run: `flow start` when the
  // surface offers it (one call), the three calls of 27.0.1 otherwise.
  const starting = offersStart();
  const opened = starting
    ? await startFlow({ fs, paths, git: live }, executor, {
        flow,
        name: "medida",
        objetivo: "recorrer el flujo entero",
      })
    : await advanceFlow(fs, paths, { code, flow, adopt: true, executor });
  if (!opened.ok)
    throw new Error(`no se pudo abrir la corrida de ${flow}: ${JSON.stringify(opened)}`);
  const adopted = { directive: "data" in opened ? opened.data.directive : opened.directive };
  if (starting && "data" in opened && opened.data.session.folder !== session) {
    throw new Error(`flow start abrió ${opened.data.session.folder} y no la sesión sembrada`);
  }

  async function current() {
    const read = await readRun(fs, locateRun(paths, session));
    if (!read.ok) throw new Error(`corrida ilegible: ${read.failure.code}`);
    return { state: read.state, resolved: resolveBoundary(read.state, journeyForRun(read.state)) };
  }

  function submit(raw: unknown, approval: string | null = null) {
    const stopped = raw as { transition?: string };
    return submitFlow(fs, paths, {
      code,
      raw: typeof raw === "string" ? raw : JSON.stringify(raw),
      approval,
      executor,
      // The commit proposal reads the recording git, so no real commit is
      // attempted; every other answer is observed against the live checkout.
      git: stopped.transition === "plan-exec.batch-commit-proposal" ? recording : live,
    });
  }

  async function executionValidations(
    evidence: readonly string[],
    state: FlowRunState,
    stopped: FlowDecision,
    detail: string,
  ) {
    const validations: Record<string, unknown>[] = [];
    let proves = 0;
    for (const id of evidence) {
      if (id !== SOURCE_BOUNDED_EVIDENCE) {
        validations.push({ id, passed: true, detail });
        continue;
      }
      for (const source of proofSources(state, stopped)) {
        const proved = await proveFlowBoundary(fs, paths, { code, source, git: live });
        if (!proved.ok)
          throw new Error(`prove de ${source} en ${stopped.id}: ${JSON.stringify(proved)}`);
        proves += 1;
        validations.push({ id, passed: true, detail, proof: proved.receipt.proof });
      }
    }
    return { validations, proves };
  }

  async function answerFor(directive: FlowDirective, resolved: Resolved): Promise<AnswerPlan> {
    const stopped = resolved.stopped as FlowDecision;
    const transition = directive.boundary.transition;
    const minimal = (options.answers ?? "minimal") === "minimal" && completesAnswers(directive);
    const judged = judgment(directive, resolved);
    const approval = resolved.kind === "authorization" ? directive.expects.approval.digest : null;
    if (minimal || resolved.kind !== "execution") {
      return {
        raw: { ...(minimal ? { transition } : { input_digest: resolved.seal }), ...judged },
        approval,
        proves: 0,
      };
    }
    const action = resolved.action;
    if (action === null) throw new Error(`${stopped.id} no nombra ninguna acción`);
    const { state } = await current();
    const detail = judged.detail as string;
    const { validations, proves } = await executionValidations(
      action.evidence,
      state,
      stopped,
      detail,
    );
    const declared = [...effectsOfTransition(state, stopped)];
    return {
      raw: {
        input_digest: resolved.seal,
        outcome: "completed",
        invocation: action.invocation,
        validations,
        effects: { planned: declared, approved: [], applied: declared },
        output: null,
      },
      approval,
      proves,
    };
  }

  return {
    flow,
    root,
    paths,
    session,
    opened: adopted.directive,
    openingCalls: starting ? 1 : 3,
    current,
    submit,
    answerFor,
    dispose: () => rm(root, { recursive: true, force: true }),
  };
}

const WRITES_THE_DELIVERABLE: ReadonlySet<string> = new Set([
  "plan-exec.implementation",
  "quick.deliverable-authoring",
]);

/** Walk one fresh run of `flow` to its end and price every stop. */
export async function countAgentCalls(
  flow: WorklineFlow,
  options: WalkOptions = {},
): Promise<AgentCallCount> {
  const run = await openMeasuredRun(flow, options);
  const count: AgentCallCount = {
    flow,
    opening: run.openingCalls,
    submits: 0,
    commands: 0,
    proves: 0,
    total: 0,
    stops: [],
  };
  try {
    let directive = run.opened;
    for (let step = 0; step < 200; step += 1) {
      const { state, resolved } = await run.current();
      if (resolved.stopped === null) break;
      if (resolved.kind !== "authorization" && internalActionOf(resolved.stopped) !== null) {
        const events = JSON.stringify(state.events.slice(-3));
        throw new Error(`${flow} quedó en la interna ${resolved.stopped.id}: ${events}`);
      }
      if (WRITES_THE_DELIVERABLE.has(resolved.stopped.id)) {
        // The deliverable changes the checkout, as real work does: a batch that
        // changed nothing credits nothing, and a quick with no diff asks no commit.
        await writeFile(join(run.root, "medida.txt"), `${step}\n`, "utf8");
      }
      const plan = await run.answerFor(directive, resolved);
      const commands = resolved.kind === "execution" ? 1 : 0;
      count.stops.push({
        transition: resolved.stopped.id,
        kind: resolved.kind,
        calls: 1 + commands + plan.proves,
      });
      count.submits += 1;
      count.commands += commands;
      count.proves += plan.proves;
      const result = await run.submit(plan.raw, plan.approval);
      if (!result.ok) throw new Error(`${flow}: ${JSON.stringify(result)}`);
      assertBoundaryAdvanced(flow, resolved.stopped.id, result.directive);
      directive = result.directive;
    }
    count.total = count.opening + count.submits + count.commands + count.proves;
    return count;
  } finally {
    await run.dispose();
  }
}

function assertBoundaryAdvanced(
  flow: WorklineFlow,
  transition: string,
  directive: FlowDirective,
): void {
  if (directive.error !== null && directive.boundary.transition === transition) {
    throw new Error(`${flow} se trabó en ${transition}: ${JSON.stringify(directive.error)}`);
  }
}
