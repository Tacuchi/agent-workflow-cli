/**
 * An answer comes back, and either it survives validation or nothing moves.
 *
 * The order of the checks is the contract, not an implementation detail:
 *
 * 1. **Resend first.** The attempt history is hydrated from the persisted state
 *    and consulted before anything else. A resend of an answer that was already
 *    applied quotes the seal of a boundary the run has since left, so judging
 *    staleness first would report "stale" for what is really "already applied" —
 *    and would tempt the sender into answering twice.
 * 2. **Then the boundary in force.** Which shape is admissible comes from the
 *    boundary, never from a flag: the same `submit` answers a semantic boundary,
 *    a human one and an authorization one.
 * 3. **Then apply.** Only a surviving answer becomes a transition, and only then
 *    does the run keep advancing until the next boundary. One surviving answer
 *    deliberately applies nothing: an approval over a step doctrine still owns
 *    grants the effect and leaves the run where it stands.
 *
 * Every rejection travels with `ok: true` inside the RECALCULATED directive,
 * carrying its code, message and action — with `ok: false` the host never calls
 * `renderHuman`, and a boundary nobody can see is a boundary that did not happen.
 */

import { join } from "node:path";
import { type EffectClass, authorizeEffects } from "../../domain/capability/effects.js";
import { AttemptLedger } from "../../domain/capability/protocol.js";
import type { CapabilityFailure, CapabilityOutcome } from "../../domain/capability/protocol.js";
import { type FlowAnswer, claimedSeal, parseFlowAnswer } from "../../domain/flow/answer.js";
import {
  type FlowDecision,
  actionOf,
  internalActionOf,
  journeyOfFlow,
  proposalContractOf,
  publishApprovalOf,
} from "../../domain/flow/authority.js";
import { effectApprovalDigest } from "../../domain/flow/authorization.js";
import {
  type FlowDirective,
  PAUSE_LABEL,
  STOP_LABEL,
  stepOf,
} from "../../domain/flow/directive.js";
import { executionVerdict } from "../../domain/flow/execution-result.js";
import {
  type FlowRunAttempt,
  type FlowRunState,
  applyTransition,
  checkAgainstJourney,
  withApproval,
  withAttempt,
  withBoundary,
  withObservation,
  withProposal,
} from "../../domain/flow/run-state.js";
import { destinationsOf, sealProposal } from "../../domain/proposal.js";
import { baseDigest } from "../../domain/proposal.js";
import { checkSafeRelativePath } from "../../domain/safe-path.js";
import type { FileSystemPort } from "../../ports/file-system.js";
import { type PathsService, resolveWorkspaceRootFrom } from "../paths-service.js";
import { semanticDigest } from "../semantic-operation/protocol.js";
import { type SessionResolutionError, resolveSessionTarget } from "../session-resolver.js";
import {
  type ResolvedBoundary,
  actionDigest,
  advanceFlowRun,
  directiveFor,
  effectsOfTransition,
  resolveBoundary,
} from "./advance.js";
import type { InternalActionExecutor } from "./internal-actions.js";
import { driveInternalActions } from "./internal-drive.js";
import { type FlowRunMutation, applyUnderLock, locateRun } from "./run-state-service.js";

export interface SubmitFlowInput {
  code?: string;
  contextId?: string;
  /** The JSON payload, read from stdin. */
  raw: string;
  /** `--approval <digest>`, apart from the payload on purpose. */
  approval: string | null;
  /** How this process materializes internal actions. See {@link driveInternalActions}. */
  executor?: InternalActionExecutor;
}

export type SubmitFlowResult =
  | { ok: true; directive: FlowDirective }
  | { ok: false; failure: CapabilityFailure }
  | { ok: false; session: SessionResolutionError };

