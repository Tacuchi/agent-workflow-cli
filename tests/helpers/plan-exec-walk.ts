import { resolveBoundary } from "../../src/application/flow/advance.js";
import { advanceFlow } from "../../src/application/flow/flow-service.js";
import {
  type InternalActionExecutor,
  internalActionExecutor,
} from "../../src/application/flow/internal-actions.js";
import { locateRun, readRun } from "../../src/application/flow/run-state-service.js";
import { submitFlow } from "../../src/application/flow/submit.js";
import type { PathsService } from "../../src/application/paths-service.js";
import {
  type FlowDecision,
  effectsOf,
  internalActionOf,
  journeyForState,
  journeyOfFlow,
} from "../../src/domain/flow/authority.js";
import { effectApprovalDigest } from "../../src/domain/flow/authorization.js";
import type { EnvPort } from "../../src/ports/env.js";
import type { FileSystemPort } from "../../src/ports/file-system.js";
import type { GitPort } from "../../src/ports/git.js";
import { acceptAdaptiveRoute } from "./accept-adaptive-route.js";
import { batchReview } from "./batch-review.js";

/**
 * Drive a REAL `plan-exec` run over a real workspace, one boundary at a time.
 *
 * Shared by the phase proofs of plan 023, and shared on purpose: both walk the
 * same journey with the same executor, so two copies of this would be two
 * definitions of what "the run got here" means — and the day the journey gains a
 * row, the copy nobody updated would keep passing while proving less.
 *
 * Internal actions run for real (units are really created, the board is really
 * read): what the helper fabricates is only what an external executor would hand
 * back, which is the half no test can run.
 */

export interface WalkRun {
  code: string;
  folder: string;
  /** Workspace-relative plan-doc this run declares as its scope. */
  plan: string;
}

export interface WalkDeps {
  fs: FileSystemPort;
  env: EnvPort;
  git: GitPort;
  paths: PathsService;
}

export type WalkResolved = ReturnType<typeof resolveBoundary>;

/** How an external result comes back; `null` keeps the honest default. */
export interface WalkResultOverride {
  outcome?: "completed" | "needs_input" | "failed";
  completeness?: "partial" | "full";
}

export interface WalkOptions {
  /** Aliases the run declares as its scope — what it will hold a unit in. */
  sources: readonly string[];
  /**
   * Signals the run declares wherever it may, so conditioned rows really apply.
   *
   * Empty is a legitimate run — a batch with nothing to commit skips the commit —
   * but a test that wants to reach a conditioned row has to say so, because the
   * alternative is a walk that "reached" it by having it skipped.
   */
  signals?: readonly string[];
  /**
   * The agent answers `plan-exec.source-scope` itself instead of the CLI, so a
   * suite can send the malformed or mismatched scopes the validation refuses.
   */
  agentAnswersScope?: boolean;
}

/**
 * The proofs a source-bounded boundary gets: one per source of the batch at the
 * phase validation, the documentary one anywhere else.
 *
 * The walk passes no git reader, so freshness is not measured; what the digest
 * still has to be is distinct per boundary, because a batch whose proof already
 * credited another batch is refused whatever the checkout says.
 */
function proofsFor(
  resolved: WalkResolved,
  stopped: FlowDecision,
  sources: readonly string[],
): { source: string; digest: string }[] {
  const perBatch = stopped.id === "plan-exec.validation-execution";
  return (perBatch ? sources : ["workspace"]).map((source) => ({
    source,
    digest: perBatch ? `test-checkout-${source}-${resolved.seal.slice(0, 16)}` : "test-checkout",
  }));
}

/** What an external executor would hand back for the boundary in force. */
function resultFor(
  resolved: WalkResolved,
  stopped: FlowDecision,
  override: WalkResultOverride,
  sources: readonly string[],
): Record<string, unknown> {
  const action = resolved.action;
  if (action === null) throw new Error("esta frontera no nombra ninguna acción");
  return {
    input_digest: resolved.seal,
    outcome: override.outcome ?? "completed",
    invocation: action.invocation,
    validations: action.evidence.flatMap((id) =>
      id === "workline.source-bounded"
        ? proofsFor(resolved, stopped, sources).map((proof) => ({
            id,
            passed: true,
            detail: `salida real de ${id} en ${proof.source}`,
            proof: {
              kind: "inspection" as const,
              source: proof.source,
              relative_cwd: ".",
              checkout_digest: proof.digest,
              invocation: { artifact: "tests/helpers/plan-exec-walk.ts" },
            },
          }))
        : [{ id, passed: true, detail: `salida real de ${id}` }],
    ),
    effects: {
      planned: [...effectsOf(stopped)],
      approved: [],
      applied: [...effectsOf(stopped)],
    },
    output: override.completeness === undefined ? null : { completeness: override.completeness },
  };
}

