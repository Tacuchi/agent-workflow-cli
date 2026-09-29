/**
 * The command's half: find the session, take the run's lock, advance, persist.
 *
 * Everything decision-shaped lives in the engine and the registry; what is here
 * is the plumbing that makes the advance atomic and addressable — which session,
 * which state, one write.
 */

import type { CapabilityFailure } from "../../domain/capability/protocol.js";
import type { FlowDirective } from "../../domain/flow/directive.js";
import {
  type FlowRunEvent,
  type FlowRunState,
  MAX_BOUNDARY_ATTEMPTS,
  type RecoveryBlocker,
  applyAttemptReconciliation,
  attemptAccountingAt,
  checkAgainstJourney,
  grantAttempts,
  inheritedBasesFrom,
  legacyRunNeedsAdoption,
  newRunState,
  normalizeAttemptChain,
  reconcileAttemptsAt,
  recoveryBlockedAt,
  restartInvocation,
  retractSignal,
  withEvent,
  withInheritedBases,
  withQuickCheckouts,
  withoutExhaustedRerun,
} from "../../domain/flow/run-state.js";
import type { FileSystemPort } from "../../ports/file-system.js";
import type { GitPort } from "../../ports/git.js";
import { WORKLINE_FLOWS, type WorklineFlow } from "../capability/compose.js";
import { resolveCoreDocsCanon } from "../docs-canon-service.js";
import type { PathsService } from "../paths-service.js";
import { recordFlowAdoption, recordFlowRestart } from "../session-custody-recorder.js";
import { readCustody } from "../session-custody-service.js";
import { type SessionResolutionError, resolveSessionTarget } from "../session-resolver.js";
import { advanceFlowRun, directiveFor, resolveBoundary } from "./advance.js";
import { publishObservedCheckouts } from "./checkout-observation.js";
import { adoptionCommand } from "./flow-descriptor.js";
import type { InternalActionExecutor } from "./internal-actions.js";
import { driveInternalActions } from "./internal-drive.js";
import { observeQuickCheckouts } from "./quick-checkouts.js";
import { journeyForRun } from "./run-journey.js";
import {
  type FlowRunLocation,
  type FlowRunMutation,
  applyUnderLock,
  locateRun,
  readRun,
  restartUnderLock,
} from "./run-state-service.js";

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
   * Required: an internal action is credited only by the process that ran it, so
   * a caller without one would leave the run standing on a boundary nobody may
   * answer. See {@link driveInternalActions}.
   */
  executor: InternalActionExecutor;
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
  const target = {
    intent: "write" as const,
    ...(input.code !== undefined ? { code: input.code } : {}),
    ...(input.contextId !== undefined ? { contextId: input.contextId } : {}),
  };
  let resolution = await resolveSessionTarget(fs, paths, {
    ...target,
    allowClosed: false,
    bind: true,
  });
  if (resolution.outcome === "error" && resolution.code === "SESSION_CLOSED") {
    resolution = await closedOnItsOwnFinalize(fs, paths, target, resolution);
  }
  if (resolution.outcome !== "resolved") return { ok: false, session: resolution };

  const session = resolution.session.folder;
  const location = locateRun(paths, session);
  // Read BEFORE the advance: afterwards the state file always exists, so this is
  // the only moment that can tell an adoption from an ordinary advance.
  const adopting = input.adopt && !(await fs.exists(location.statePath));
  const quickCheckouts = await observeQuickCheckouts(fs, paths, session, input.git);

  const applied = await applyUnderLock<FlowDirective>(
    fs,
    location,
    (current) => {
      // A readable run older than v11 never reaches here: the lock refuses it and
      // names `aw flow restart`. Continuing its cursor would invent batch limits
      // the old run never declared.
      const seeded = current === null ? seed(input, session) : current;
      if ("failure" in seeded) return { ok: false, failure: seeded.failure };
      // A `--flow` that names another flow than the run's is refused, never
      // ignored: since session-create seeds the run, the first advance is exactly
      // where somebody still passes `--flow … --adopt` by habit.
      if (current !== null && input.flow !== undefined && input.flow !== current.flow) {
        return {
          ok: false,
          failure: {
            code: "FLOW_ADOPTION_FLOW_MISMATCH",
            message: `la corrida declara '${current.flow}', no '${input.flow}'`,
            action: `avanzala sin --flow, o con '--flow ${current.flow}', o elegí la sesión correcta`,
          },
        };
      }
      const advance = advanceFlowRun({
        state: withQuickCheckouts(seeded, quickCheckouts),
        journey: journeyForRun(seeded),
      });
      if (!advance.ok) return { ok: false, failure: advance.failure };
      return { ok: true, state: advance.state, value: advance.directive };
    },
    { allowAbsent: input.adopt },
  );

  if (!applied.ok) return { ok: false, failure: applied.failure };
  // What the session IS, recorded once, from the adoption that really happened.
  if (adopting) {
    await recordFlowAdoption({ fs, paths }, session, applied.state.flow);
  }
  // Deciding stopped at the first delegated step; executing continues past every
  // one of them this process owns. Two calls and not one loop, because the walk is
  // pure and the execution is not.
  const driven = await driveInternalActions(
    fs,
    location,
    input.executor,
    {
      ok: true,
      state: applied.state,
      value: applied.value,
    },
    paths,
  );
  if (!driven.ok) return { ok: false, failure: driven.failure };
  // After the lock, so the walk stays pure and the seal is long computed. The roots
  // are VERIFIED before being published, exactly as `submit` verifies its own.
  return {
    ok: true,
    directive: await publishObservedCheckouts(fs, paths, session, input.git, driven.value),
  };
}