export async function submitFlow(
  fs: FileSystemPort,
  paths: PathsService,
  input: SubmitFlowInput,
): Promise<SubmitFlowResult> {
  const resolution = await resolveSessionTarget(fs, paths, {
    ...(input.code !== undefined ? { code: input.code } : {}),
    ...(input.contextId !== undefined ? { contextId: input.contextId } : {}),
    allowClosed: false,
    bind: true,
  });
  if (resolution.outcome !== "resolved") return { ok: false, session: resolution };

  const location = locateRun(paths, resolution.session.folder);
  // Read the destinations BEFORE taking the lock, so the decision below stays
  // pure. What this observation buys is the honest half of the preview — whether
  // a write creates or replaces, and what it would replace — and the race it
  // leaves open is exactly the one the compare-and-swap closes at publish time.
  const snapshot = await observeDestinations(fs, paths, input.raw);
  const applied = await applyUnderLock<SubmitOutcome>(fs, location, (current) => {
    if (current === null) {
      return {
        ok: false,
        failure: {
          code: "FLOW_RUN_ABSENT",
          message: "no hay corrida que responder en esta sesión",
          action: "adoptala primero con 'aw flow advance --flow <flow> --adopt'",
        },
      };
    }
    return decide(current, input, snapshot);
  });

  if (!applied.ok) return { ok: false, failure: applied.failure };
  // An answer that ADVANCED the run can leave it standing on an internal action —
  // an approval of the close is exactly that — and stopping here would hand back a
  // step this same process is about to be asked to run.
  //
  // A REFUSED answer never drives: the directive it produced is the refusal, and
  // replacing it with whatever the CLI did next would tell the sender their answer
  // was fine. The run stays where the refusal left it.
  if (!applied.value.advanced) return { ok: true, directive: applied.value.directive };
  const driven = await driveInternalActions(fs, location, input.executor, {
    ok: true,
    state: applied.state,
    value: applied.value.directive,
  });
  if (!driven.ok) return { ok: false, failure: driven.failure };
  return { ok: true, directive: driven.value };
}

/**
 * The directive an answer produced, and whether the answer APPLIED something.
 *
 * `true` covers the approval that holds as much as the transition that advances:
 * both moved the state, and both can leave the run standing somewhere this process
 * may continue from. What it excludes is every refusal.
 *
 * The flag is not derivable afterwards: a refusal and an application both come
 * back as a recalculated directive over a state, and only the decision that built
 * it knows which of the two it was.
 */
interface SubmitOutcome {
  directive: FlowDirective;
  advanced: boolean;
}

/**
 * The whole decision, pure over the state read under the lock.
 *
 * Kept separate from the I/O so every branch is reachable from a test without a
 * filesystem, and so "a rejection writes nothing" is visible in one place: the
 * only branches that return a NEW state are the two that legitimately applied
 * something.
 */
type SubmitDecision = FlowRunMutation<SubmitOutcome>;

/** What each candidate destination looked like just before the answer was judged. */
type DestinationSnapshot = ReadonlyMap<string, { exists: boolean; digest: string }>;

/**
 * Stat the destinations the payload names, without trusting anything else in it.
 *
 * The paths come from raw JSON and are used for nothing but deciding which files
 * to look at; whether each one is a LEGAL destination is settled later by the
 * boundary's own allowlist. Doing it here is what keeps the whole decision —
 * including the seal — reproducible without a filesystem.
 *
 * The shape check is NOT redundant with that allowlist. Reading is an effect, and
 * an absolute path or a `..` would have this function open a file outside the
 * workspace before anybody decided the destination was admissible. Nothing would
 * leak — the entry is discarded when validation rejects the path — but "read only
 * what you were asked to read" is not a property to leave resting on what happens
 * to the result afterwards.
 */
async function observeDestinations(
  fs: FileSystemPort,
  paths: PathsService,
  raw: string,
): Promise<DestinationSnapshot> {
  const snapshot = new Map<string, { exists: boolean; digest: string }>();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return snapshot;
  }
  const artifacts = (parsed as { artifacts?: unknown } | null)?.artifacts;
  if (!Array.isArray(artifacts) || artifacts.length === 0) return snapshot;
  const root = await resolveWorkspaceRootFrom(fs, paths);
  for (const entry of artifacts) {
    const path = (entry as { path?: unknown })?.path;
    if (typeof path !== "string") continue;
    const relative = path.trim();
    if (relative.length === 0 || snapshot.has(relative)) continue;
    if (!checkSafeRelativePath(relative).ok) continue;
    const absolute = join(root, relative);
    if (!(await fs.exists(absolute))) {
      snapshot.set(relative, { exists: false, digest: "" });
      continue;
    }
    try {
      snapshot.set(relative, { exists: true, digest: baseDigest(await fs.readText(absolute)) });
    } catch {
      // Unreadable is not "absent": treating it as a fresh create would propose a
      // silent overwrite of something nobody could show the person.
      snapshot.set(relative, { exists: true, digest: "" });
    }
  }
  return snapshot;
}

