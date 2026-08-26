import { resolveBoundary } from "../../src/application/flow/advance.js";
import { advanceFlow } from "../../src/application/flow/flow-service.js";
import { internalActionExecutor } from "../../src/application/flow/internal-actions.js";
import { locateRun, readRun } from "../../src/application/flow/run-state-service.js";
import { submitFlow } from "../../src/application/flow/submit.js";
import type { PathsService } from "../../src/application/paths-service.js";
import {
  type FlowDecision,
  effectsOf,
  journeyForState,
  journeyOfFlow,
} from "../../src/domain/flow/authority.js";
import { effectApprovalDigest } from "../../src/domain/flow/authorization.js";
import type { EnvPort } from "../../src/ports/env.js";
import type { FileSystemPort } from "../../src/ports/file-system.js";
import type { GitPort } from "../../src/ports/git.js";

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
}

/** What an external executor would hand back for the boundary in force. */
function resultFor(
  resolved: WalkResolved,
  stopped: FlowDecision,
  override: WalkResultOverride,
): Record<string, unknown> {
  const action = resolved.action;
  if (action === null) throw new Error("esta frontera no nombra ninguna acción");
  return {
    input_digest: resolved.seal,
    outcome: override.outcome ?? "completed",
    invocation: action.invocation,
    validations: action.evidence.map((id) => ({
      id,
      passed: true,
      detail: `salida real de ${id}`,
      ...(id === "workline.source-bounded"
        ? {
            proof: {
              kind: "inspection" as const,
              source: "workspace",
              relative_cwd: ".",
              checkout_digest: "test-checkout",
              invocation: { artifact: "tests/helpers/plan-exec-walk.ts" },
            },
          }
        : {}),
    })),
    effects: {
      planned: [...effectsOf(stopped)],
      approved: [],
      applied: [...effectsOf(stopped)],
    },
    output: override.completeness === undefined ? null : { completeness: override.completeness },
  };
}

export function planExecWalk(deps: WalkDeps, options: WalkOptions) {
  const { sources, signals = [] } = options;
  const EXEC = journeyOfFlow("plan-exec");

  function executor() {
    return internalActionExecutor({
      fs: deps.fs,
      env: deps.env,
      paths: deps.paths,
      git: deps.git,
    });
  }

  async function current(folder: string) {
    const read = await readRun(deps.fs, locateRun(deps.paths, folder));
    if (!read.ok) throw new Error(`esperaba leer la corrida: ${read.failure.code}`);
    return {
      state: read.state,
      resolved: resolveBoundary(read.state, journeyForState(read.state)),
    };
  }

  /** Whatever the boundary in force admits — the run's own plan where it is asked. */
  function bodyFor(
    run: WalkRun,
    resolved: WalkResolved,
    override: WalkResultOverride = {},
  ): Record<string, unknown> {
    const stopped = resolved.stopped as FlowDecision;
    if (resolved.kind === "execution") return resultFor(resolved, stopped, override);
    if (resolved.kind === "semantic") {
      // Only what THIS boundary declares: a signal offered where the row does not
      // admit it is a malformed answer, and it would burn one of the run's tries.
      const vocabulary = stopped.signals ?? [];
      return {
        input_digest: resolved.seal,
        signals: signals.filter((id) => vocabulary.includes(id)),
        decisions:
          stopped.scopes_sources === true
            ? { plan: run.plan, sources: [...sources] }
            : { paso: stopped.id },
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
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const { resolved } = await current(run.folder);
      if (resolved.stopped === null || resolved.stopped.id === id) return;
      await step(run);
    }
    throw new Error(`${run.folder} nunca llegó a '${id}'`);
  }

  return { EXEC, executor, current, bodyFor, step, walkTo };
}