/**
 * A closed session whose run still stands on `chassis.finalize` — or the refusal.
 *
 * That is the close that happened and whose run write did not: `session.close`
 * already wrote the marker and the HISTORY row, and only the cursor stayed
 * behind. Reopening it, which is what the refusal asks for, would undo the one
 * effect that did land. So this one shape resolves, the driver re-runs the close
 * — which recognizes a closed session — and the run finishes. Any other closed
 * session keeps its refusal: a line somebody closed is never advanced by accident.
 */
async function closedOnItsOwnFinalize(
  fs: FileSystemPort,
  paths: PathsService,
  target: { intent: "write"; code?: string; contextId?: string },
  refused: SessionResolutionError,
): Promise<Awaited<ReturnType<typeof resolveSessionTarget>>> {
  const closed = await resolveSessionTarget(fs, paths, { ...target, allowClosed: true });
  if (closed.outcome !== "resolved") return refused;
  const run = await readRun(fs, locateRun(paths, closed.session.folder));
  // A run this CLI cannot continue is not finished by resolving it: its way out
  // is `aw flow restart`, which needs the session open — so the reopen the
  // refusal names comes first, instead of two refusals naming each other.
  if (!run.ok || legacyRunNeedsAdoption(run.state)) return refused;
  const standing = journeyForRun(run.state)[run.state.applied.length]?.id;
  return standing === "chassis.finalize" ? closed : refused;
}

export interface RestartFlowInput {
  code?: string;
  contextId?: string;
  /** Reader used ONLY to verify the roots the directive publishes. */
  git?: GitPort;
  /** The flow to re-adopt, needed only when neither the registry nor custody says it. */
  flow?: string;
  executor: InternalActionExecutor;
  /** The archive's timestamp; injectable so a test can name the file it expects. */
  now?: Date;
}

/**
 * The way out of any stuck run, without touching `.flow-run.json` by hand.
 *
 * Under the run's lock it archives the registry and its attempt counter into a
 * dated, sealed file inside the session, seeds a new run of the same flow whose
 * first trace event names that archive and the cause, and records both in the
 * session's custody. Then it advances the new run like any adoption. What it
 * costs is the old run's answers — kept in the archive, never deleted — and in
 * plan-exec the new run re-infers from the plan, so nothing validated is redone.
 *
 * The flow comes from the registry, then from custody's `flow_adopted`, then
 * from `--flow`: what is already on record is never asked again, and a `--flow`
 * that contradicts the record is refused before anything is archived.
 */
export async function restartFlow(
  fs: FileSystemPort,
  paths: PathsService,
  input: RestartFlowInput,
): Promise<AdvanceFlowResult> {
  const target = await writableSession(fs, paths, input, "reiniciar");
  if (!target.ok) return target.result;
  return reseat(fs, paths, target.session, input, {
    cause: (location) => restartCause(fs, location),
    events: () => [],
  });
}

/** The session a run-replacing verb acts on: canon checked, open, bound. */
export async function writableSession(
  fs: FileSystemPort,
  paths: PathsService,
  input: { code?: string; contextId?: string },
  verb: string,
  bind = true,
): Promise<
  { ok: true; session: { folder: string; path: string } } | { ok: false; result: AdvanceFlowResult }
