/**
 * The command's half: find the session, take the run's lock, advance, persist.
 *
 * Everything decision-shaped lives in the engine and the registry; what is here
 * is the plumbing that makes the advance atomic and addressable — which session,
 * which state, one write.
 */

import type { CapabilityFailure } from "../../domain/capability/protocol.js";
import { journeyOfFlow } from "../../domain/flow/authority.js";
import type { FlowDirective } from "../../domain/flow/directive.js";
import {
  type FlowRunState,
  MAX_BOUNDARY_ATTEMPTS,
  type RecoveryBlocker,
  attemptAccountingAt,
  checkAgainstJourney,
  grantAttempts,
  newRunState,
  normalizeAttemptChain,
  recoveryBlockedAt,
} from "../../domain/flow/run-state.js";
import type { FileSystemPort } from "../../ports/file-system.js";
import type { GitPort } from "../../ports/git.js";
import { WORKLINE_FLOWS, type WorklineFlow } from "../capability/compose.js";
import { resolveCoreDocsCanon } from "../docs-canon-service.js";
import type { PathsService } from "../paths-service.js";
import { recordFlowAdoption } from "../session-custody-recorder.js";
import { type SessionResolutionError, resolveSessionTarget } from "../session-resolver.js";
import { advanceFlowRun, directiveFor, resolveBoundary } from "./advance.js";
import { publishObservedCheckouts } from "./checkout-observation.js";
import type { InternalActionExecutor } from "./internal-actions.js";
import { driveInternalActions } from "./internal-drive.js";
import { type FlowRunMutation, applyUnderLock, locateRun } from "./run-state-service.js";

export interface AdvanceFlowInput {
  code?: string;
  contextId?: string;
  /**
   * Reader used ONLY to verify the roots the directive publishes.
   *
   * Optional because a pure caller has none, and its absence is a real answer: the
   * directive then names no root at all rather than one nobody checked.
   */
  git?: GitPort;
  /** Required only to adopt a session that has no run state yet. */
  flow?: string;
  /** Initialize the run state of a legacy session instead of refusing. */
  adopt: boolean;
  /**
   * How this process materializes the actions the registry classifies internal.
   *
   * Optional because not every caller can supply one, and the absence is a real
   * answer rather than a hole: without it an internal action is emitted as the
   * boundary it always was, with its invocation, and nothing is credited. See
   * {@link driveInternalActions}.
   */
  executor?: InternalActionExecutor;
}

export type AdvanceFlowResult =
  | { ok: true; directive: FlowDirective }
  | { ok: false; failure: CapabilityFailure }
  | { ok: false; session: SessionResolutionError };

export async function advanceFlow(
  fs: FileSystemPort,
  paths: PathsService,
  input: AdvanceFlowInput,
): Promise<AdvanceFlowResult> {
  const canon = await resolveCoreDocsCanon(fs, paths);
  if (!canon.ok) {
    return {
      ok: false,
      failure: {
        code: "DOCS_CANON_INVALID",
        message: canon.error,
        action: "corregí [docs] para conservar el layout documental canónico antes de avanzar",
      },
    };
  }
  // A write path: a closed line is never advanced by accident, and nothing is
  // chosen by recency — several active sessions with no association is ambiguous.
  const resolution = await resolveSessionTarget(fs, paths, {
    intent: "write",
    ...(input.code !== undefined ? { code: input.code } : {}),
    ...(input.contextId !== undefined ? { contextId: input.contextId } : {}),
    allowClosed: false,
    bind: true,
  });
  if (resolution.outcome !== "resolved") return { ok: false, session: resolution };

  const session = resolution.session.folder;
  const location = locateRun(paths, session);
  // Read BEFORE the advance: afterwards the state file always exists, so this is
  // the only moment that can tell an adoption from an ordinary advance.
  const adopting = input.adopt && !(await fs.exists(location.statePath));

  const applied = await applyUnderLock<FlowDirective>(
    fs,
    location,
    (current) => {
      const seeded = current ?? seed(input, session);
      if ("failure" in seeded) return { ok: false, failure: seeded.failure };
      const advance = advanceFlowRun({
        state: seeded,
        journey: journeyOfFlow(seeded.flow),
      });
      if (!advance.ok) return { ok: false, failure: advance.failure };
      return { ok: true, state: advance.state, value: advance.directive };
    },
    { allowAbsent: input.adopt },
  );

  if (!applied.ok) return { ok: false, failure: applied.failure };
  // What the session IS, recorded once, from the adoption that really happened.
  if (adopting) await recordFlowAdoption({ fs, paths }, session, applied.state.flow);
  // Deciding stopped at the first delegated step; executing continues past every
  // one of them this process owns. Two calls and not one loop, because the walk is
  // pure and the execution is not.
  const driven = await driveInternalActions(fs, location, input.executor, {
    ok: true,
    state: applied.state,
    value: applied.value,
  });
  if (!driven.ok) return { ok: false, failure: driven.failure };
  // After the lock, so the walk stays pure and the seal is long computed. The roots
  // are VERIFIED before being published, exactly as `submit` verifies its own.
  return {
    ok: true,
    directive: await publishObservedCheckouts(fs, paths, session, input.git, driven.value),
  };
}