function decide(
  state: FlowRunState,
  input: SubmitFlowInput,
  snapshot: DestinationSnapshot,
): SubmitDecision {
  const journey = journeyOfFlow(state.flow);
  const incoherent = checkAgainstJourney(state, journey);
  if (incoherent !== null) return { ok: false, failure: incoherent };

  const resolved = resolveBoundary(state, journey);
  if (resolved.stopped === null) {
    return reject(state, resolved, "el recorrido ya terminó: no hay frontera que responder", {
      code: "FLOW_ANSWER_NOT_EXPECTED",
      action: "no queda trabajo pendiente en este recorrido",
    });
  }
  if (state.boundary === null) {
    return reject(state, resolved, "esta corrida todavía no se detuvo en ninguna frontera", {
      code: "FLOW_ANSWER_NOT_EXPECTED",
      action: "corré 'aw flow advance' primero: la frontera la emite el motor, no el llamador",
    });
  }

  // The seal the payload CLAIMS keys the lookup, not the current one: a resend of
  // an answer that was already applied quotes a boundary the run has left, and
  // looking it up under today's seal would never find it. A forged seal buys
  // nothing — matching a recorded attempt requires resending exactly what already
  // ran, and a retry applies nothing.
  const identity = attemptIdentity(
    state,
    input,
    claimedSeal(input.raw) ?? resolved.seal,
    resolved.stopped.id,
  );
  // 1 · Resend, before anything else.
  const resend = resendCheck(state, resolved, identity);
  if (resend !== null) return resend;

  // The action the run is waiting on is the one that was EMITTED, and the seal
  // would already refuse a result about any other. What the persisted digest adds
  // is the diagnosis: when the two differ, the invocation changed underneath a run
  // in flight (a CLI upgraded mid-run), which is a different problem from a state
  // that moved — and it has a different answer.
  const drifted = actionDrift(state, resolved);
  if (drifted !== null) return drifted;

  // 2 · The boundary in force decides what is admissible.
  const admissible = admit(state, resolved, resolved.stopped, input, { journey, identity });
  if ("decision" in admissible) return admissible.decision;
  const parsed = admissible;

  // 3 · Apply: the answer is the INPUT to the CLI's decision, so what advances is
  // the transition, never the sender's own verdict.
  //
  // Two things can happen here besides advancing, and both are approvals: the
  // classic one over an effect class named by a boundary, and the one this phase
  // added — a single `Aprobar y guardar` that grants over the exact proposal the
  // preview showed. Neither ever applies the step by itself.
  const sealed = sealFrom(state, resolved.stopped, parsed.answer, snapshot);
  if ("failure" in sealed) {
    return reject(state, resolved, sealed.failure.message, {
      code: sealed.failure.code,
      action: sealed.failure.action,
    });
  }
  const granted = resolved.kind === "authorization" ? (resolved.authorization?.planned ?? []) : [];
  const approved = grantOf(sealed.state, resolved, parsed.answer, granted);
  // An approval NEVER applies a step by itself. Two reasons it must hold, and the
  // second is the one this phase exists for: doctrine may still own the rule, or
  // the step may be delegated — and an approval that applied a delegated
  // transition would record the search, the write or the check as done because
  // someone said the effect was allowed.
  const holds =
    resolved.kind === "authorization" &&
    (resolved.stopped.ownership !== "cli-owned" || actionOf(resolved.stopped) !== null);
  return holds
    ? holdAfterApproval(approved, journey, identity)
    : applyAndAdvance(approved, journey, resolved.stopped, identity, parsed.answer);
}

/**
 * Seat the proposal an authoring answer just handed over — sealed, not believed.
 *
 * Three things are DERIVED here and none of them is taken from the sender: whether
 * each destination already exists (so the preview says "replaces" only when it
 * does), the compare-and-swap base of every destination that does, and the effect
 * classes the write really exercises. The row's declared effects are the ceiling,
 * and a proposal that would reach past it is refused rather than quietly widened —
 * a save row that never declared `mutate_overwrite` may not overwrite because the
 * bytes happened to land on an existing file.
 */
