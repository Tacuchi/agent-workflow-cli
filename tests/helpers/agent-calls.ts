import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WorklineFlow } from "../../src/application/capability/compose.js";
import { resolveBoundary } from "../../src/application/flow/advance.js";
import { advanceFlow } from "../../src/application/flow/flow-service.js";
import { journeyForRun } from "../../src/application/flow/run-journey.js";
import { locateRun, readRun } from "../../src/application/flow/run-state-service.js";
import { submitFlow } from "../../src/application/flow/submit.js";
import { PathsService } from "../../src/application/paths-service.js";
import { ALL_COMMANDS } from "../../src/cli/commands/index.js";
import {
  type FlowDecision,
  effectsOf,
  internalActionOf,
  proposalContractOf,
} from "../../src/domain/flow/authority.js";
import { effectApprovalDigest } from "../../src/domain/flow/authorization.js";
import type { FlowDirective } from "../../src/domain/flow/directive.js";
import { normalizeNamespace } from "../../src/runtime/namespace.js";
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
const SOURCE_PATH = "/tmp/acme";
const SPEC_DOC = "docs/specs/001-spec-medida.md";
const PLAN_DOC = "docs/plans/001-plan-medida.md";

const WORKSPACE_BLOCK = `<!-- AGENT-WORKFLOW-PROJECT-START -->
## Proyecto

Medida de llamadas.

## Fuentes

| Alias | Path | Rama principal |
|---|---|---|
| ${ALIAS} | ${SOURCE_PATH} | main |

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
 * git to what is measured.
 */
const EXEC_PLAN = PLAN.replaceAll(`${ALIAS}`, "workspace")
  .replace(
    "> Límite de ejecución: checkout",
    "> Standalone: medida de llamadas\n> Límite de ejecución: checkout",
  )
  .replace(/\n## Validations[\s\S]*$/, "\n");

/** The session each flow runs in, and the documents it starts from. */
const SESSIONS: Record<WorklineFlow, string> = {
  "spec-new": "001-medida-spec-new",
  "spec-refine": "001-medida-spec-refine",
  "plan-new": "001-medida-plan-new",
  "plan-refine": "001-medida-plan-refine",
  "plan-exec": "001-medida-plan-exec",
  quick: "001-medida-quick",
};

interface Run {
  code: string;
  paths: PathsService;
  executor: ReturnType<typeof testExecutor>;
}

/** `true` once `aw flow` offers the one-call opening. */
function offersStart(): boolean {
  const flow = ALL_COMMANDS.find((command) => command.name === "flow");
  return "start" in (flow?.flags.actions ?? {});
}

/**
 * Open a fresh run the way the CLI surface demands, and say what it cost.
 *
 * Without `flow start` the agent pays `session-create`, `context-plan` and
 * `flow advance --adopt`; the session is seeded here and the adoption runs for
 * real. A `start` verb is only credited by opening THROUGH it, so the day it
 * exists this function must call it instead of refusing.
 */
async function openRun(
  flow: WorklineFlow,
  run: Run,
): Promise<{ directive: FlowDirective; calls: number }> {
  if (offersStart()) {
    throw new Error("aw flow start existe: abrí la corrida con él antes de acreditarle 1 llamada");
  }
  const adopted = await advanceFlow(fs, run.paths, {
    code: run.code,
    flow,
    adopt: true,
    executor: run.executor,
  });
  if (!adopted.ok) throw new Error(`no se pudo abrir la corrida de ${flow}`);
  return { directive: adopted.directive, calls: 3 };
}

const fs = new (class extends NodeFileSystem {
  override async exists(path: string): Promise<boolean> {
    return path === SOURCE_PATH || super.exists(path);
  }
})();

async function seed(root: string, paths: PathsService, flow: WorklineFlow): Promise<void> {
  const session = join(paths.cwdSessionsDir(), SESSIONS[flow]);
  await mkdir(join(session, "scripts"), { recursive: true });
  await writeFile(
    join(session, "SESSION.md"),
    "# SESSION — medida\n\n## Objective\nrecorrer el flujo entero\n\n## Success criteria\n- [x] el tramo se recorre entero\n",
    "utf8",
  );
  await writeFile(join(session, "CHECKPOINT.md"), "# CHECKPOINT\n\nsembrado\n", "utf8");
  await writeFile(join(root, "CLAUDE.md"), WORKSPACE_BLOCK, "utf8");
  for (const dir of ["docs/specs", "docs/plans"]) await mkdir(join(root, dir), { recursive: true });
  await writeFile(join(root, SPEC_DOC), SPEC, "utf8");
  if (flow === "plan-refine") await writeFile(join(root, PLAN_DOC), PLAN, "utf8");
  if (flow === "plan-exec") await writeFile(join(root, PLAN_DOC), EXEC_PLAN, "utf8");
}

type Resolved = ReturnType<typeof resolveBoundary>;

/** The document bytes an authoring boundary delivers. */
function artifactFor(stopped: FlowDecision) {
  const destination = proposalContractOf(stopped)?.destinations[0] ?? "docs";
  return destination.includes("plans")
    ? { path: PLAN_DOC, content: PLAN }
    : { path: `${destination}/001-spec-medida.md`, content: SPEC };
}

/** A proof per eligible source: one per batch source at phase validation, the document's elsewhere. */
function proofsOf(stopped: FlowDecision, seal: string) {
  const batch = stopped.id === "plan-exec.validation-execution";
  return [
    {
      kind: "inspection" as const,
      source: "workspace",
      relative_cwd: ".",
      checkout_digest: batch ? `medida-${seal.slice(0, 16)}` : "medida",
      invocation: { artifact: "tests/helpers/agent-calls.ts" },
    },
  ];
}

/**
 * Whether the CLI captures the checkout proofs itself. `proofs_captured` is the
 * field F5 of plan 082 has to publish under `expects`; until then it is absent
 * and every proof is the agent's to bring.
 */
function proofsCaptured(directive: FlowDirective): boolean {
  return (directive.expects as { proofs_captured?: boolean }).proofs_captured === true;
}

function executionBody(
  resolved: Resolved,
  stopped: FlowDecision,
  captured: boolean,
): Record<string, unknown> {
  const action = resolved.action;
  if (action === null) throw new Error(`${stopped.id} no nombra ninguna acción`);
  const declared = resolved.proposal?.effects ?? effectsOf(stopped);
  const evidence = (id: string) => {
    if (id !== "workline.source-bounded")
      return [{ id, passed: true, detail: `salida real de ${id}` }];
    // A captured proof is left out, so a CLI that only claims to capture it fails the walk.
    return proofsOf(stopped, resolved.seal).map((proof) => ({
      id,
      passed: true,
      detail: `salida real de ${id}`,
      ...(captured ? {} : { proof }),
    }));
  };
  return {
    input_digest: resolved.seal,
    outcome: "completed",
    invocation: action.invocation,
    validations: action.evidence.flatMap(evidence),
    effects: { planned: [...declared], approved: [], applied: [...declared] },
    output: null,
  };
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

function bodyFor(resolved: Resolved, directive: FlowDirective): Record<string, unknown> {
  const stopped = resolved.stopped as FlowDecision;
  if (resolved.kind === "execution") {
    return executionBody(resolved, stopped, proofsCaptured(directive));
  }
  if (resolved.kind !== "semantic") {
    return { input_digest: resolved.seal, choice: resolved.choices[0]?.label ?? "" };
  }
  if (proposalContractOf(stopped) !== null) {
    return { input_digest: resolved.seal, artifacts: [artifactFor(stopped)] };
  }
  return { input_digest: resolved.seal, signals: [], decisions: decisionsFor(stopped) };
}

/** What answering this directive costs the agent, by kind of call. */
function priceOf(
  resolved: Resolved,
  directive: FlowDirective,
): { submits: number; commands: number; proves: number } {
  if (resolved.kind !== "execution") return { submits: 1, commands: 0, proves: 0 };
  const proofs = (resolved.action?.evidence ?? []).filter(
    (id) => id === "workline.source-bounded",
  ).length;
  return { submits: 1, commands: 1, proves: proofsCaptured(directive) ? 0 : proofs };
}

/** Answer the boundary in force once, as the agent would, and return what comes next. */
async function answer(
  flow: WorklineFlow,
  run: Run,
  resolved: Resolved,
  directive: FlowDirective,
  git: RecordingGit,
): Promise<FlowDirective> {
  const stopped = resolved.stopped as FlowDecision;
  const approval =
    resolved.kind === "authorization"
      ? effectApprovalDigest(stopped.id, resolved.authorization?.planned ?? [])
      : null;
  const result = await submitFlow(fs, run.paths, {
    code: run.code,
    raw: JSON.stringify(
      approval === null
        ? bodyFor(resolved, directive)
        : { input_digest: resolved.seal, choice: "Autorizar el efecto" },
    ),
    approval,
    executor: run.executor,
    // Freshness is not what is measured: git only reaches the row that reads it.
    ...(stopped.id === "plan-exec.batch-commit-proposal" ? { git } : {}),
  });
  if (!result.ok) throw new Error(`${flow}: ${JSON.stringify(result)}`);
  if (result.directive.error !== null && result.directive.boundary.transition === stopped.id) {
    throw new Error(`${flow} se trabó en ${stopped.id}: ${JSON.stringify(result.directive.error)}`);
  }
  return result.directive;
}

/** Walk one fresh run of `flow` to its end and price every stop. */
export async function countAgentCalls(flow: WorklineFlow): Promise<AgentCallCount> {
  const root = await mkdtemp(join(tmpdir(), `aw-calls-${flow}-`));
  const paths = new PathsService(normalizeNamespace("agent-workflow"), root, root);
  const git = new RecordingGit();
  const run: Run = {
    code: SESSIONS[flow].slice(0, 3),
    paths,
    executor: testExecutor(fs, paths, { git }),
  };
  try {
    await seed(root, paths, flow);
    const opened = await openRun(flow, run);
    const count: AgentCallCount = {
      flow,
      opening: opened.calls,
      submits: 0,
      commands: 0,
      proves: 0,
      total: 0,
      stops: [],
    };
    let directive = opened.directive;
    for (let step = 0; step < 200; step += 1) {
      const read = await readRun(fs, locateRun(paths, SESSIONS[flow]));
      if (!read.ok) throw new Error(`corrida ilegible: ${read.failure.code}`);
      const resolved = resolveBoundary(read.state, journeyForRun(read.state));
      if (resolved.stopped === null) break;
      if (resolved.kind !== "authorization" && internalActionOf(resolved.stopped) !== null) {
        const events = JSON.stringify(read.state.events.slice(-3));
        throw new Error(`${flow} quedó en la interna ${resolved.stopped.id}: ${events}`);
      }
      const price = priceOf(resolved, directive);
      count.stops.push({
        transition: resolved.stopped.id,
        kind: resolved.kind,
        calls: price.submits + price.commands + price.proves,
      });
      count.submits += price.submits;
      count.commands += price.commands;
      count.proves += price.proves;
      directive = await answer(flow, run, resolved, directive, git);
    }
    count.total = count.opening + count.submits + count.commands + count.proves;
    return count;
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