export interface RecoverFlowInput {
  code?: string;
  contextId?: string;
  /** Reader used ONLY to verify the roots the directive publishes. See above. */
  git?: GitPort;
  /**
   * The boundary the caller believes is stuck — a CONFIRMATION, never a selector.
   *
   * Recovery always acts on the boundary in force: the run cannot be standing
   * anywhere else, and forgiving attempts at a transition it already passed would
   * be rewriting history rather than unblocking anything. What naming it buys is
   * that somebody who read the id in an error and pasted it back finds out when
   * the run has since moved, instead of recovering something they did not mean.
   */
  transition?: string;
}

/**
 * Give a boundary that ran out of attempts a way back to being answerable.
 *
 * The only supported exit from an exhausted boundary, and it exists because the
 * alternative in the field was surgery on `.flow-run.json` — which the seal
 * refuses when you edit it and ACCEPTS when you restore an older copy, so the
 * only manual "fix" that worked was also the one that rolled the run back.
 *
 * What it does is deliberately narrow: it forgives the attempts spent at the
 * boundary in force and nothing else. The cursor, the effect ledger, the
 * authorizations, the seated proposal, the trace and every document and artifact
 * of the session are untouched — recovering is not restarting, and a run that
 * came back with its applied transitions rolled back would be a worse outcome
 * than the block it replaces.
 */
export async function recoverFlowBoundary(
  fs: FileSystemPort,
  paths: PathsService,
  input: RecoverFlowInput,
): Promise<AdvanceFlowResult> {
  const canon = await resolveCoreDocsCanon(fs, paths);
  if (!canon.ok) {
    return {
      ok: false,
      failure: {
        code: "DOCS_CANON_INVALID",
        message: canon.error,
        action: "corregí [docs] para conservar el layout documental canónico antes de recuperar",
      },
    };
  }
  const resolution = await resolveSessionTarget(fs, paths, {
    intent: "write",
    ...(input.code !== undefined ? { code: input.code } : {}),
    ...(input.contextId !== undefined ? { contextId: input.contextId } : {}),
    allowClosed: false,
    bind: true,
  });
  if (resolution.outcome !== "resolved") return { ok: false, session: resolution };

  const location = locateRun(paths, resolution.session.folder);
  const applied = await applyUnderLock<FlowDirective>(fs, location, (current) => {
    if (current === null) {
      return {
        ok: false,
        failure: {
          code: "FLOW_RUN_ABSENT",
          message: "no hay corrida que recuperar en esta sesión",
          action: "adoptala primero con 'aw flow advance --flow <flow> --adopt'",
        },
      };
    }
    return recover(current, input.transition ?? null);
  });
  if (!applied.ok) return { ok: false, failure: applied.failure };
  return {
    ok: true,
    directive: await publishObservedCheckouts(
      fs,
      paths,
      resolution.session.folder,
      input.git,
      applied.value,
    ),
  };
}

/**
 * The recovery decision, pure over the state read under the lock.
 *
 * Two refusals and one grant. It does NOT advance afterwards: returning
 * answerability is the whole operation, and walking on from here would mean a
 * command whose job is to unblock could also apply transitions — including,
 * where the boundary is a delegated one, re-running the very action that failed.
 */