export function planExecWalk(deps: WalkDeps, options: WalkOptions) {
  const { sources, signals = [], agentAnswersScope = false } = options;
  const EXEC = journeyOfFlow("plan-exec");

  function executor(): InternalActionExecutor {
    const real = internalActionExecutor({
      fs: deps.fs,
      env: deps.env,
      paths: deps.paths,
      git: deps.git,
    });
    if (!agentAnswersScope) return real;
    return async (plan, run) =>
      plan.operation === "cli-answer" && plan.answer === "plan-exec.scope"
        ? {
            ok: false,
            summary: "el agente contesta el scope en esta prueba",
            output: "",
            effects: [],
          }
        : real(plan, run);
  }

  async function current(folder: string) {
    const read = await readRun(deps.fs, locateRun(deps.paths, folder));
    if (!read.ok) throw new Error(`esperaba leer la corrida: ${read.failure.code}`);
    return {
      state: read.state,
      resolved: resolveBoundary(read.state, journeyForState(read.state)),
    };
  }

  function semanticDecisions(run: WalkRun, stopped: FlowDecision): Record<string, unknown> {
    return stopped.scopes_sources === true
      ? { plan: run.plan, sources: [...sources] }
      : stopped.answer_contract === "batch-review"
        ? { review: batchReview() }
        : stopped.id === "plan-exec.batch-commit-proposal"
          ? { messages: {} }
          : { paso: stopped.id };
  }

  /** Whatever the boundary in force admits — the run's own plan where it is asked. */
  function bodyFor(
    run: WalkRun,
    resolved: WalkResolved,
    override: WalkResultOverride = {},
  ): Record<string, unknown> {
    const stopped = resolved.stopped as FlowDecision;
    if (resolved.kind === "execution") return resultFor(resolved, stopped, override, sources);
    if (resolved.kind === "semantic") {
      // Only what THIS boundary declares: a signal offered where the row does not
      // admit it is a malformed answer, and it would burn one of the run's tries.
      const vocabulary = stopped.signals ?? [];
      return {
        input_digest: resolved.seal,
        signals: signals.filter((id) => vocabulary.includes(id)),
        decisions: semanticDecisions(run, stopped),
      };
    }
    return { input_digest: resolved.seal, choice: resolved.choices[0]?.label ?? "" };
  }

  /** Answer the boundary in force exactly once, with whatever it admits. */
  async function step(run: WalkRun, override: WalkResultOverride = {}) {
    const { resolved } = await current(run.folder);
    const approval =
      resolved.kind === "authorization"
        ? effectApprovalDigest(resolved.stopped?.id ?? "", resolved.authorization?.planned ?? [])
        : null;
    const result = await submitFlow(deps.fs, deps.paths, {
      code: run.code,
      raw: JSON.stringify(
        approval === null
          ? bodyFor(run, resolved, override)
          : { input_digest: resolved.seal, choice: "Autorizar el efecto" },
      ),
      approval,
      executor: executor(),
      ...(resolved.stopped?.id === "plan-exec.batch-commit-proposal" ? { git: deps.git } : {}),
    });
    if (!result.ok)
      throw new Error(`un rechazo de negocio viaja ok:true: ${JSON.stringify(result)}`);
    return result.directive;
  }

  /** Adopt and answer until the run stands on `id`. Internal actions run for real. */
  async function walkTo(run: WalkRun, id: string): Promise<void> {
    const adopted = await advanceFlow(deps.fs, deps.paths, {
      code: run.code,
      flow: "plan-exec",
      adopt: true,
      executor: executor(),
    });
    if (!adopted.ok) throw new Error(`esperaba adoptar ${run.folder}`);
    await acceptAdaptiveRoute(deps.fs, deps.paths, run.folder, {
      executor: executor(),
      git: deps.git,
    });
    let last: Awaited<ReturnType<typeof step>> | null = null;
    for (let attempt = 0; attempt < 160; attempt += 1) {
      const { state, resolved } = await current(run.folder);
      if (resolved.stopped === null || resolved.stopped.id === id) return;
      if (resolved.kind === "authorization") {
        last = await step(run);
        continue;
      }
      // The driver runs an internal row after every answer, so standing on one
      // means its operation refused: answering it would only be rejected, and the
      // cause worth reporting is the refusal the run traced.
      if (internalActionOf(resolved.stopped) !== null) {
        const refused = [...state.events].reverse().find((event) => event.kind === "failed");
        throw new Error(
          `${run.folder} nunca llegó a '${id}': la acción interna '${resolved.stopped.id}' no se completó: ${JSON.stringify(refused ?? null)}`,
        );
      }
      last = await step(run);
    }
    throw new Error(
      `${run.folder} nunca llegó a '${id}': quedó en '${last?.boundary.transition}' con ${JSON.stringify(last?.error)}`,
    );
  }

  return { EXEC, executor, current, bodyFor, step, walkTo };
}