function sealFrom(
  state: FlowRunState,
  stopped: FlowDecision,
  answer: FlowAnswer,
  snapshot: DestinationSnapshot,
): { state: FlowRunState } | { failure: CapabilityFailure } {
  const contract = proposalContractOf(stopped);
  if (contract === null || answer.artifacts.length === 0) return { state };

  // A destination nobody looked at cannot be previewed. Defaulting it to "creates"
  // would be the one line of the preview a person most needs to trust, guessed —
  // so an unobserved path is a refusal, not a default.
  const unseen = answer.artifacts.filter((artifact) => !snapshot.has(artifact.path));
  if (unseen.length > 0) {
    return {
      failure: {
        code: "FLOW_PROPOSAL_DESTINATION_UNOBSERVED",
        message: `no se pudo mirar el estado vigente de ${unseen.map((a) => a.path).join(", ")}`,
        action: "volvé a enviar la propuesta con destinos relativos dentro del workspace",
      },
    };
  }
  const artifacts = answer.artifacts.map((artifact) => ({
    path: artifact.path,
    content: artifact.content,
    overwrite: snapshot.get(artifact.path)?.exists === true,
  }));
  const effects: EffectClass[] = [];
  if (artifacts.some((a) => !a.overwrite)) effects.push("local_additive");
  if (artifacts.some((a) => a.overwrite)) effects.push("mutate_overwrite");
  const beyond = effects.filter((effect) => !contract.effects.includes(effect));
  if (beyond.length > 0) {
    return {
      failure: {
        code: "FLOW_PROPOSAL_BEYOND_CONTRACT",
        message: `la propuesta ejercería ${beyond.join(", ")} y esta frontera no lo declara`,
        action: `proponé sólo efectos de: ${contract.effects.join(", ")}`,
      },
    };
  }
  const bases = artifacts
    .filter((a) => a.overwrite)
    .map((a) => ({ path: a.path, digest: snapshot.get(a.path)?.digest ?? "" }));
  const unreadable = bases.filter((base) => base.digest.length === 0);
  if (unreadable.length > 0) {
    return {
      failure: {
        code: "FLOW_PROPOSAL_BASE_UNREADABLE",
        message: `no se pudo leer el contenido vigente de ${unreadable.map((b) => b.path).join(", ")}`,
        action: "no se propone sobrescribir lo que no se puede mostrar: revisá permisos",
      },
    };
  }
  const authorization = authorizeEffects(
    effects.map((effect) => ({
      class: effect,
      idempotent: true,
      authorization: "invocation" as const,
      approval: "none" as const,
    })),
    { sensitiveSources: false, scopeExpanded: false },
  );
  return {
    state: withProposal(
      state,
      sealProposal({
        operation: `flow.${stopped.id}`,
        artifacts,
        bases,
        // No flow row reads a sensitive source or reaches past what it shows
        // today. The fields are sealed anyway: the day one does, the digest
        // changes and every grant given under the old scope stops matching.
        scope: { sensitive_sources: false, scope_expanded: false },
        effects,
        requiresApproval: authorization.needsPreflight,
      }),
    ),
  };
}

/**
 * The grant this answer produced, scoped to what it was given over.
 *
 * `Aprobar y guardar` at a publishing row is one decision that covers the whole
 * preview, and the seal is the proposal's own: a later boundary, or the same
 * proposal after any material edit, does not match it. Choosing anything else —
 * `Refinar`, `Compactar`, `Cerrar` — grants nothing, which is what makes
 * "`Refinar` produces no effects" a property rather than a promise.
 */
function grantOf(
  state: FlowRunState,
  resolved: ResolvedBoundary,
  answer: FlowAnswer,
  granted: readonly EffectClass[],
): FlowRunState {
  const stopped = resolved.stopped;
  const proposal = state.proposal;
  const approve = stopped === null ? null : publishApprovalOf(stopped);
  if (approve !== null && proposal !== null) {
    if (answer.choice === approve) {
      return withApproval(state, {
        digest: proposal.digest,
        destinations: destinationsOf(proposal),
        classes: [...proposal.requires_approval],
      });
    }
    // Declining unseats the proposal, and that is what makes `Refinar` cost
    // nothing: the publication downstream finds nothing to publish and is skipped
    // saying so, instead of stopping to ask for an authorization over bytes the
    // person just turned down.
    return withProposal(state, null);
  }
  if (granted.length === 0 || resolved.authorization === null) return state;
  return withApproval(state, {
    digest: resolved.authorization.seal,
    destinations: [],
    classes: [...granted],
  });
}