function recover(state: FlowRunState, named: string | null): FlowRunMutation<FlowDirective> {
  const journey = journeyOfFlow(state.flow);
  const incoherent = checkAgainstJourney(state, journey);
  if (incoherent !== null) return { ok: false, failure: incoherent };

  const stopped = resolveBoundary(state, journey).stopped;
  if (stopped === null) {
    return refuse(
      "FLOW_RECOVERY_NOT_NEEDED",
      "el recorrido ya terminó: no hay ninguna frontera trabada",
      "no queda trabajo pendiente en este recorrido",
    );
  }
  if (named !== null && named !== stopped.id) {
    return refuse(
      "FLOW_RECOVERY_OTHER_BOUNDARY",
      `la corrida está detenida en '${stopped.id}' y se pidió recuperar '${named}'`,
      `se recupera la frontera vigente: volvé a invocar sin --transition, o con --transition ${stopped.id}`,
    );
  }
  const accounting = attemptAccountingAt(state, stopped.id);
  const spent = accounting.spent;
  // TWO ways in, and the second one is why this verb exists at all. Exhaustion is
  // the boundary the run walked into legitimately. The other is a boundary that
  // still has budget on paper and cannot be answered anyway, because its own rows
  // will not yield the next ordinal — and refusing that one for `spent < MAX` is
  // exactly what left editing the ledger by hand as the only way out.
  if (spent < MAX_BOUNDARY_ATTEMPTS && accounting.unanswerable === null) {
    return refuse(
      "FLOW_RECOVERY_NOT_NEEDED",
      `'${stopped.id}' gastó ${spent} de ${MAX_BOUNDARY_ATTEMPTS} intentos y su contabilidad es coherente (filas ${accounting.rows}, piso ${accounting.floor}, grants ${accounting.granted}, disponibles ${accounting.available}): todavía se contesta`,
      "respondé la frontera vigente con 'aw flow submit': recuperar no es una forma de saltearla",
    );
  }
  // The guard, and it reads the material trace rather than the effect ledger: the
  // ledger is run-wide and cannot say WHICH boundary applied what. Handing back an
  // answerable boundary whose action already reached the world would invite a
  // second answer on top of a half-applied one — and no attempt is worth that.
  const blocked = recoveryBlockedAt(state, stopped.id);
  if (blocked !== null) return refuseRecovery(stopped.id, blocked);

  // The grant gives the budget back. The chain relabel is what makes the boundary
  // ANSWERABLE when the rows were the problem: handing back three attempts over a
  // ledger that still refuses the ordinal would be a recovery that reports success
  // and changes nothing. Coherent accounting is left exactly as it is.
  const granted = grantAttempts(state, stopped.id, spent);
  const recovered = accounting.unanswerable === null ? granted : normalizeAttemptChain(granted);
  const built = directiveFor(recovered, resolveBoundary(recovered, journey), []);
  if (!built.ok) return { ok: false, failure: built.failure };
  return { ok: true, state: built.state, value: built.directive };
}

/**
 * The two ways a boundary refuses to be handed back, said as what to do next.
 *
 * They are not the same dead end and must not read as one. A boundary that
 * APPLIED something is over: the run has to be repaired outside itself, because
 * a second answer would land on top of an effect that already happened. A
 * boundary whose action was begun and never reported back is the opposite — the
 * missing thing is the verdict, and running the advance produces it.
 */
function refuseRecovery(
  transition: string,
  blocked: RecoveryBlocker,
): FlowRunMutation<FlowDirective> {
  if (blocked.reason === "unverified") {
    return refuse(
      "FLOW_RECOVERY_EXECUTION_UNVERIFIED",
      `'${transition}' dejó anotado que su acción se iba a ejecutar y nunca registró en qué terminó: nadie puede decir si tocó el mundo`,
      "no se devuelven intentos sobre una ejecución sin veredicto: corré 'aw flow advance' para que la acción vuelva a correr y deje su resultado, y recuperá después si hace falta",
    );
  }
  const moved = blocked.event;
  return refuse(
    "FLOW_RECOVERY_EFFECTS_APPLIED",
    `'${transition}' ya ejerció efectos en esta corrida (${moved.operation}): no se devuelven intentos sobre algo que ya ocurrió`,
    `el estado queda igual: seguí la recuperación que declara la acción de la fila, o llevá el gap a '## Open questions' — ${
      moved.kind === "failed" ? moved.recovery : "revisá la traza de la corrida"
    }`,
  );
}

function refuse(code: string, message: string, action: string): FlowRunMutation<FlowDirective> {
  return { ok: false, failure: { code, message, action } };
}

/**
 * The state a legacy session gets when it is adopted.
 *
 * Adoption needs the flow named explicitly: guessing it from the folder suffix
 * would make the CLI infer the one thing the whole run hangs off, and a wrong
 * guess would walk the wrong journey.
 */
function seed(
  input: AdvanceFlowInput,
  session: string,
): FlowRunState | { failure: CapabilityFailure } {
  const flow = input.flow;
  if (flow === undefined || !(WORKLINE_FLOWS as readonly string[]).includes(flow)) {
    return {
      failure: {
        code: "FLOW_ADOPTION_FLOW_MISSING",
        message:
          flow === undefined
            ? "adoptar una sesión legacy exige nombrar su flow"
            : `'${flow}' no es un flow de Workline`,
        action: `pasá --flow con uno de: ${WORKLINE_FLOWS.join(", ")}`,
      },
    };
  }
  return newRunState(flow as WorklineFlow, session);
}