> {
  const canon = await resolveCoreDocsCanon(fs, paths);
  if (!canon.ok) {
    return {
      ok: false,
      result: {
        ok: false,
        failure: {
          code: "DOCS_CANON_INVALID",
          message: canon.error,
          action: `corregí [docs] para conservar el layout documental canónico antes de ${verb}`,
        },
      },
    };
  }
  const resolution = await resolveSessionTarget(fs, paths, {
    intent: "write",
    ...(input.code !== undefined ? { code: input.code } : {}),
    ...(input.contextId !== undefined ? { contextId: input.contextId } : {}),
    allowClosed: false,
    bind,
  });
  if (resolution.outcome !== "resolved") {
    return { ok: false, result: { ok: false, session: resolution } };
  }
  return { ok: true, session: resolution.session };
}

/**
 * Archive the run, seed a new one of the same flow and advance it — the exit
 * `restart` and `annul` share. The new run's first event is `restarted`; `events`
 * adds what the verb itself has to say right after it.
 */
export async function reseat(
  fs: FileSystemPort,
  paths: PathsService,
  session: { folder: string; path: string },
  input: RestartFlowInput,
  verb: {
    cause: (location: FlowRunLocation) => Promise<string>;
    events: () => FlowRunEvent[];
  },
): Promise<AdvanceFlowResult> {
  const location = locateRun(paths, session.folder);
  const recorded = await adoptedFlowOf(fs, session.path);
  const restarted = await restartUnderLock(
    fs,
    location,
    () => verb.cause(location),
    (cause, archived) => {
      const flow = flowToReadopt(archived.state, recorded, input.flow);
      if ("failure" in flow) return { ok: false, failure: flow.failure };
      const seeded = withEvent(newRunState(flow.flow, session.folder), {
        kind: "restarted",
        transition: RESTART_OPERATION,
        operation: RESTART_OPERATION,
        archive: archived.path,
        cause,
      });
      const traced = verb.events().reduce(withEvent, seeded);
      return { ok: true, state: withInheritedBases(traced, inheritedBasesFrom(archived.state)) };
    },
    input.now === undefined ? {} : { at: input.now },
  );
  if (!restarted.ok) return { ok: false, failure: restarted.failure };
  await recordFlowRestart({ fs, paths }, session.folder, restarted.archive.path);
  await recordFlowAdoption({ fs, paths }, session.folder, restarted.state.flow);
  return advanceFlow(fs, paths, {
    code: session.folder,
    adopt: false,
    ...(input.git === undefined ? {} : { git: input.git }),
    executor: input.executor,
  });
}

const RESTART_OPERATION = "flow.restart";

/**
 * Why the old run could not go on, as `CODE: message` — what the trace keeps.
 *
 * Read with the same functions every other verb reads through, so the cause is
 * the refusal the person was looking at, not a reinterpretation of it.
 */
async function restartCause(fs: FileSystemPort, location: FlowRunLocation): Promise<string> {
  const read = await readRun(fs, location);
  if (!read.ok) return `${read.failure.code}: ${read.failure.message}`;
  const journey = journeyForRun(read.state);
  const incoherent = checkAgainstJourney(read.state, journey);
  if (incoherent !== null) return `${incoherent.code}: ${incoherent.message}`;
  if (legacyRunNeedsAdoption(read.state)) {
    return `FLOW_RUN_LEGACY_ADOPTION_REQUIRED: la corrida v${read.state.version} no se continúa`;
  }
  const error = resolveBoundary(read.state, journey).error;
  return error === null
    ? "FLOW_RESTART_REQUESTED: reinicio pedido"
    : `${error.code}: ${error.message}`;
}

/** The flow custody recorded the last time this session adopted one, if any. */
async function adoptedFlowOf(fs: FileSystemPort, sessionPath: string): Promise<string | null> {
  const read = await readCustody(fs, sessionPath);
  if (read.status !== "present") return null;
  const adopted = read.custody.effects.filter((effect) => effect.kind === "flow_adopted");
  return adopted.at(-1)?.paths[0] ?? null;
}