/**
 * Everything that decides whether this payload may become a transition.
 *
 * Three refusals live together because they answer the same question — "is this
 * an admissible answer to the boundary in force?" — and none of them writes:
 * a payload the boundary's own contract rejects, a decline (a real answer that
 * applies nothing), and an execution result that did not earn its transition.
 */
function admit(
  state: FlowRunState,
  resolved: ResolvedBoundary,
  stopped: FlowDecision,
  input: SubmitFlowInput,
  spent: SpentAttempt,
): { ok: true; answer: FlowAnswer } | { decision: SubmitDecision } {
  const expectedApproval =
    resolved.kind === "authorization"
      ? effectApprovalDigest(stopped.id, resolved.authorization?.planned ?? [])
      : null;
  const parsed = parseFlowAnswer({
    raw: input.raw,
    boundary: resolved.kind,
    decision: stopped,
    seal: resolved.seal,
    choices: resolved.choices,
    approval: input.approval,
    expectedApproval,
    action: resolved.action,
    request: resolved.request,
  });
  if (!parsed.ok) {
    // An answer the boundary refused IS an attempt spent: it is the exact event
    // the chassis' cap counts. Recorded here and nowhere else — a resend, a
    // decline and a pause are not failed tries at resolving the gap.
    return {
      decision: reject(
        state,
        resolved,
        parsed.failure.message,
        { code: parsed.failure.code, action: parsed.failure.action },
        spent,
      ),
    };
  }
  // The flow control is a real answer, and neither half applies anything. They
  // are kept apart because the outcomes differ and the difference is the point:
  // stopping ends the run here (`cancelled`), pausing keeps the very same
  // boundary standing so the run picks it up after compacting (`needs_input`).
  // Collapsing them would report a paused run as a cancelled one.
  if (parsed.answer.choice === PAUSE_LABEL) {
    return {
      decision: reject(
        state,
        resolved,
        `'${PAUSE_LABEL}': la frontera queda en pie y la corrida retoma acá`,
        {
          code: "FLOW_BOUNDARY_PAUSED",
          action:
            "escribí el CHECKPOINT con 'aw checkpoint-write', compactá, y volvé con 'aw flow advance' a esta misma frontera",
          outcome: "needs_input",
        },
      ),
    };
  }
  if (parsed.answer.choice === STOP_LABEL) {
    return {
      decision: reject(
        state,
        resolved,
        `'${STOP_LABEL}': el recorrido queda detenido en esta frontera`,
        {
          code: "FLOW_BOUNDARY_DECLINED",
          action: "reanudá con 'aw flow advance' cuando quieras retomar esta frontera",
          outcome: "cancelled",
        },
      ),
    };
  }
  // An execution result has to EARN the transition. Anything short of a completed
  // run with its evidence and its whole effect keeps the boundary standing: the
  // work stays pending, with the recovery the action declared.
  if (resolved.kind === "execution") {
    // The row's `effects` are the ceiling and the sealed proposal is what really
    // happens: demanding an overwrite from a publication that only creates files
    // would leave the transition pending for an effect nobody could produce.
    const verdict = executionVerdict(
      parsed.answer.result,
      resolved.action,
      effectsOfTransition(state, stopped),
    );
    if (verdict !== null) {
      return { decision: reject(state, resolved, verdict.message, verdict.detail, spent) };
    }
  }
  return parsed;
}

/**
 * Whether the sealed action changed underneath a run that is standing on it.
 *
 * Only reachable when the persisted digest and the registry's current one differ —
 * i.e. the build moved while the caller was executing. Saying so beats the generic
 * staleness the seal would otherwise report, because the fix is different: nothing
 * is wrong with the state, the invocation is simply no longer the one that ran.
 */
function actionDrift(state: FlowRunState, resolved: ResolvedBoundary): SubmitDecision | null {
  const pending = state.pending_action;
  if (pending === null || resolved.action === null) return null;
  if (pending.digest === actionDigest(resolved.action)) return null;
  return reject(
    state,
    resolved,
    "la acción de esta frontera cambió después de emitirse: el resultado corresponde a otra invocación",
    {
      code: "FLOW_ACTION_CHANGED",
      action:
        "volvé a correr 'aw flow advance' para recibir la acción vigente y ejecutá esa antes de responder",
    },
  );
}

/**
 * Approving an effect is NOT deciding the step, and never executing it.
 *
 * The approval is recorded and the run stays exactly where it is: the recalculated
 * boundary is the one for the SAME transition, so approving what a step exercises
 * never doubles as deciding it. Applying here would let an approval smuggle in the
 * step itself.
 *
 * On a DELEGATED transition the same hold, for the sharper reason: the approval
 * authorizes the effect and the recalculated boundary becomes the `execution` one,
 * which still has to come back with real output. "You may write this" and "this
 * was written" are different facts, and only the second one advances a run.
 */
function holdAfterApproval(
  approved: FlowRunState,
  journey: readonly FlowDecision[],
  identity: FlowRunAttempt,
): SubmitDecision {
  const held = advanceFlowRun({ state: withAttempt(approved, identity), journey, applied: [] });
  if (!held.ok) return { ok: false, failure: held.failure };
  return { ok: true, state: held.state, value: { directive: held.directive, advanced: true } };
}

/** The answer survived: the transition applies and the run keeps advancing. */
function applyAndAdvance(
  approved: FlowRunState,
  journey: readonly FlowDecision[],
  stopped: FlowDecision,
  identity: FlowRunAttempt,
  answer: FlowAnswer,
): SubmitDecision {
  // What the agent OBSERVED outlives the boundary it was asked at: a later rule
  // reads these signals to apply its threshold. The verdict is not stored — it is
  // derived from these on each read, so the two can never disagree.
  let next =
    answer.signals.length > 0
      ? withObservation(approved, { transition: stopped.id, signals: answer.signals })
      : approved;
  next = applyTransition(next, stopped.id, effectsOfTransition(next, stopped));
  // A published proposal is spent, whoever published it. This is the degraded
  // path — no internal executor, so the caller ran the write and returned its
  // result — and leaving the proposal seated would keep a preview of bytes that
  // are already on disk standing in front of the next boundary.
  if (internalActionOf(stopped)?.operation === "proposal.publish") {
    next = withProposal(next, null);
  }
  next = withAttempt(next, identity);
  // The boundary follows the position, always: handing the engine a state whose
  // boundary still names the transition just applied is exactly the incoherence
  // `checkAgainstJourney` exists to refuse.
  next = withBoundary(next, journey[next.applied.length]?.id ?? null);

  const advanced = advanceFlowRun({ state: next, journey, applied: [stepOf(stopped)] });
  if (!advanced.ok) return { ok: false, failure: advanced.failure };
  return {
    ok: true,
    state: advanced.state,
    value: { directive: advanced.directive, advanced: true },
  };
}

/**
 * Whether this submission is a resend, judged by the ledger that already knows
 * how.
 *
 * The persisted history is replayed through {@link AttemptLedger} rather than
 * counted by hand, so its sequence and parent-linkage rules apply for free — and
 * a history that cannot be replayed is itself a refusal, not something to work
 * around. `null` means "a genuinely new attempt: carry on".
 *
 * A twin in the history is not enough, and the real walk of the closing tranche
 * is what showed it. Since refusals started being persisted — and since the seal
 * stopped moving when one is recorded, so that a caller's own refusal would not
 * come back as staleness — resending a REFUSED answer looks exactly like
 * resending an applied one. Both find their twin. Only one of them advanced
 * anything, and answering the other with "this already applied" reports a run
 * that is stuck as one that is done: `completed`, with the real cause (a mismatched
 * approval, an invalid payload) replaced by a vague one, permanently, because
 * every retry from then on gets the same reply.
 *
 * So the twin has to say which it was, and that fact is already in the state:
 * the run moves past what it applies, so an attempt whose transition is not in
 * `applied` never advanced anything. Derived rather than stored on the attempt,
 * for the reason the registry gives everywhere it derives: two sources for one
 * fact disagree eventually, and then the state is unusable.
 */