/** Registry, then custody, then `--flow` — and a `--flow` that contradicts them is refused. */
function flowToReadopt(
  archivedState: string | null,
  recorded: string | null,
  requested: string | undefined,
): { flow: WorklineFlow } | { failure: CapabilityFailure } {
  const known = (value: unknown): value is WorklineFlow =>
    (WORKLINE_FLOWS as readonly unknown[]).includes(value);
  const declared = flowDeclaredBy(archivedState);
  const onRecord = known(declared) ? declared : known(recorded) ? recorded : null;
  if (onRecord !== null && requested !== undefined && requested !== onRecord) {
    return {
      failure: {
        code: "FLOW_ADOPTION_FLOW_MISMATCH",
        message: `la corrida declara '${onRecord}', no '${requested}'`,
        action: `reiniciala sin --flow, o con '--flow ${onRecord}', o elegí la sesión correcta`,
      },
    };
  }
  if (onRecord !== null) return { flow: onRecord };
  if (known(requested)) return { flow: requested };
  return {
    failure: {
      code: "FLOW_ADOPTION_FLOW_MISSING",
      message: "ni el registro ni la custodia dicen qué flow corría esta sesión",
      action: `pasá --flow con uno de: ${WORKLINE_FLOWS.join(", ")}`,
    },
  };
}

/** The `flow` an archived registry names, even when the rest of it cannot be read. */
function flowDeclaredBy(archivedState: string | null): unknown {
  if (archivedState === null) return null;
  try {
    const parsed: unknown = JSON.parse(archivedState);
    return typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>).flow
      : null;
  } catch {
    return null;
  }
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

/** Retraction changes observations, never the cursor, attempts or effect ledger. */
export async function retractFlowSignal(
  fs: FileSystemPort,
  paths: PathsService,
  input: { code?: string; contextId?: string; signal: string; git?: GitPort },
): Promise<AdvanceFlowResult> {
  const resolution = await resolveSessionTarget(fs, paths, {
    intent: "write",
    allowClosed: false,
    bind: true,
    ...(input.code === undefined ? {} : { code: input.code }),
    ...(input.contextId === undefined ? {} : { contextId: input.contextId }),
  });
  if (resolution.outcome !== "resolved") return { ok: false, session: resolution };
  const session = resolution.session.folder;
  const applied = await applyUnderLock<FlowDirective>(fs, locateRun(paths, session), (state) => {
    if (state === null)
      return refuse(
        "FLOW_RUN_ABSENT",
        "no hay corrida para retirar la señal",
        "adoptá primero la corrida con aw flow advance",
      );
    const journey = journeyForRun(state);
    const incoherent = checkAgainstJourney(state, journey);
    if (incoherent !== null) return { ok: false, failure: incoherent };
    const retracted = retractSignal(state, journey, input.signal);
    if (!retracted.ok) return retracted;
    const built = directiveFor(retracted.state, resolveBoundary(retracted.state, journey), [], {
      nextAction: `se retiró '${input.signal}'; continuá con aw flow advance --session ${session}`,
    });
    if (!built.ok) return built;
    return {
      ok: true,
      state: built.state,
      value: built.directive,
      persist: retracted.state !== state,
    };
  });
  if (!applied.ok) return applied;
  return {
    ok: true,
    directive: await publishObservedCheckouts(fs, paths, session, input.git, applied.value),
  };
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
          action: `adoptala primero con '${adoptionCommand(resolution.session.folder)}'`,
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
  const journey = journeyForRun(state);
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
  if (blocked !== null) return refuseRecovery(state.session, stopped.id, blocked);

  // The SAME reconciliation the advance applies on its own, over the same input
  // and through the same function: two copies of this arithmetic is exactly how
  // the verb and the automatic repair would end up disagreeing about one run. It
  // is a no-op when the accounting is coherent, which is the ordinary exhaustion
  // case, and it leaves its own line in the trace when it is not.
  const reconciled = applyAttemptReconciliation(state, reconcileAttemptsAt(state, stopped.id));
  // What the VERB adds is the half a person asked for out loud: giving the spend
  // back to a boundary that reached its cap legitimately — which the automatic
  // path never does, because reaching the cap is not a mismatch — and relabelling
  // a chain the reconciliation refused for repeating an ordinal. The totals do not
  // move: what the reconciliation already forgave is subtracted from the spend
  // this grant covers, so nothing is forgiven twice.
  const pending = attemptAccountingAt(reconciled, stopped.id);
  const granted =
    pending.spent > 0 ? grantAttempts(reconciled, stopped.id, pending.spent) : reconciled;
  const renumbered =
    attemptAccountingAt(granted, stopped.id).unanswerable === null
      ? granted
      : normalizeAttemptChain(granted);
  const recovered = withoutExhaustedRerun(renumbered, stopped.id);
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
  session: string,
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
    `el estado queda igual. Sacá la corrida con '${restartInvocation(session)}', que archiva el registro dentro de la sesión, re-adopta su flow y lo deja en la traza; o seguí la recuperación de la fila — ${
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