function resendCheck(
  state: FlowRunState,
  resolved: ResolvedBoundary,
  identity: FlowRunAttempt,
): SubmitDecision | null {
  const ledger = new AttemptLedger();
  for (const past of state.attempts) {
    const replay = ledger.record(past);
    if (!replay.ok) return { ok: false, failure: replay.failure };
  }
  const verdict = ledger.record(identity);
  if (!verdict.ok) return { ok: false, failure: verdict.failure };
  if (verdict.kind === "new") return null;
  // The TWIN's transition, not this submission's: the identity is built over the
  // boundary in force, and a resent applied answer is being sent at the next one.
  // What is being asked is whether the step the twin answered ever moved.
  const twin = state.attempts.find(
    (past) =>
      past.invocation_id === identity.invocation_id &&
      past.request_digest === identity.request_digest,
  );
  // The twin was refused: this is a retry of the same wrong answer, so it gets
  // the same real diagnosis again and counts toward the cap, which is what
  // eventually degrades the boundary instead of leaving the caller looping.
  if (twin !== undefined && !state.applied.includes(twin.transition)) return null;
  return reject(
    state,
    resolved,
    "esta respuesta ya se había aplicado: el recorrido no avanza dos veces",
    {
      code: "FLOW_ANSWER_RESENT",
      action: "la frontera vigente es la que devuelve esta directiva; contestá esa",
      outcome: "completed",
    },
  );
}

/**
 * A rejection, expressed as the recalculated directive.
 *
 * The state handed back is the one that was read: nothing is written on this
 * path, and the caller can see that because the mutation returns `ok: false`
 * only for invocation failures — a business rejection returns the state unchanged
 * with its own outcome.
 */
function reject(
  state: FlowRunState,
  resolved: ResolvedBoundary,
  message: string,
  detail: { code: string; action: string; outcome?: CapabilityOutcome },
  spent?: SpentAttempt,
): SubmitDecision {
  // A refused answer is the one rejection that CHANGES the run: the attempt is
  // recorded, so the boundary that has been tried to its cap degrades instead of
  // being emitted again. The boundary is recalculated over that state, which is
  // what turns the last refusal into the degradation rather than into an
  // identical question with a different error string.
  const after = spent === undefined ? state : withAttempt(state, spent.identity);
  const now = spent === undefined ? resolved : resolveBoundary(after, spent.journey);
  const built = directiveFor(after, now, [], {
    // No outcome named ⇒ the boundary decides it: a finished journey reports
    // `completed`, an open one `needs_input`. Hardcoding one here would let a
    // rejection at the end of a run claim work is still pending.
    ...(detail.outcome === undefined ? {} : { outcome: detail.outcome }),
    nextAction: `${message} — ${now.error?.action ?? detail.action}`,
  });
  if (!built.ok) return { ok: false, failure: built.failure };
  // Rewritten with the rejection's own code so the reason is machine-readable and
  // not only prose in `next_action` — unless the recalculated boundary is itself
  // blocked, in which case ITS cause is the actionable one: answering again is no
  // longer a way forward, and reporting the payload's error would suggest it is.
  const directive: FlowDirective = {
    ...built.directive,
    error: now.error ?? { code: detail.code, message, action: detail.action },
  };
  return {
    ok: true,
    state: after,
    value: { directive, advanced: false },
    persist: spent !== undefined,
  };
}

/** The attempt a refused answer spends, and the journey its boundary belongs to. */
interface SpentAttempt {
  journey: readonly FlowDecision[];
  identity: FlowRunAttempt;
}

/**
 * The attempt this submission is, in the terms `AttemptLedger` already validates.
 *
 * `invocation_id` is the boundary's seal: stable while the run stands there, and
 * different the moment the state moves — which is exactly the identity a resend
 * has to match. Reusing the ledger instead of counting by hand is the point: its
 * sequence and parent-linkage rules come for free.
 */
function attemptIdentity(
  state: FlowRunState,
  input: SubmitFlowInput,
  seal: string,
  transition: string,
): FlowRunAttempt {
  const digest = semanticDigest({ payload: input.raw, approval: input.approval });
  const prior = state.attempts.filter((past) => past.invocation_id === seal);
  const twin = prior.find((past) => past.request_digest === digest);
  const attempt = twin?.attempt ?? prior.length + 1;
  const parent =
    attempt === 1
      ? null
      : (prior.find((past) => past.attempt === attempt - 1)?.request_digest ?? null);
  return {
    invocation_id: seal,
    attempt,
    request_digest: digest,
    parent_request_digest: parent,
    // The seal moves with the state; the transition does not while the run
    // stands there. It is what the cap counts over.
    transition,
  };
}
