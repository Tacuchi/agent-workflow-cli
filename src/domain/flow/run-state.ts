/**
 * The run's state, owned by the CLI — and the reason it can be trusted.
 *
 * A flow run stops at boundaries and is picked up later, possibly from another
 * host, with the original conversation gone. What survives that is this file:
 * which flow, which transitions were already applied, which boundary is in
 * force, what was authorized, and the attempt history that tells a resend apart
 * from a new attempt.
 *
 * It is sealed with the SAME canonicalization the rest of the system uses
 * (`canonicalJson` / `semanticDigest`) rather than a second digest criterion —
 * two digests over the same bytes is exactly how a "tampered" verdict becomes
 * unfalsifiable.
 *
 * Reading is **fail-closed** and the four verdicts are deliberately distinct: an
 * ABSENT state in an open session is a LEGACY session, not corruption, and its
 * answer is an adoption action; an unknown version, invalid JSON or a digest
 * that does not match are refusals with a repair action. None of them advances.
 *
 * The human artifacts (`SESSION.md`, `CHECKPOINT.md`, `BACKLOG.md`) are not
 * touched by any of this: they keep their headings and their role as the run's
 * readable log.
 */

import type { WorklineFlow } from "../../application/capability/compose.js";
import { WORKLINE_FLOWS } from "../../application/capability/compose.js";
import { canonicalJson, semanticDigest } from "../../application/semantic-operation/protocol.js";
import { type EffectClass, isEffectClass, touchesTheWorld } from "../capability/effects.js";
import { AttemptLedger } from "../capability/protocol.js";
import type { CapabilityFailure, EffectLedger } from "../capability/protocol.js";
import { type DecisionNote, validateDecisionNote } from "../decision-note.js";
import type { DecisionPreview } from "../decision-preview.js";
import type { LocalProposal } from "../proposal.js";
import type { PlanReconciliation } from "../reconciliation.js";
import type { FlowChoiceOutcome, FlowDecision } from "./authority.js";
import type { EffectGrant } from "./authorization.js";
import {
  type AssuranceStatus,
  type RouteDecision,
  type RouteProposal,
  type RouteSubstitution,
  assuranceForRoute,
  isAssuranceStatus,
  isRouteDisposition,
} from "./route.js";

/**
 * The version this CLI WRITES. Every state it persists carries it.
 *
 * Raised by the attempt accounting: a state that carries the monotone floor is a
 * state whose cap depends on a reader that knows to consult it. The version gate
 * is an exact-equality check in every build that ever shipped, so an older CLI
 * refuses a file stamped with a version it does not know — which is the only
 * mechanism that stops it from reading the new format, IGNORING the floor, and
 * turning the cap off in silence while somebody alternates CLI versions over one
 * run. Failing with a cause is the requirement; failing silently is the defect.
 */
export const FLOW_RUN_STATE_VERSION = 11;

/**
 * The versions this CLI READS, newest first.
 *
 * Versions 9, 8 and 7 remain readable for status, recovery evidence and an
 * explicit adoption. They are NOT writable execution state: v10 records batches
 * and their append-only iteration trace, so continuing an old cursor by merely
 * changing `version` would invent a batch boundary the old run never declared.
 * An active legacy run must be adopted explicitly before any mutation.
 */
export const FLOW_RUN_STATE_READABLE: readonly number[] = [FLOW_RUN_STATE_VERSION, 10, 9, 8, 7];

/** The CLI-owned run state inside the session folder. Machine-local, dotted. */
export const FLOW_RUN_STATE_FILE = ".flow-run.json";

/**
 * One attempt already seen on this run.
 *
 * Persisting the history is what lets {@link AttemptLedger} be hydrated on a
 * later invocation: without it, a resend after a crash would look like a brand
 * new attempt and the run would advance twice for one answer.
 */
export interface FlowRunAttempt {
  invocation_id: string;
  attempt: number;
  request_digest: string;
  parent_request_digest: string | null;
  /**
   * The transition this attempt was answering.
   *
   * `invocation_id` cannot serve: it is the boundary's SEAL, and the seal moves
   * every time the state does — including when a failed attempt is recorded. So
   * counting how many times one boundary has been tried needs the one identity
   * that does not move while the run stands there, which is the transition id.
   */
  transition: string;
  /**
   * The plan-exec batch iteration this attempt belongs to, when the same
   * transition is walked again for a later batch.  It keeps the per-boundary
   * retry budget from leaking from F1 into F2 while retaining the full attempt
   * history in one append-only ledger.
   */
  batch_iteration?: number;
}

/**
 * How many times one boundary may be answered before the run degrades it.
 *
 * The chassis states the rule without a number ("`attempts[gap]++`, `MAX` cap")
 * because the number is not doctrine — what is doctrine is that a gap must not
 * be re-fired forever. Three is the smallest cap that still allows a genuine
 * correction: a first answer, a fix after reading why it was refused, and one
 * more. The fourth would be the loop the rule exists to prevent.
 */
export const MAX_BOUNDARY_ATTEMPTS = 3;

/**
 * A boundary the run GAVE UP on, and why.
 *
 * The cursor cannot express this on its own. An exhausted boundary lands in
 * `applied` beside the transitions that really happened and in `skipped` beside
 * the ones a condition passed over, so whoever reads the final state cannot tell
 * "the criteria were written" from "nobody wrote them and the retry burned".
 * This is that third fact, and it is a subset of `skipped`: a degradation the run
 * did not pass over would be a claim about a step it is still standing on.
 */
export interface FlowRunDegradation {
  transition: string;
  /** Why it was given up on. Never empty — a degradation without cause is a lie. */
  cause: string;
}

/**
 * How many attempts this run has EFFECTIVELY spent on one transition.
 *
 * Three numbers, and none of them alone is the answer. The ledger rows are what
 * this file remembers, and they are exactly what a restored copy of the file
 * rolls back — the seal detects an edit but not a `cp` of yesterday's state, so
 * counting rows alone made the cap evadable. The FLOOR is the monotone counter
 * kept outside the sealed blob (see the run-state service): it never goes
 * backwards, so the maximum of the two is the count that survives a restore. The
 * GRANTS are what a recovery gave back, and they are subtracted rather than
 * deleted from the floor, because a recovery that lowered the counter would
 * reopen the very hole it is fenced by.
 *
 * Both maps are optional on purpose: a run written before the counter existed has
 * only its rows, which is precisely what it always had. Absence is read as "no
 * floor beyond the ledger, nothing forgiven" — the conservative value — and never
 * as a reason to refuse a run that was walking fine.
 */
export function attemptsAt(state: FlowRunState, transition: string): number {
  return spendAt(state, transition).spent;
}

/** The monotone-counter key for one boundary, scoped when that boundary repeats in a batch. */
export function attemptCounterKey(state: FlowRunState, transition: string): string {
  const iteration = currentBatchIteration(state, transition);
  return attemptCounterKeyForIteration(transition, iteration ?? undefined);
}

/** Stable counter key for a historical attempt whose batch iteration is recorded on the row. */
export function attemptCounterKeyForIteration(
  transition: string,
  iteration: number | undefined,
): string {
  return iteration === undefined ? transition : `${transition}@batch-${iteration}`;
}

/**
 * The three numbers and the difference between them, computed once.
 *
 * Kept apart from {@link attemptAccountingAt} so the cap check stays what it was
 * — three lookups and a subtraction — while the richer reading built on top does
 * not restate the arithmetic. Two copies of this formula is exactly how the
 * directive and the recovery guard would end up disagreeing about the same run.
 */
function spendAt(
  state: FlowRunState,
  transition: string,
): { rows: FlowRunAttempt[]; floor: number; granted: number; spent: number } {
  const iteration = currentBatchIteration(state, transition);
  const rows = state.attempts.filter(
    (attempt) =>
      attempt.transition === transition &&
      (iteration === null
        ? attempt.batch_iteration === undefined
        : attempt.batch_iteration === iteration),
  );
  const key = attemptCounterKey(state, transition);
  const floor = state.attempt_floor?.[key] ?? 0;
  const granted = state.attempt_grants?.[key] ?? 0;
  return { rows, floor, granted, spent: Math.max(0, Math.max(rows.length, floor) - granted) };
}

/**
 * One representation of the count, by the name it carries in the state.
 *
 * Named rather than positional because the point of reporting a conflict is that
 * whoever reads it can go look: `attempt_floor` and `attempts` are fields
 * somebody can open in the file, and "2 against 1" without them is a riddle.
 */
export interface AttemptRepresentation {
  name: string;
  value: number;
}

/** Two representations of the same count that do not agree, and why. */
export interface AttemptConflict {
  between: [AttemptRepresentation, AttemptRepresentation];
  /** Never empty: a conflict nobody can act on is noise with a field name. */
  cause: string;
}

/**
 * Everything one transition's accounting says, with its parts still visible.
 *
 * {@link attemptsAt} answers the only question the cap needs — how much is spent
 * — and answering it SWALLOWS the three numbers it came from. That is precisely
 * what a caller cannot report: a message that says "1 of 3" cannot say which
 * representation disagreed when they do disagree, and whoever is stuck is left
 * comparing prose against a sealed file they are told not to edit. So the reading
 * is derived once, here, with its inputs kept, and every consumer projects this
 * object instead of recomputing a number of its own.
 *
 * Derived on READ and never persisted: every field comes from data the state
 * already carries, which is why observability costs the ledger no new version.
 */
export interface AttemptAccounting {
  transition: string;
  /** Rows this run persisted for the transition. */
  rows: number;
  /** The monotone counter's word, reconciled into the state on read. */
  floor: number;
  /** What a recovery forgave. */
  granted: number;
  /** The effective spend the cap is measured against. */
  spent: number;
  /** Evaluated decisions the boundary still admits. Never below zero. */
  available: number;
  /** The ordinals the rows carry, in the order they were recorded. */
  ordinals: number[];
  /** Representations that disagree. Empty when they all say the same thing. */
  conflicts: AttemptConflict[];
  /**
   * Why this boundary cannot be answered again, or `null`.
   *
   * NOT exhaustion. Exhaustion is `spent` against the cap and it is a boundary
   * the run walked into legitimately, with its own code and its own way out.
   * This is the other half of the same question: the persisted rows cannot yield
   * the next ordinal, so the ledger will refuse whatever ordinal a submit
   * computes. Handing such a boundary over as answerable asks somebody for a
   * number their own file rejects — and the attempt it costs is spent on nothing.
   */
  unanswerable: CapabilityFailure | null;
}

/**
 * The whole accounting of one transition, conflicts named and answerability read.
 *
 * The one reading the engine, the directive and the recovery guard share.
 */
export function attemptAccountingAt(state: FlowRunState, transition: string): AttemptAccounting {
  const { rows, floor: read, granted, spent } = spendAt(state, transition);
  // The floor the FILE will hold, not the one this invocation happened to read.
  // `raiseCounters` lifts it to at least the row count on every write, so the
  // pre-raise value left the directive reporting a floor one write behind itself
  // — and a projection that disagrees with the state it describes is the very
  // thing this reading exists to stop. It cannot mask a real divergence: a
  // counter that runs AHEAD of the rows stays ahead of this maximum.
  const floor = Math.max(read, rows.length);
  const ordinals = rows.map((attempt) => attempt.attempt);
  const conflicts: AttemptConflict[] = [];
  if (floor > rows.length) {
    conflicts.push({
      between: [
        { name: "attempt_floor", value: floor },
        { name: "attempts", value: rows.length },
      ],
      cause:
        "el contador monótono declara más intentos que las filas persistidas: o se restauró una copia anterior del ledger, o una escritura murió entre el contador y el estado",
    });
  }
  if (granted > Math.max(rows.length, floor)) {
    conflicts.push({
      between: [
        { name: "attempt_grants", value: granted },
        { name: "attempts", value: Math.max(rows.length, floor) },
      ],
      cause: "se perdonan más intentos de los que esta transición llegó a registrar",
    });
  }
  const highest = ordinals.length === 0 ? 0 : Math.max(...ordinals);
  if (highest !== rows.length) {
    conflicts.push({
      between: [
        { name: "attempts[].attempt", value: highest },
        { name: "attempts", value: rows.length },
      ],
      cause:
        "el ordinal más alto que las filas declaran no coincide con cuántas filas hay: la cadena tiene un hueco, un número repetido, o se reinició bajo otro sello",
    });
  }
  return {
    transition,
    rows: rows.length,
    floor,
    granted,
    spent,
    available: Math.max(0, MAX_BOUNDARY_ATTEMPTS - spent),
    ordinals,
    conflicts,
    unanswerable: unanswerableAt(state),
  };
}

/**
 * The refusal a submit would hit replaying this run's own history, or `null`.
 *
 * The ledger validates ordinals keyed by the boundary SEAL rather than by
 * transition, so the question cannot be asked about one transition in isolation:
 * it is asked the way `submit` asks it, by replaying every row the run persisted.
 * A failed replay is not a prediction — it is the same failure the next submit
 * returns, produced before anybody pays an attempt to discover it.
 */
function unanswerableAt(state: FlowRunState): CapabilityFailure | null {
  const ledger = new AttemptLedger();
  for (const past of state.attempts) {
    const replay = ledger.record(past);
    if (!replay.ok) return replay.failure;
  }
  return null;
}

/**
 * Why this boundary must NOT be handed back as answerable — or `null`.
 *
 * What the recovery guard consults, and it reads the run's own material trace
 * rather than inferring from the effect ledger: the ledger is run-wide, so it
 * cannot say WHICH boundary applied what. Two refusals, and the second one is
 * the doubt rather than the fact:
 *
 * - `materialized` — an event of this transition declares it applied something
 *   past `read_only`, or reports a half-applied effect. The world moved here, so
 *   giving the boundary back would invite a second answer on top of it.
 * - `unverified` — the run wrote down that it was ABOUT to run the action and
 *   the trace never came back. Nobody can say whether the operation reached
 *   anything, and at a guard "cannot say" reads as refusal. Its way out is an
 *   advance, which re-runs the action and produces the verdict that is missing.
 *
 * Scanned from the END, the same direction every other reader of this trace
 * walks it — but the whole trace is scanned, not just its last entry, because
 * the question is "did anything ever happen here", not "what happened last".
 */
export type RecoveryBlocker =
  | { reason: "materialized"; event: FlowRunEvent }
  | { reason: "unverified" };

export function recoveryBlockedAt(state: FlowRunState, transition: string): RecoveryBlocker | null {
  const iteration = currentBatchIteration(state, transition);
  const trace = state.events.filter(
    (event) =>
      event.transition === transition &&
      (iteration === null
        ? event.batch_iteration === undefined
        : event.batch_iteration === iteration),
  );
  const material = [...trace].reverse().find(declaresMaterialEffect);
  if (material !== undefined) return { reason: "materialized", event: material };
  const pending = state.pending_action;
  if (pending?.transition === transition && pending.attempted && trace.length === 0) {
    return { reason: "unverified" };
  }
  return null;
}

/**
 * Whether this event says the world moved — including when it cannot say.
 *
 * `FLOW_EFFECT_PARTIAL` is its own answer: the invocation declared complete and
 * did not apply everything the row demanded, so what it DID apply is exactly the
 * unknown. And a `failed` event with no `effects` at all comes from a trace
 * written before the field existed: same unknown, same refusal.
 */
function declaresMaterialEffect(event: FlowRunEvent): boolean {
  if (event.kind !== "failed") return touchesTheWorld(event.effects);
  if (event.effects === undefined) return true;
  return event.code === "FLOW_EFFECT_PARTIAL" || touchesTheWorld(event.effects);
}

/**
 * The seal of everything an answer was written AGAINST — attempts excluded.
 *
 * Not a second digest criterion: the same canonicalization over a deliberately
 * narrower input, declared once, here. `digest` seals the file so tampering is
 * detectable and must therefore cover every field. Staleness asks a different
 * question — "did what this answer depends on move?" — and a failed attempt that
 * was recorded moves nothing it depends on: same position, same boundary, same
 * action, same effects. Sealing the attempts into it would report the caller's
 * own previous refusal back to them as `FLOW_ANSWER_STALE`, replacing a precise
 * reason ("this evidence is missing") with a vague one.
 *
 * The floor and the grants leave with the attempts, for the same reason rather
 * than a new one: they are the same bookkeeping, reconciled from the monotone
 * counter on every read. A seal that moved when the counter did would turn
 * recording an attempt — or recovering a boundary — into staleness for an answer
 * that is still about exactly this position.
 */
export function positionDigest(state: FlowRunState): string {
  const {
    attempts: _spent,
    attempt_floor: _floor,
    attempt_grants: _granted,
    digest: _seal,
    ...position
  } = state;
  return semanticDigest(position);
}

/**
 * The delegated action the run is waiting on, by its seal.
 *
 * The action itself is derived from the registry row, so copying its fields here
 * would be a second source that can disagree with the first. What IS persisted is
 * the seal of the action that was actually emitted: a CLI that changed underneath
 * a run in flight rebuilds a different action, the seals no longer match, and the
 * result is refused with that reason instead of a generic staleness.
 */
export interface FlowPendingAction {
  transition: string;
  /** Seal over program, arguments, target, input and demanded evidence. */
  digest: string;
  /**
   * Whether this run already BEGAN materializing the action in its own process.
   *
   * The one fact re-entry cannot derive. Everything else about an internal
   * execution comes from the registry — which operation, whether repeating it is
   * safe, what evidence it owes — but "we had already started when the process
   * died" is only knowable if it was written down before the effect happened.
   * That is why it is persisted in its own write, ahead of the operation: a run
   * that comes back finding it `true` knows the world may already have moved, so
   * an idempotent operation is confirmed by running it again and a non-idempotent
   * one stops at its boundary with the recovery the row declares, instead of
   * being applied a second time.
   */
  attempted: boolean;
}

/**
 * What the agent OBSERVED at a semantic boundary, kept for the rule that reads it
 * later.
 *
 * Only the declared signals — never the verdict they produce. A threshold is
 * derived from these on each read, so there is one source: persisting the verdict
 * too would let the two drift and make "why did the gate fire?" unanswerable.
 */
export interface FlowObservation {
  transition: string;
  signals: string[];
  /** See {@link FlowRunAttempt.batch_iteration}. */
  batch_iteration?: number;
}

/**
 * Something that MATERIALLY happened, kept because nothing else records it.
 *
 * The cursor already says which transitions the run passed and which it skipped,
 * and re-deriving a skip's cause from the registry is exact — so neither is an
 * event. What no other field can reconstruct is the outcome of an operation this
 * CLI actually ran: what came back, what it applied, and why it failed when it
 * did. That is the trace a person reads to answer "what happened, and with what
 * evidence", and it is deliberately the only thing here: an event log that
 * restated the cursor would be a second source for the run's own position.
 *
 * The real output is kept as its SEAL plus a summary the operation itself
 * computed. The bytes were already consumed by the verdict that judged them; what
 * outlives the invocation is proof of WHICH bytes those were, so a later reading
 * cannot quietly become a different one.
 */
export type FlowRunEvent =
  | {
      kind: "executed";
      transition: string;
      /** See {@link FlowRunAttempt.batch_iteration}. */
      batch_iteration?: number;
      operation: string;
      /** One line, derived from the operation's own output. Never a claim. */
      summary: string;
      /** Seal over the real output the verdict consumed. */
      output_digest: string;
      effects: EffectClass[];
      evidence: string[];
    }
  | {
      kind: "failed";
      transition: string;
      /** See {@link FlowRunAttempt.batch_iteration}. */
      batch_iteration?: number;
      operation: string;
      code: string;
      message: string;
      /** The next action, so a stopped run is never a dead end. */
      recovery: string;
      /**
       * What the failed invocation still APPLIED, as it declared it.
       *
       * A failure is not the same as "nothing happened", and the difference is
       * the only thing that separates a boundary somebody may answer again from
       * one where a second answer lands on top of a half-applied effect. The
       * recovery guard reads it; nothing else does.
       *
       * Optional because a trace written before this field existed cannot say —
       * and at the guard, `undefined` reads as the refusal, never as `[]`.
       */
      effects?: EffectClass[];
    };

/**
 * What this run may touch: the plan it executes and the sources it edits.
 *
 * Two facts that only look unrelated. A run that edits code needs its own
 * isolation unit per source BEFORE the first write, and "which sources" is not
 * derivable from anything the engine holds — the plan says it, and the plan is a
 * document the engine never read. So both are fixed once, at a boundary, and
 * persisted: the acquisition knows which units to obtain, the branch and commit
 * boundaries know which trees to read, and `status`/`resume` can finally say
 * WHICH plan a session is executing instead of leaving two concurrent runs
 * indistinguishable.
 *
 * `sources` is never empty. `workspace` may appear as the documentary/control
 * checkout and needs no isolation unit; every other alias is acquired before
 * editing. An empty list would make the acquisition's effect conditional on a
 * scope somebody could leave blank.
 */
export interface FlowRunScope {
  /** Workspace-relative plan document this run executes. */
  plan: string;
  /** `workspace` plus declared aliases this run may touch — non-empty, no repeats. */
  sources: string[];
}

/** The bounded lifecycle of one repeatable plan-execution batch. */
export const PLAN_EXEC_BATCH_STAGES = [
  "inferred",
  "isolated",
  "implementing",
  "deviation",
  "validating",
  "reviewing",
  "closed",
  "committing",
  "integrating",
  "done",
] as const;

export type PlanExecBatchStage = (typeof PLAN_EXEC_BATCH_STAGES)[number];

/**
 * Durable intent for the one document publication that closes a batch.
 *
 * The intent is written before the plan bytes.  That makes a crash in between
 * observable: the next invocation can either finish the exact sealed write or
 * recognize that its after-digest already landed.  It never recomputes credit
 * from a changed plan.
 */
export interface PlanExecBatchPublication {
  plan: string;
  before_plan_digest: string;
  after_plan_digest: string;
  transition: string;
  status: "prepared" | "applied";
}

/**
 * A batch is a sealed snapshot of exactly the plan work this iteration owns.
 *
 * Task ids are the document's stable labels (`T4.1` etc.), not a claim made by
 * the agent; the application layer validates them against the current plan
 * before publication. The plan digest makes a moved document stale rather than
 * letting a previously inferred batch mark a different task.
 */
export interface PlanExecBatch {
  id: string;
  iteration: number;
  mode: "continuous" | "isolated";
  phases: number[];
  tasks: string[];
  plan_digest: string;
  /** Digest after the CLI-owned task/phase publication, once the batch closes. */
  published_plan_digest?: string;
  /** The durable pre-write intent and, after success, its applied proof. */
  publication?: PlanExecBatchPublication;
  stage: PlanExecBatchStage;
}

/** One immutable trace row for a batch iteration. */
export interface PlanExecBatchTrace {
  sequence: number;
  batch_id: string;
  iteration: number;
  stage: PlanExecBatchStage;
  transition: string;
  kind: "entered" | "completed" | "blocked";
}

/**
 * The cursor's repeatable PLAN-exec segment.
 *
 * `iteration` names the segment currently being walked, not the last closed
 * one.  It is sealed beside the batch trace so the dynamic journey can expand
 * without ever rewinding `applied`: a next batch appends another copy of the
 * segment, while the final close turns `pending` off and exposes final
 * validation/Git/done.
 */
export interface PlanExecBatchLoop {
  pending: boolean;
  iteration: number | null;
}

/**
 * The fully prepared decision view held at the deviation gate before a choice.
 *
 * `standalone` is the variant with no note in it, and that is not an omission: a
 * plan that declares no spec has no effective contract to compose against and no
 * `docs/decisions/` chain to join, so what the gate holds is exactly what the
 * person will authorize — the decision and where execution resumes. Its record
 * lives in the session's own `DECISION.md`, the way `quick` has always kept its
 * decisions.
 */
export type FlowDecisionPreparation =
  | {
      kind: "prepared";
      note: DecisionNote;
      preview: DecisionPreview;
      index_path: string;
      baseline: { path: string; number: string; digest: string; criteria: string[] };
    }
  | { kind: "settled"; decision: string }
  | { kind: "reused"; note: string; decision: string; resume_point: string }
  | { kind: "standalone"; decision: string; resume_point: string };

/**
 * The fix a quick run declared BEFORE anyone approved it.
 *
 * Its three parts are the ones the boundary demands — which files, what it fixes,
 * what shape the diff has — and they are kept for the same reason a decision
 * preparation is: what the person approves at the next boundary has to be the
 * exact thing that was declared, and a preview that lived only in the answer
 * could not be shown again after a compaction or a resume.
 */
export interface FlowFixPreview {
  /** Paths the fix will touch. Empty is legitimate: an analysis touches none. */
  files: string[];
  intent: string;
  diff: string;
}

/** The evidence a handoff destination receives instead of rediscovering it. */
export interface FlowEscalationPackage {
  /** Plan whose execution discovered the divergence, if the run had fixed one. */
  plan: string | null;
  /** Every validated deviation observation already collected in this run. */
  observations: FlowObservation[];
  /** Structured analysis sent with the gate answer; opaque but JSON-only. */
  decisions: Record<string, unknown>;
  /** Human label chosen at the gate, retained alongside its typed route. */
  selection: string;
}

/** A selected escalation ends this run and hands a sealed package to another flow. */
export interface FlowHandoff {
  destination: "plan-refine" | "spec-refine" | "spec-new";
  command: string;
  package: FlowEscalationPackage;
  package_digest: string;
}

/** The one non-trivial human route selected at the plan-exec deviation gate. */
export interface FlowChoiceSelection {
  transition: string;
  label: string;
  outcome: Extract<FlowChoiceOutcome, { kind: "register-decision" | "handoff" }>;
}

export interface FlowRunState {
  version: number;
  flow: WorklineFlow;
  /** Session folder that owns the run (`NNN-<slug>-<flow>`). */
  session: string;
  /** The plan and the sources this run isolates, or `null` before it fixed them. */
  scope: FlowRunScope | null;
  /**
   * Transition ids the run has already passed, in order — the journey's CURSOR.
   *
   * A member of {@link skipped} was passed WITHOUT being applied. Keeping both in
   * one list is what makes the cursor a length instead of a search, and splitting
   * them into two cursors is how a conditional step would silently desynchronize
   * the run from its journey.
   */
  applied: string[];
  /**
   * Ids the run passed over because their condition did not hold.
   *
   * Always a subset of {@link applied}: a conditional step that never happened is
   * still accounted for, and the difference between "decided" and "did not apply"
   * stays readable after the fact instead of being lost in a cursor.
   */
  skipped: string[];
  /** The transition the run is standing on, or null when nothing is pending. */
  boundary: string | null;
  /** The delegated action awaiting its result, or null when none is pending. */
  pending_action: FlowPendingAction | null;
  /** Validated observations a later rule consumes. */
  observations: FlowObservation[];
  /** What this CLI really ran, in order — the run's material trace. */
  events: FlowRunEvent[];
  /**
   * Approvals this run holds, each scoped to the exact seal it was given over.
   *
   * A list of effect CLASSES used to live here, and it was too wide by
   * construction: approving `mutate_overwrite` once authorized every later
   * transition of the run to overwrite. A grant names its seal, so it covers the
   * boundary or the proposal it was given for and nothing that comes after.
   */
  authorizations: EffectGrant[];
  /**
   * The exact local change awaiting its single decision, or `null`.
   *
   * One at a time on purpose: the preview a person is shown and the bytes that
   * get written have to be the same thing, and a queue of proposals would make
   * "the one that was approved" a lookup instead of an identity.
   */
  proposal: LocalProposal | null;
  /** Effects across their three moments, so a partial effect is expressible. */
  effects: EffectLedger;
  attempts: FlowRunAttempt[];
  /**
   * Boundaries this run gave up on, with the cause — a subset of {@link skipped}.
   *
   * Optional because a run written before this field existed cannot say, and
   * inventing a degradation it never recorded would be the same fabrication the
   * version gate refuses everywhere else. Absent reads as "none declared", never
   * as "none happened".
   */
  degraded?: FlowRunDegradation[];
  /**
   * The monotone counter's word on attempts per transition, reconciled on read.
   *
   * A CACHE of the sidecar that lives beside this file, kept here so the engine
   * stays pure: the service raises it before anything reads the state, and a state
   * restored from an older copy gets the live floor back, not the one it was
   * saved with. See {@link attemptsAt}.
   */
  attempt_floor?: Record<string, number>;
  /** Attempts a recovery gave back per transition — also from the sidecar. */
  attempt_grants?: Record<string, number>;
  /**
   * v10 plan-exec batches. Optional only while reading v7–v9; every v10 state
   * carries the two empty arrays when it has not inferred its first batch yet.
   */
  batches?: PlanExecBatch[];
  /** Append-only per-iteration batch trace; see {@link batches}. */
  batch_trace?: PlanExecBatchTrace[];
  /**
   * Which repeat of the plan-exec batch segment the cursor is walking.
   *
   * Optional only for v10 files written before the repeatable segment was
   * introduced; new states always carry it.  A missing value never fabricates a
   * new loop over already-recorded batches.
   */
  batch_loop?: PlanExecBatchLoop;
  /** A selected non-local route. An active handoff makes plan-exec terminal. */
  handoff?: FlowHandoff | null;
  /** Durable record of the chosen decision/handoff route, never inferred from prose. */
  selected_choice?: FlowChoiceSelection | null;
  /**
   * The decision classification/preview prepared before the deviation gate.
   *
   * It is kept in the sealed run instead of recomputed after a human says yes:
   * that makes the view the person saw, the proposal `commitDecision` writes and
   * the crash-retry identity one exact object.
   */
  decision_preparation?: FlowDecisionPreparation | null;
  /**
   * The fix preview the quick tranche declared, kept for the gate that approves it.
   *
   * Optional and NEVER written by default — the same discipline as `degraded` and
   * `attempt_floor`: a run that never declared a preview must serialize exactly
   * the bytes it did before this field existed, or its seal would move and every
   * in-flight run would read as stale. Absent means "no preview declared", never
   * "no preview was promised".
   */
  fix_preview?: FlowFixPreview | null;
  /**
   * Where a registered decision sent the work back to, still unsettled.
   *
   * This is the bounded continuity, and what it is NOT matters as much as what
   * it is: it does not move {@link applied}, {@link skipped} or
   * {@link boundary}. The journey stays a linear append-only pass, because a
   * cursor that could go back would make every already-applied transition
   * re-runnable, and the ledger that caps attempts is built on the cursor only
   * ever growing. What moves is the position in the PLAN — which was never the
   * cursor's to hold.
   *
   * Optional for the same reason as the fields above it: a run written before
   * this existed cannot say, and absent reads as "nothing owed was recorded",
   * never as "nothing is owed".
   */
  continuation?: FlowContinuation | null;
  /** The one preview the agent prepared before the route can be accepted. */
  route_proposal: RouteProposal | null;
  /** Human-approved dispositions; `null` means this v11 run has not accepted a route yet. */
  route_decisions: RouteDecision[] | null;
  /** Evidence quality is independent of whether the journey reached completion. */
  assurance: AssuranceStatus;
  /** Seal over every field above. */
  digest: string;
}

/** The plan position a decision's first unsettled obligation resumes at. */
export interface FlowContinuation {
  /** Where execution comes back, from the owed note's own resume point. */
  resume_point: string;
  /** The note that owes it. */
  by: string;
}

export type FlowRunRead =
  | { ok: true; state: FlowRunState }
  | { ok: false; failure: CapabilityFailure };

/** The state minus its own seal — exactly what {@link sealRunState} digests. */
function withoutSeal(state: FlowRunState): Omit<FlowRunState, "digest"> {
  const { digest: _seal, ...rest } = state;
  return rest;
}

export function sealRunState(state: Omit<FlowRunState, "digest">): FlowRunState {
  return { ...state, digest: semanticDigest(state) };
}

export function newRunState(flow: WorklineFlow, session: string): FlowRunState {
  return sealRunState({
    version: FLOW_RUN_STATE_VERSION,
    flow,
    session,
    scope: null,
    applied: [],
    skipped: [],
    boundary: null,
    pending_action: null,
    observations: [],
    events: [],
    authorizations: [],
    proposal: null,
    effects: { planned: [], approved: [], applied: [] },
    attempts: [],
    batches: [],
    batch_trace: [],
    batch_loop: { pending: true, iteration: 1 },
    handoff: null,
    selected_choice: null,
    decision_preparation: null,
    route_proposal: null,
    route_decisions: null,
    assurance: "verified",
  });
}

/**
 * Apply one transition, re-sealing the result.
 *
 * Pure on purpose: the atomic write is the service's job, and keeping the state
 * transition free of I/O is what makes "a failure halfway through leaves no
 * intermediate state applied" checkable — the next state either exists whole or
 * was never produced.
 */
export function applyTransition(
  state: FlowRunState,
  decisionId: string,
  effects: readonly EffectClass[] = [],
): FlowRunState {
  const applied = [...state.applied, decisionId];
  return sealRunState({
    ...withoutSeal(state),
    applied,
    assurance: assuranceForRoute(state.route_decisions ?? [], applied),
    // planned before applied, always: an effect that shows up as applied without
    // ever having been planned is the lie `buildReceipt` refuses, and the
    // directive refuses it too.
    effects: {
      planned: union(state.effects.planned, effects),
      approved: [...state.effects.approved],
      applied: union(state.effects.applied, effects),
    },
  });
}

/**
 * Pass over a conditional transition without applying it.
 *
 * The cursor advances — the journey is a sequence and the run has to leave the
 * step behind — but nothing else moves: no effect is planned, none is applied,
 * and the id lands in `skipped` so the trace can say the step was omitted rather
 * than decided. A skip that only advanced the cursor would be indistinguishable
 * from having applied it, which is the exact lie a conditional step invites.
 */
export function skipTransition(state: FlowRunState, decisionId: string): FlowRunState {
  return sealRunState({
    ...withoutSeal(state),
    applied: [...state.applied, decisionId],
    skipped: [...state.skipped, decisionId],
  });
}

/**
 * Pass over a boundary the run GAVE UP on, saying so in its own field.
 *
 * A degradation is a skip — the cursor has to leave the step behind — but it is
 * not the same fact, and the difference is the whole point: one says the
 * condition never fired, the other says the question was asked as often as it may
 * be and nobody resolved it. Recorded apart so a reader of the final state can
 * tell them without reconstructing the attempt history.
 */
export function degradeTransition(
  state: FlowRunState,
  decisionId: string,
  cause: string,
): FlowRunState {
  const skipped = skipTransition(state, decisionId);
  return sealRunState({
    ...withoutSeal(skipped),
    degraded: [...(state.degraded ?? []), { transition: decisionId, cause }],
  });
}

/**
 * Give a boundary back the attempts it spent — as a GRANT, never as a deletion.
 *
 * Recovery cannot lower the monotone counter: the counter is what makes restoring
 * an older ledger useless, and a recovery that decremented it would hand back the
 * same hole wearing a supported name. So what is recorded is how many attempts
 * were forgiven, which only ever grows; the effective count is the difference.
 * See {@link attemptsAt}.
 */
/**
 * Relabel the attempt chain so the ledger accepts it again — losing no row.
 *
 * The ledger validates ordinals per boundary SEAL: contiguous from 1, each row
 * linked to the digest of the one before it. A run whose chain was broken by an
 * older build of this very CLI — the recovery that rewound `attempts` and then
 * appended a duplicate — stays readable and keeps every fact worth keeping, but
 * every future submit dies on the replay. Renumbering is the smallest repair that
 * makes it answerable: the rows, their digests and their seals all survive in the
 * order they happened, and only the LABELS are made consistent with that order.
 *
 * It is not a way around the cap, which is the reason it is safe to do at all:
 * the monotone floor and the grants are untouched here, so what the boundary has
 * already spent is exactly what it spent before. And it is not a repair of a
 * TAMPERED ledger either — the seal is verified before anything gets this far.
 */
export function normalizeAttemptChain(state: FlowRunState): FlowRunState {
  const ordinal = new Map<string, number>();
  const previous = new Map<string, string>();
  const attempts = state.attempts.map((row) => {
    const next = (ordinal.get(row.invocation_id) ?? 0) + 1;
    ordinal.set(row.invocation_id, next);
    const parent = next === 1 ? null : (previous.get(row.invocation_id) ?? null);
    previous.set(row.invocation_id, row.request_digest);
    return { ...row, attempt: next, parent_request_digest: parent };
  });
  return sealRunState({ ...withoutSeal(state), attempts });
}

export function grantAttempts(
  state: FlowRunState,
  transition: string,
  attempts: number,
): FlowRunState {
  const granted = { ...(state.attempt_grants ?? {}) };
  const key = attemptCounterKey(state, transition);
  granted[key] = (granted[key] ?? 0) + attempts;
  return sealRunState({ ...withoutSeal(state), attempt_grants: granted });
}

/**
 * Explicitly adopt a readable legacy state into v10.
 *
 * This function is intentionally NOT called by the reader. Calling it is the
 * durable act of adoption after the caller has named the flow and accepted that
 * no pre-v10 batch is being reconstructed. Empty batch arrays mean exactly
 * "legacy history preserved; no v10 batch claimed", never "the old run had no
 * batches".
 */
export function atCurrentVersion(state: FlowRunState): FlowRunState {
  if (state.version === FLOW_RUN_STATE_VERSION) return state;
  return sealRunState({
    ...withoutSeal(state),
    version: FLOW_RUN_STATE_VERSION,
    batches: [],
    batch_trace: [],
    batch_loop: { pending: true, iteration: 1 },
    handoff: null,
    selected_choice: null,
    decision_preparation: null,
    route_proposal: null,
    route_decisions: null,
    assurance: "verified",
  });
}

/** Keep the sealed preview the person is choosing over; no cursor moves here. */
export function withRouteProposal(
  state: FlowRunState,
  proposal: RouteProposal | null,
): FlowRunState {
  return sealRunState({
    ...withoutSeal(state),
    route_proposal: proposal,
    route_decisions: null,
    assurance: "verified",
  });
}

/** Persist the accepted route and derive its assurance without claiming missing proof passed. */
export function withRouteDecisions(
  state: FlowRunState,
  decisions: readonly RouteDecision[],
): FlowRunState {
  return sealRunState({
    ...withoutSeal(state),
    route_decisions: [...decisions],
    assurance: assuranceForRoute(decisions, state.applied),
  });
}

/** Whether a parsed state needs the explicit adoption boundary before mutation. */
export function legacyRunNeedsAdoption(state: FlowRunState): boolean {
  return state.version !== FLOW_RUN_STATE_VERSION;
}

/** Record one inferred or declared batch, refusing duplicate ids at the caller's boundary. */
export function withPlanExecBatch(state: FlowRunState, batch: PlanExecBatch): FlowRunState {
  const batches = state.batches ?? [];
  if (batches.some((current) => current.id === batch.id)) return state;
  const trace = state.batch_trace ?? [];
  return sealRunState({
    ...withoutSeal(state),
    batches: [...batches, batch],
    batch_trace: [
      ...trace,
      {
        sequence: trace.length + 1,
        batch_id: batch.id,
        iteration: batch.iteration,
        stage: "inferred",
        transition: "plan-exec.batch-inference",
        kind: "entered",
      },
    ],
  });
}

/** Advance one batch phase and append the evidence row in the same sealed state. */
export function withPlanExecBatchStage(
  state: FlowRunState,
  batchId: string,
  stage: PlanExecBatchStage,
  transition: string,
  kind: PlanExecBatchTrace["kind"] = "completed",
): FlowRunState {
  const batches = state.batches ?? [];
  const index = batches.findIndex((batch) => batch.id === batchId);
  if (index < 0) return state;
  const current = batches[index];
  if (current === undefined) return state;
  const nextBatches = [...batches];
  nextBatches[index] = { ...current, stage };
  const trace = state.batch_trace ?? [];
  const entry: PlanExecBatchTrace = {
    sequence: trace.length + 1,
    batch_id: current.id,
    iteration: current.iteration,
    stage,
    transition,
    kind,
  };
  return sealRunState({
    ...withoutSeal(state),
    batches: nextBatches,
    batch_trace: [...trace, entry],
  });
}

/**
 * Record the lifecycle evidence a real PLAN-exec boundary just crossed.
 *
 * The batch itself is sealed at `batch-inference`, before implementation. Later
 * transitions do not re-infer it; they only append the stage that the cursor
 * actually reached. The small mapping lives beside the state shape so CLI walks,
 * submitted execution results and internal actions cannot drift into three
 * different notions of "the current batch".
 */
const PLAN_EXEC_BATCH_STAGE_BY_TRANSITION: Readonly<Record<string, PlanExecBatchStage>> = {
  "plan-exec.batch-isolation": "isolated",
  "plan-exec.implementation": "implementing",
  "plan-exec.deviation-recognition": "deviation",
  "plan-exec.validation-execution": "validating",
  "plan-exec.review-findings": "reviewing",
  // These only occur after the final batch publication. They therefore extend
  // the last closed batch's trace instead of fabricating a new one for Git/done.
  "plan-exec.final-validation": "validating",
  "plan-exec.commit-execution": "committing",
  "plan-exec.unit-integration": "integrating",
  "plan-exec.plan-done": "done",
};

const PLAN_EXEC_TERMINAL_BATCH_TRANSITIONS = new Set<string>([
  "plan-exec.final-validation",
  "plan-exec.commit-execution",
  "plan-exec.unit-integration",
  "plan-exec.plan-done",
]);

/** Append the stage for a crossed batch boundary, if that boundary owns one. */
export function withPlanExecBatchStageForTransition(
  state: FlowRunState,
  transition: string,
): FlowRunState {
  if (state.flow !== "plan-exec") return state;
  const stage = PLAN_EXEC_BATCH_STAGE_BY_TRANSITION[transition];
  if (stage === undefined) return state;
  const reverse = [...(state.batches ?? [])].reverse();
  const current = PLAN_EXEC_TERMINAL_BATCH_TRANSITIONS.has(transition)
    ? reverse.find((batch) => batch.published_plan_digest !== undefined)
    : reverse.find((batch) => batch.published_plan_digest === undefined);
  if (current === undefined) return state;
  const last = state.batch_trace?.at(-1);
  if (current.stage === stage && last?.batch_id === current.id && last.transition === transition) {
    return state;
  }
  return withPlanExecBatchStage(state, current.id, stage, transition, "completed");
}

/**
 * Seal whether the just-published batch opens another iteration.
 *
 * The final document bytes, not an agent assertion, decide this field.  Keeping
 * it in the same state publication as the `closed` trace makes a crash recover
 * to one exact cursor shape.
 */
export function withPlanExecBatchLoop(state: FlowRunState, loop: PlanExecBatchLoop): FlowRunState {
  const current = state.batch_loop;
  if (current?.pending === loop.pending && current?.iteration === loop.iteration) return state;
  return sealRunState({ ...withoutSeal(state), batch_loop: loop });
}

/**
 * The iteration identity for a transition in the repeatable PLAN-exec segment.
 *
 * Prefix/tail rows deliberately return `null`: they run once per flow and keep
 * their historical retry/observation identity.  The loop field is absent on an
 * older v10 state, in which case preserving its old unscoped accounting is safer
 * than pretending we know which historical batch it belonged to.
 */
export function currentBatchIteration(
  state: Pick<FlowRunState, "flow" | "batch_loop">,
  transition: string,
): number | null {
  if (state.flow !== "plan-exec" || !PLAN_EXEC_BATCH_LOOP_TRANSITIONS.has(transition)) return null;
  const loop = state.batch_loop;
  return loop?.pending === true && loop.iteration !== null ? loop.iteration : null;
}

/** The rows that repeat between batch closures; kept local to the state contract. */
export const PLAN_EXEC_BATCH_LOOP_TRANSITIONS = new Set<string>([
  "plan-exec.batch-eligibility-signal",
  "plan-exec.batch-inference",
  "plan-exec.batch-isolation",
  "plan-exec.design-precondition",
  "plan-exec.unit-acquisition",
  "plan-exec.branch-precondition",
  "plan-exec.implementation",
  "plan-exec.deviation-recognition",
  "plan-exec.deviation-eligibility",
  "plan-exec.deviation-gate",
  "plan-exec.escalation-package",
  "plan-exec.validation-execution",
  "plan-exec.deferred-check",
  "plan-exec.review-findings",
  "plan-exec.batch-close",
]);

/** Seal the plan bytes the batch publication actually produced. */
export function withPlanExecBatchPublication(
  state: FlowRunState,
  batchId: string,
  publishedPlanDigest: string,
): FlowRunState {
  const batches = state.batches ?? [];
  const index = batches.findIndex((batch) => batch.id === batchId);
  if (index < 0) return state;
  const current = batches[index];
  if (current === undefined) return state;
  const next = [...batches];
  const publication =
    current.publication === undefined
      ? {}
      : {
          publication: {
            ...current.publication,
            after_plan_digest: publishedPlanDigest,
            status: "applied" as const,
          },
        };
  next[index] = {
    ...current,
    published_plan_digest: publishedPlanDigest,
    ...publication,
  };
  return sealRunState({ ...withoutSeal(state), batches: next });
}

/** Seal the exact before/after pair before the plan document is touched. */
export function withPlanExecBatchPublicationPrepared(
  state: FlowRunState,
  batchId: string,
  publication: Omit<PlanExecBatchPublication, "status">,
): FlowRunState {
  const batches = state.batches ?? [];
  const index = batches.findIndex((batch) => batch.id === batchId);
  if (index < 0) return state;
  const current = batches[index];
  if (current === undefined) return state;
  const next = [...batches];
  next[index] = { ...current, publication: { ...publication, status: "prepared" } };
  return sealRunState({ ...withoutSeal(state), batches: next });
}

/** Persist a selected handoff; the advancement engine then refuses to continue this run. */
export function withHandoff(state: FlowRunState, handoff: FlowHandoff | null): FlowRunState {
  return sealRunState({ ...withoutSeal(state), handoff });
}

/** Persist the gate's executable consequence before the run leaves that boundary. */
export function withSelectedChoice(
  state: FlowRunState,
  selected: FlowChoiceSelection | null,
): FlowRunState {
  return sealRunState({ ...withoutSeal(state), selected_choice: selected });
}

/** Persist or clear the exact decision view offered at the human gate. */
export function withDecisionPreparation(
  state: FlowRunState,
  preparation: FlowDecisionPreparation | null,
): FlowRunState {
  return sealRunState({ ...withoutSeal(state), decision_preparation: preparation });
}

/**
 * Persist the declared fix preview, so the boundary that approves it can show it.
 *
 * The mirror of {@link withDecisionPreparation}, with one difference that is the
 * whole point of the field being optional: this is only ever called with a
 * preview. A run that declared none keeps the key ABSENT — writing `null` would
 * add a field to the sealed record and move the digest of every run that never
 * used it.
 */
export function withFixPreview(state: FlowRunState, preview: FlowFixPreview): FlowRunState {
  return sealRunState({ ...withoutSeal(state), fix_preview: preview });
}

/**
 * Reconcile the state with the monotone counter that lives outside its seal.
 *
 * The only writer of both maps, so "the sidecar is the authority and the state is
 * its cache" is one statement in one place. An empty map is written as ABSENT
 * rather than as `{}`: a run that never spent an attempt keeps the exact bytes it
 * had before this field existed, which is what makes the change readable in both
 * directions instead of a silent format break.
 */
export function withAttemptCounters(
  state: FlowRunState,
  counters: { floor: Record<string, number>; grants: Record<string, number> },
): FlowRunState {
  const floor = emptyToAbsent(counters.floor);
  const grants = emptyToAbsent(counters.grants);
  const { attempt_floor: _floor, attempt_grants: _granted, ...rest } = withoutSeal(state);
  return sealRunState({
    ...rest,
    ...(floor === undefined ? {} : { attempt_floor: floor }),
    ...(grants === undefined ? {} : { attempt_grants: grants }),
  });
}

function emptyToAbsent(counter: Record<string, number>): Record<string, number> | undefined {
  const entries = Object.entries(counter).filter(([, count]) => count > 0);
  return entries.length === 0 ? undefined : Object.fromEntries(entries);
}

/** Move the boundary to where the walk stopped, applying nothing. */
export function withBoundary(state: FlowRunState, boundary: string | null): FlowRunState {
  return sealRunState({ ...withoutSeal(state), boundary });
}

/**
 * Record — or clear — the delegated action the run is waiting on.
 *
 * Clearing is as load-bearing as setting: a run that moved past an execution
 * boundary and kept the old pending action would tell whoever resumes it to run
 * something the engine no longer expects.
 */
export function withPendingAction(
  state: FlowRunState,
  pending: Omit<FlowPendingAction, "attempted"> | null,
): FlowRunState {
  // Re-emitting the SAME action must not forget that it was already begun. Every
  // advance recomputes the boundary, so a caller that came back after a crash
  // passes through here before the re-entry is decided — and a mark reset on the
  // way in would make the run look untouched at exactly the moment it is not.
  const current = state.pending_action;
  const attempted =
    pending !== null &&
    current !== null &&
    current.transition === pending.transition &&
    current.digest === pending.digest &&
    current.attempted;
  return sealRunState({
    ...withoutSeal(state),
    pending_action: pending === null ? null : { ...pending, attempted },
  });
}

/**
 * Mark the pending action as begun, in its own write, BEFORE anything happens.
 *
 * Separate from {@link withPendingAction} on purpose: emitting a boundary and
 * starting to materialize it are two moments, and collapsing them would record
 * the intent at a time when nothing has yet been risked — which is precisely when
 * the mark is worthless. Recording it afterwards is worse: the crash it exists to
 * survive happens in between.
 */
export function withActionAttempted(state: FlowRunState): FlowRunState {
  const pending = state.pending_action;
  if (pending === null || pending.attempted) return state;
  return sealRunState({
    ...withoutSeal(state),
    pending_action: { ...pending, attempted: true },
  });
}

/** Append one material event to the run's trace, re-sealing the result. */
export function withEvent(state: FlowRunState, event: FlowRunEvent): FlowRunState {
  return sealRunState({ ...withoutSeal(state), events: [...state.events, event] });
}

/**
 * Whether appending this failure would only restate the one already there.
 *
 * The same failure, still standing, is ONE fact: re-running a broken action or
 * re-sending the same refused result reaches the identical verdict, and
 * appending it every time would turn the trace into a retry counter — which is
 * what the attempt history is for. Both producers of a failure event ask here,
 * so the internal driver and an external result cannot disagree about it.
 */
export function restatesLastEvent(state: FlowRunState, event: FlowRunEvent): boolean {
  const last = state.events.at(-1);
  if (last === undefined || last.kind !== "failed" || event.kind !== "failed") return false;
  return (
    last.transition === event.transition &&
    last.batch_iteration === event.batch_iteration &&
    last.code === event.code &&
    last.message === event.message
  );
}

/**
 * Keep a validated observation for the rule that consumes it later.
 *
 * Observations ACCUMULATE. They used to replace the previous one for the same
 * transition, and that silently lost findings: a run that recognises a second
 * divergence overwrote the first, so a gate meant to carry every declaration
 * forward could only ever remember the last one. Thresholds are unaffected —
 * `thresholdFired` already unions the signals of every observation of a
 * transition and counts them DISTINCT — so accumulating changes what is
 * remembered without changing what fires.
 *
 * An exact repeat is not appended: re-answering a boundary with the same signals
 * is one observation sent twice, and letting it pile up would turn the trace
 * into a retry counter, which is what the attempt history is for.
 */
export function withObservation(state: FlowRunState, observation: FlowObservation): FlowRunState {
  const repeated = state.observations.some(
    (past) =>
      past.transition === observation.transition &&
      past.batch_iteration === observation.batch_iteration &&
      sameSignals(past.signals, observation.signals),
  );
  if (repeated) return state;
  return sealRunState({
    ...withoutSeal(state),
    observations: [...state.observations, observation],
  });
}

/**
 * Point the run at the first thing a decision still owes — or clear it.
 *
 * It takes the whole reconciliation and not a bare point on purpose. The rule is
 * "the FIRST new or pending obligation reached", and that is a fact about the
 * entire effective contract: a second note handed its own resume point would
 * move the run FORWARD, stepping over work an earlier decision is still owed. By
 * reading the projection, settling everything clears the continuation on its own
 * and there is no separate "we are done" call anybody can forget to make.
 */
export function withContinuation(
  state: FlowRunState,
  reconciliation: PlanReconciliation,
): FlowRunState {
  const first = reconciliation.pending[0];
  if (first === undefined) return consumeContinuation(state);
  const held = state.continuation ?? null;
  if (held !== null && held.by === first.by && held.resume_point === first.resume_point) {
    return state;
  }
  return sealRunState({
    ...withoutSeal(state),
    continuation: { resume_point: first.resume_point, by: first.by },
  });
}

/** Record that the run reached the point it was sent back to. */
export function consumeContinuation(state: FlowRunState): FlowRunState {
  if ((state.continuation ?? null) === null) return state;
  return sealRunState({ ...withoutSeal(state), continuation: null });
}

function sameSignals(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const left = [...a].sort();
  const right = [...b].sort();
  return left.every((signal, index) => signal === right[index]);
}

/** Record one attempt in the persisted history, re-sealing the result. */
export function withAttempt(state: FlowRunState, attempt: FlowRunAttempt): FlowRunState {
  return sealRunState({ ...withoutSeal(state), attempts: [...state.attempts, attempt] });
}

/**
 * Grant the run an authorization the person just gave, over its exact seal.
 *
 * The classes land in the ledger's `approved` moment too — the same split the
 * capability contract already makes between the request's authorizations and the
 * receipt's approved effects. What changed is the first half: the run no longer
 * holds a bare class, it holds a grant that names what it was given over, so a
 * later transition with a different seal is not covered by it.
 *
 * Re-granting the same seal REPLACES rather than accumulates: an approval given
 * twice over the identical proposal is one approval, and a list that grew each
 * time would make "how wide is this grant" depend on how many times somebody
 * retried.
 */
export function withApproval(state: FlowRunState, grant: EffectGrant): FlowRunState {
  return sealRunState({
    ...withoutSeal(state),
    authorizations: [...state.authorizations.filter((held) => held.digest !== grant.digest), grant],
    effects: {
      planned: union(state.effects.planned, grant.classes),
      approved: union(state.effects.approved, grant.classes),
      applied: [...state.effects.applied],
    },
  });
}

/**
 * Fix what this run isolates, once.
 *
 * REPLACES rather than merges, and the boundary that produces it is answered
 * once per run: a scope that grew by accumulation would let a later answer widen
 * what the units — and every branch and commit reading built on them — cover,
 * which is the silent scope expansion the whole isolation model exists to stop.
 */
export function withScope(state: FlowRunState, scope: FlowRunScope): FlowRunState {
  return sealRunState({ ...withoutSeal(state), scope });
}

/**
 * Seat the exact local change awaiting its decision, or clear it.
 *
 * Cleared after it is published — and that is not housekeeping: a proposal left
 * standing after its bytes landed would be a preview of a change that is already
 * on disk, and the next boundary that asks "is there something to approve?" would
 * answer yes about the past.
 */
export function withProposal(state: FlowRunState, proposal: LocalProposal | null): FlowRunState {
  return sealRunState({ ...withoutSeal(state), proposal });
}

function union(current: readonly EffectClass[], added: readonly EffectClass[]): EffectClass[] {
  return [...new Set([...current, ...added])];
}

/**
 * Parse a persisted state, refusing anything that cannot be trusted.
 *
 * Order matters: shape before version before seal. A file whose version is
 * unknown must not be judged by a digest rule that version may not even use.
 */
export function parseRunState(raw: string): FlowRunRead {
  if (raw.trim().length === 0) {
    return refuse(
      "FLOW_RUN_INVALID",
      "el estado de corrida está vacío",
      "reconstruí la corrida con 'aw flow advance --adopt', o restaurá el archivo",
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return refuse(
      "FLOW_RUN_INVALID",
      "el estado de corrida no es JSON válido",
      "no se avanza sobre un estado ilegible: restauralo o re-adoptá la sesión con 'aw flow advance --adopt'",
    );
  }
  if (!isRecord(parsed)) {
    return refuse(
      "FLOW_RUN_INVALID",
      "el estado de corrida no es un objeto JSON",
      "restauralo o re-adoptá la sesión con 'aw flow advance --adopt'",
    );
  }
  if (!FLOW_RUN_STATE_READABLE.includes(parsed.version as number)) {
    // No silent migration, in either direction: a version outside the readable
    // set either predates fields the engine now reads — and inventing them would
    // fabricate the very history this file exists to make trustworthy — or comes
    // from a build ahead of this one, whose fields this build would ignore.
    // Refusing with the cause is what keeps the second case from being silent.
    return refuse(
      "FLOW_RUN_VERSION_UNSUPPORTED",
      `versión de estado de corrida no soportada: ${String(parsed.version)}`,
      `esta versión del CLI lee ${FLOW_RUN_STATE_READABLE.join(" y ")} y escribe la ${FLOW_RUN_STATE_VERSION}: actualizá el CLI, o re-adoptá la sesión con 'aw flow advance --flow <flow> --adopt' (no hay migración automática)`,
    );
  }
  const shape = checkShape(parsed);
  if (shape !== null) return { ok: false, failure: shape };

  const state = parsed as unknown as FlowRunState;
  if (semanticDigest(withoutSeal(state)) !== state.digest) {
    return refuse(
      "FLOW_RUN_TAMPERED",
      "el estado de corrida no coincide con su propio sello",
      "fue editado fuera del CLI: descartá el archivo y re-adoptá la sesión con 'aw flow advance --adopt'",
    );
  }
  return { ok: true, state };
}

export function serializeRunState(state: FlowRunState): string {
  return `${canonicalJson(state)}\n`;
}

/**
 * Whether the persisted state is coherent with the journey it claims to walk.
 *
 * A state can be well-formed and sealed and still be AHEAD of the journey — it
 * names transitions this build does not know, or in an order the journey does
 * not have. Advancing over it would apply transitions on top of a history
 * nobody can reproduce, so it is refused with the same fail-closed rule.
 */
export function checkAgainstJourney(
  state: FlowRunState,
  journey: readonly FlowDecision[],
): CapabilityFailure | null {
  const ids = journey.map((decision) => decision.id);
  for (const [index, applied] of state.applied.entries()) {
    if (ids[index] === applied) continue;
    return {
      code: "FLOW_RUN_AHEAD_OF_JOURNEY",
      message: `el estado dice haber aplicado '${applied}' donde el recorrido tiene '${ids[index] ?? "(nada)"}'`,
      action:
        "el estado no corresponde a este recorrido: revisá el flow de la corrida o re-adoptá la sesión",
    };
  }
  const next = ids[state.applied.length] ?? null;
  if (state.boundary !== null && state.boundary !== next) {
    return {
      code: "FLOW_RUN_AHEAD_OF_JOURNEY",
      message: `la frontera vigente dice '${state.boundary}' y el recorrido sigue en '${next ?? "(nada)"}'`,
      action:
        "recalculá la frontera avanzando de nuevo; no se responde sobre una frontera que el estado no sostiene",
    };
  }
  return null;
}

function checkShape(parsed: Record<string, unknown>): CapabilityFailure | null {
  const invalid = (why: string): CapabilityFailure => ({
    code: "FLOW_RUN_INVALID",
    message: `el estado de corrida ${why}`,
    action: "restauralo o re-adoptá la sesión con 'aw flow advance --adopt'",
  });

  if (!(WORKLINE_FLOWS as readonly unknown[]).includes(parsed.flow)) {
    return invalid(`declara un flow desconocido: ${String(parsed.flow)}`);
  }
  if (typeof parsed.session !== "string" || parsed.session.trim().length === 0) {
    return invalid("no dice a qué sesión pertenece");
  }
  if (!isScope(parsed.scope)) {
    return invalid("declara un scope sin su plan o sin ninguna fuente");
  }
  const applied = parsed.applied;
  if (!isStringArray(applied)) return invalid("no trae la lista de transiciones aplicadas");
  if (!isStringArray(parsed.skipped)) return invalid("no trae la lista de transiciones omitidas");
  if (parsed.skipped.some((id) => !applied.includes(id))) {
    return invalid("declara una transición omitida que el recorrido nunca pasó");
  }
  if (parsed.boundary !== null && typeof parsed.boundary !== "string") {
    return invalid("declara una frontera que no es un identificador");
  }
  return checkRecordShape(parsed, invalid);
}

/**
 * The half of the shape that is records rather than the cursor.
 *
 * Split from {@link checkShape} only so each half stays readable; the order is
 * still the contract — every one of these is refused before the seal is judged,
 * because a file whose fields cannot be trusted must not be graded on whether its
 * digest matches.
 */
function checkRecordShape(
  parsed: Record<string, unknown>,
  invalid: (why: string) => CapabilityFailure,
): CapabilityFailure | null {
  const common = checkCommonRecordShape(parsed, invalid);
  if (common !== null) return common;
  if (parsed.version === FLOW_RUN_STATE_VERSION || parsed.version === 10) {
    const v10 = checkV10RecordShape(parsed, invalid);
    if (v10 !== null) return v10;
  }
  if (parsed.version === FLOW_RUN_STATE_VERSION) {
    const v11 = checkV11RecordShape(parsed, invalid);
    if (v11 !== null) return v11;
  }
  if (typeof parsed.digest !== "string") return invalid("no trae su sello");
  return null;
}

/** Record fields shared by every readable flow-run version, in refusal order. */
function checkCommonRecordShape(
  parsed: Record<string, unknown>,
  invalid: (why: string) => CapabilityFailure,
): CapabilityFailure | null {
  if (!isPendingAction(parsed.pending_action)) {
    return invalid("declara una acción pendiente sin transición o sin sello");
  }
  if (!isObservationArray(parsed.observations)) {
    return invalid("trae observaciones que no son señales declaradas por transición");
  }
  if (!isEventArray(parsed.events)) {
    return invalid("trae una traza material con un evento incompleto");
  }
  if (!isGrantArray(parsed.authorizations)) {
    return invalid("declara una autorización sin el sello sobre el que fue otorgada");
  }
  if (!isProposal(parsed.proposal)) {
    return invalid("declara una propuesta local sin sus bytes, sus destinos o su sello");
  }
  if (!isEffectLedger(parsed.effects)) return invalid("no trae el registro de efectos completo");
  if (!isAttemptArray(parsed.attempts)) return invalid("trae un historial de intentos inválido");
  if (!isDegradationArray(parsed.degraded)) {
    return invalid("declara una degradación sin transición o sin causa");
  }
  // A degradation is a skip that says why: one recorded over a step the run never
  // passed over would be a claim about a boundary it is still standing on.
  const skipped = parsed.skipped as string[];
  if ((parsed.degraded ?? []).some((entry) => !skipped.includes(entry.transition))) {
    return invalid("declara degradada una transición que el recorrido nunca pasó por alto");
  }
  if (!isCounterMap(parsed.attempt_floor) || !isCounterMap(parsed.attempt_grants)) {
    return invalid("trae una contabilidad de intentos que no es un contador por transición");
  }
  return null;
}

/** Fields added by v10 that have no truthful default on a persisted run. */
function checkV10RecordShape(
  parsed: Record<string, unknown>,
  invalid: (why: string) => CapabilityFailure,
): CapabilityFailure | null {
  if (!isPlanExecBatchArray(parsed.batches)) {
    return invalid("no trae batches v10 con fases, tareas y sello de plan");
  }
  if (!isPlanExecBatchTraceArray(parsed.batch_trace, parsed.batches)) {
    return invalid(
      "trae una traza de batches que no es append-only ni corresponde a sus iteraciones",
    );
  }
  if (!isPlanExecBatchLoop(parsed.batch_loop)) {
    return invalid("declara un ciclo de batches sin su próxima iteración sellada");
  }
  if (!isHandoff(parsed.handoff)) {
    return invalid("declara una entrega de flow sin destino, comando o sello de paquete");
  }
  if (!isSelectedChoice(parsed.selected_choice)) {
    return invalid("declara una consecuencia elegida sin frontera, etiqueta o ruta válida");
  }
  if (!isDecisionPreparation(parsed.decision_preparation)) {
    return invalid("declara una vista de decisión sin nota, preview o linaje sellados");
  }
  if (!isFixPreview(parsed.fix_preview)) {
    return invalid("declara un preview de arreglo sin archivos, intención o forma del diff");
  }
  return null;
}

/** Fields introduced by v11; v10 remains readable until a person adopts it. */
function checkV11RecordShape(
  parsed: Record<string, unknown>,
  invalid: (why: string) => CapabilityFailure,
): CapabilityFailure | null {
  if (!isRouteProposal(parsed.route_proposal)) {
    return invalid("declara una propuesta de solución con resumen, contexto o controles inválidos");
  }
  if (!isRouteDecisionArray(parsed.route_decisions)) {
    return invalid("declara decisiones de la propuesta sin una disposición o sustitución válida");
  }
  if (!isAssuranceStatus(parsed.assurance)) {
    return invalid("declara un assurance que no representa su evidencia");
  }
  const decisions = parsed.route_decisions;
  if (decisions !== null && parsed.assurance !== assuranceForRoute(decisions as RouteDecision[])) {
    return invalid("declara un assurance que no corresponde a su ruta aceptada");
  }
  return null;
}

function refuse(code: string, message: string, action: string): FlowRunRead {
  return { ok: false, failure: { code, message, action } };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isRouteSubstitution(value: unknown): value is RouteSubstitution {
  return isRecord(value) && isNonEmptyString(value.validation) && isNonEmptyString(value.risk);
}

function isRouteProposal(value: unknown): value is RouteProposal | null {
  if (value === null) return true;
  if (!isRecord(value) || !isRecord(value.basis) || !Array.isArray(value.controls)) return false;
  if (
    value.summary !== undefined &&
    (!isRecord(value.summary) ||
      !isNonEmptyString(value.summary.finding) ||
      !isNonEmptyString(value.summary.diagnosis) ||
      !isNonEmptyString(value.summary.solution))
  ) {
    return false;
  }
  if (
    !isNonEmptyString(value.basis.intention) ||
    !isNonEmptyString(value.basis.checkout) ||
    !isNonEmptyString(value.basis.conventions) ||
    !isNonEmptyString(value.basis.adopted_decisions)
  ) {
    return false;
  }
  const transitions = new Set<string>();
  return value.controls.every((control) => {
    if (
      !isRecord(control) ||
      !isNonEmptyString(control.transition) ||
      transitions.has(control.transition)
    ) {
      return false;
    }
    transitions.add(control.transition);
    if (
      !isNonEmptyString(control.title) ||
      !isRouteDisposition(control.disposition) ||
      !isRouteDisposition(control.recommendation) ||
      !isRecord(control.alternatives) ||
      !isNonEmptyString(control.alternatives.apply) ||
      !isNonEmptyString(control.alternatives.omit) ||
      !isNonEmptyString(control.alternatives.substitute) ||
      !isNonEmptyString(control.consequence) ||
      !isNonEmptyString(control.risk) ||
      !isNonEmptyString(control.reason)
    ) {
      return false;
    }
    if (control.disposition === "substitute") return isRouteSubstitution(control.substitution);
    return control.substitution === null;
  });
}

function isRouteDecisionArray(value: unknown): value is RouteDecision[] | null {
  if (value === null) return true;
  if (!Array.isArray(value)) return false;
  const transitions = new Set<string>();
  return value.every((decision) => {
    if (
      !isRecord(decision) ||
      !isNonEmptyString(decision.transition) ||
      transitions.has(decision.transition) ||
      !isRouteDisposition(decision.disposition)
    ) {
      return false;
    }
    transitions.add(decision.transition);
    if (decision.disposition === "substitute") return isRouteSubstitution(decision.substitution);
    return decision.substitution === null;
  });
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function isEffectClassArray(value: unknown): value is EffectClass[] {
  return Array.isArray(value) && value.every(isEffectClass);
}

/**
 * A grant is only trustworthy if it says what it was given OVER.
 *
 * The seal is the field that makes it scoped, so a persisted grant without one is
 * exactly the old class-only authorization wearing a new name — refused rather
 * than read as covering everything.
 */
function isGrantArray(value: unknown): value is EffectGrant[] {
  if (!Array.isArray(value)) return false;
  return value.every(
    (entry) =>
      isRecord(entry) &&
      typeof entry.digest === "string" &&
      entry.digest.length > 0 &&
      isStringArray(entry.destinations) &&
      isEffectClassArray(entry.classes),
  );
}

/**
 * A scope is only trustworthy if it names BOTH halves.
 *
 * An empty `sources` is refused here rather than at the boundary alone: the file
 * outlives the invocation that wrote it, and a run resumed with an empty scope
 * would acquire no unit and then read branches and commits off nothing at all.
 */
function isScope(value: unknown): value is FlowRunScope | null {
  if (value === null) return true;
  if (!isRecord(value)) return false;
  if (typeof value.plan !== "string" || value.plan.trim().length === 0) return false;
  if (!isStringArray(value.sources) || value.sources.length === 0) return false;
  return value.sources.every((alias) => alias.trim().length > 0);
}

function isPlanExecBatchArray(value: unknown): value is PlanExecBatch[] {
  if (!Array.isArray(value)) return false;
  const ids = new Set<string>();
  const iterations = new Set<number>();
  return value.every((entry) => {
    if (!isRecord(entry)) return false;
    if (
      typeof entry.id !== "string" ||
      entry.id.trim().length === 0 ||
      ids.has(entry.id) ||
      typeof entry.iteration !== "number" ||
      !Number.isInteger(entry.iteration) ||
      entry.iteration < 1 ||
      iterations.has(entry.iteration) ||
      (entry.mode !== "continuous" && entry.mode !== "isolated") ||
      !Array.isArray(entry.phases) ||
      entry.phases.length === 0 ||
      !entry.phases.every(
        (phase) => typeof phase === "number" && Number.isInteger(phase) && phase > 0,
      ) ||
      !isStringArray(entry.tasks) ||
      entry.tasks.length === 0 ||
      new Set(entry.tasks).size !== entry.tasks.length ||
      typeof entry.plan_digest !== "string" ||
      entry.plan_digest.length === 0 ||
      (entry.published_plan_digest !== undefined &&
        (typeof entry.published_plan_digest !== "string" ||
          entry.published_plan_digest.length === 0)) ||
      !isPlanExecBatchPublication(entry.publication) ||
      (entry.publication !== undefined &&
        entry.publication.status === "applied" &&
        entry.published_plan_digest !== entry.publication.after_plan_digest) ||
      !(PLAN_EXEC_BATCH_STAGES as readonly string[]).includes(entry.stage as string)
    ) {
      return false;
    }
    ids.add(entry.id);
    iterations.add(entry.iteration);
    return true;
  });
}

function isPlanExecBatchPublication(value: unknown): value is PlanExecBatchPublication | undefined {
  if (value === undefined) return true;
  return (
    isRecord(value) &&
    typeof value.plan === "string" &&
    value.plan.trim().length > 0 &&
    typeof value.before_plan_digest === "string" &&
    value.before_plan_digest.length > 0 &&
    typeof value.after_plan_digest === "string" &&
    value.after_plan_digest.length > 0 &&
    typeof value.transition === "string" &&
    value.transition.length > 0 &&
    (value.status === "prepared" || value.status === "applied")
  );
}

/** Absent is only the compatibility reading of a v10 file written before the loop cursor. */
function isPlanExecBatchLoop(value: unknown): value is PlanExecBatchLoop | undefined {
  if (value === undefined) return true;
  if (!isRecord(value) || typeof value.pending !== "boolean") return false;
  if (value.pending) return Number.isInteger(value.iteration) && (value.iteration as number) >= 1;
  return value.iteration === null;
}

function isPlanExecBatchTraceArray(
  value: unknown,
  batches: unknown,
): value is PlanExecBatchTrace[] {
  if (!Array.isArray(value) || !Array.isArray(batches)) return false;
  const byId = new Map(
    (batches as PlanExecBatch[]).map((batch) => [batch.id, batch.iteration] as const),
  );
  return value.every((entry, index) => {
    if (!isRecord(entry)) return false;
    return (
      entry.sequence === index + 1 &&
      typeof entry.batch_id === "string" &&
      byId.get(entry.batch_id) === entry.iteration &&
      typeof entry.iteration === "number" &&
      Number.isInteger(entry.iteration) &&
      typeof entry.transition === "string" &&
      entry.transition.length > 0 &&
      (PLAN_EXEC_BATCH_STAGES as readonly string[]).includes(entry.stage as string) &&
      (entry.kind === "entered" || entry.kind === "completed" || entry.kind === "blocked")
    );
  });
}

function isHandoff(value: unknown): value is FlowHandoff | null {
  if (value === null) return true;
  if (!isRecord(value)) return false;
  return (
    (value.destination === "plan-refine" ||
      value.destination === "spec-refine" ||
      value.destination === "spec-new") &&
    typeof value.command === "string" &&
    value.command.trim().length > 0 &&
    isEscalationPackage(value.package) &&
    typeof value.package_digest === "string" &&
    value.package_digest === semanticDigest(value.package)
  );
}

function isEscalationPackage(value: unknown): value is FlowEscalationPackage {
  return (
    isRecord(value) &&
    (value.plan === null || (typeof value.plan === "string" && value.plan.trim().length > 0)) &&
    isObservationArray(value.observations) &&
    isRecord(value.decisions) &&
    isJsonValue(value.decisions) &&
    typeof value.selection === "string" &&
    value.selection.trim().length > 0
  );
}

function isJsonValue(value: unknown): boolean {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  return isRecord(value) && Object.values(value).every(isJsonValue);
}

function isSelectedChoice(value: unknown): value is FlowChoiceSelection | null {
  if (value === null) return true;
  if (!isRecord(value) || typeof value.transition !== "string" || typeof value.label !== "string") {
    return false;
  }
  if (!isRecord(value.outcome)) return false;
  return (
    value.outcome.kind === "register-decision" ||
    (value.outcome.kind === "handoff" &&
      (value.outcome.destination === "plan-refine" ||
        value.outcome.destination === "spec-refine" ||
        value.outcome.destination === "spec-new"))
  );
}

/** A v10 file written before preview persistence may omit this field. */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: each discriminant validates one durable preparation variant.
function isDecisionPreparation(
  value: unknown,
): value is FlowDecisionPreparation | null | undefined {
  if (value === undefined || value === null) return true;
  if (!isRecord(value) || typeof value.kind !== "string") return false;
  if (value.kind === "settled")
    return typeof value.decision === "string" && value.decision.trim().length > 0;
  if (value.kind === "reused") {
    return (
      typeof value.note === "string" &&
      value.note.trim().length > 0 &&
      typeof value.decision === "string" &&
      value.decision.trim().length > 0 &&
      typeof value.resume_point === "string" &&
      value.resume_point.trim().length > 0
    );
  }
  // The standalone variant is the whole record, so both halves are demanded:
  // a decision nobody can read, or one with nowhere to resume from, is not a
  // decision the run may carry past its gate.
  if (value.kind === "standalone") {
    return (
      typeof value.decision === "string" &&
      value.decision.trim().length > 0 &&
      typeof value.resume_point === "string" &&
      value.resume_point.trim().length > 0
    );
  }
  if (value.kind !== "prepared" || !isRecord(value.baseline)) return false;
  const baseline = value.baseline;
  if (
    typeof baseline.path !== "string" ||
    baseline.path.trim().length === 0 ||
    typeof baseline.number !== "string" ||
    baseline.number.trim().length === 0 ||
    typeof baseline.digest !== "string" ||
    baseline.digest.trim().length === 0 ||
    !isStringArray(baseline.criteria) ||
    typeof value.index_path !== "string" ||
    value.index_path.trim().length === 0
  ) {
    return false;
  }
  const checkedBaseline = {
    path: baseline.path as string,
    number: baseline.number as string,
    digest: baseline.digest as string,
  };
  const note = validateDecisionNote(value.note);
  if (!note.ok || note.value === null) return false;
  if (
    note.value.lineage.spec.path !== checkedBaseline.path ||
    note.value.lineage.spec.number !== checkedBaseline.number ||
    note.value.lineage.spec.digest !== checkedBaseline.digest
  ) {
    return false;
  }
  return isDecisionPreview(value.preview, checkedBaseline);
}

/**
 * A file written before the preview was persisted may omit this field.
 *
 * What it demands are the three parts the boundary itself demands, and it demands
 * them for the same reason `isDecisionPreparation` demands its own: a preview
 * whose intent or diff cannot be read is one the approval boundary could not show,
 * so carrying it would be worse than not having it.
 */
function isFixPreview(value: unknown): value is FlowFixPreview | null | undefined {
  if (value === undefined || value === null) return true;
  if (!isRecord(value) || !isStringArray(value.files)) return false;
  return (
    typeof value.intent === "string" &&
    value.intent.trim().length > 0 &&
    typeof value.diff === "string" &&
    value.diff.trim().length > 0
  );
}

function isDecisionPreview(
  value: unknown,
  baseline: { path: string; number: string; digest: string },
): value is DecisionPreview {
  if (
    !isRecord(value) ||
    !isRecord(value.baseline) ||
    !isRecord(value.impact) ||
    !isRecord(value.evidence)
  ) {
    return false;
  }
  const previewBaseline = value.baseline;
  if (
    previewBaseline.path !== baseline.path ||
    previewBaseline.number !== baseline.number ||
    previewBaseline.digest !== baseline.digest ||
    !Array.isArray(value.effective_change) ||
    !isStringArray(value.consumers) ||
    !isStringArray(value.obligations) ||
    typeof value.resume_point !== "string" ||
    value.resume_point.trim().length === 0 ||
    !isStringArray(value.evidence.preserved) ||
    !isStringArray(value.evidence.invalidated) ||
    typeof value.impact.scope !== "string" ||
    (value.impact.scope !== "functional" && value.impact.scope !== "plan-only") ||
    !Number.isInteger(value.impact.assertions) ||
    !Number.isInteger(value.impact.consumers) ||
    !isRecord(value.effects) ||
    !isEffectClassArray(value.effects.classes) ||
    !Array.isArray(value.effects.entries) ||
    !isProposal(value.proposal)
  ) {
    return false;
  }
  return value.effects.entries.every(
    (entry) =>
      isRecord(entry) &&
      typeof entry.path === "string" &&
      Number.isInteger(entry.bytes) &&
      typeof entry.overwrite === "boolean",
  );
}

function isProposal(value: unknown): value is LocalProposal | null {
  if (value === null) return true;
  if (!isRecord(value)) return false;
  return (
    typeof value.operation === "string" &&
    typeof value.digest === "string" &&
    isProposalArtifacts(value.artifacts) &&
    isProposalBases(value.bases) &&
    isProposalScope(value.scope) &&
    isEffectClassArray(value.effects) &&
    isEffectClassArray(value.requires_approval)
  );
}

/** A proposal with no artifacts proposes nothing: there would be nothing to seal. */
function isProposalArtifacts(value: unknown): boolean {
  if (!Array.isArray(value) || value.length === 0) return false;
  return value.every(
    (entry) =>
      isRecord(entry) &&
      typeof entry.path === "string" &&
      typeof entry.content === "string" &&
      typeof entry.overwrite === "boolean",
  );
}

function isProposalBases(value: unknown): boolean {
  if (!Array.isArray(value)) return false;
  return value.every(
    (entry) =>
      isRecord(entry) && typeof entry.path === "string" && typeof entry.digest === "string",
  );
}

function isProposalScope(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return typeof value.sensitive_sources === "boolean" && typeof value.scope_expanded === "boolean";
}

function isEffectLedger(value: unknown): value is EffectLedger {
  if (!isRecord(value)) return false;
  return (
    isEffectClassArray(value.planned) &&
    isEffectClassArray(value.approved) &&
    isEffectClassArray(value.applied)
  );
}

function isPendingAction(value: unknown): value is FlowPendingAction | null {
  if (value === null) return true;
  return (
    isRecord(value) &&
    typeof value.transition === "string" &&
    typeof value.digest === "string" &&
    typeof value.attempted === "boolean"
  );
}

/**
 * Whether the trace is well-formed, per kind.
 *
 * Checked by discriminant rather than by "has some fields": an `executed` event
 * missing its seal and a `failed` one missing its recovery are the two shapes that
 * would make the trace unusable for the thing it exists for — proving what came
 * back, and saying what to do about what did not.
 */
function isEventArray(value: unknown): value is FlowRunEvent[] {
  if (!Array.isArray(value)) return false;
  return value.every((entry) => {
    if (!isRecord(entry)) return false;
    if (
      typeof entry.transition !== "string" ||
      typeof entry.operation !== "string" ||
      (entry.batch_iteration !== undefined &&
        (!Number.isInteger(entry.batch_iteration) || (entry.batch_iteration as number) < 1))
    ) {
      return false;
    }
    if (entry.kind === "executed") {
      return (
        typeof entry.summary === "string" &&
        typeof entry.output_digest === "string" &&
        isEffectClassArray(entry.effects) &&
        isStringArray(entry.evidence)
      );
    }
    if (entry.kind === "failed") {
      return (
        typeof entry.code === "string" &&
        typeof entry.message === "string" &&
        typeof entry.recovery === "string" &&
        // ABSENT-or-well-formed, never defaulted: a version 7 trace has no such
        // field, and the guard that reads it treats its absence as the refusal.
        (entry.effects === undefined || isEffectClassArray(entry.effects))
      );
    }
    return false;
  });
}

function isObservationArray(value: unknown): value is FlowObservation[] {
  if (!Array.isArray(value)) return false;
  return value.every(
    (entry) =>
      isRecord(entry) &&
      typeof entry.transition === "string" &&
      isStringArray(entry.signals) &&
      (entry.batch_iteration === undefined ||
        (Number.isInteger(entry.batch_iteration) && (entry.batch_iteration as number) >= 1)),
  );
}

/**
 * The two optional fields are checked as ABSENT-or-well-formed, never defaulted.
 *
 * Absence is the reading a run written before them gets, and it is the
 * conservative one — no floor beyond the ledger, nothing forgiven. What is
 * refused is a field that is THERE and unusable: a counter that is not a number
 * per transition would make the cap depend on whatever somebody typed, which is
 * the failure the counter exists to close.
 */
function isCounterMap(value: unknown): value is Record<string, number> | undefined {
  if (value === undefined) return true;
  if (!isRecord(value)) return false;
  return Object.values(value).every((count) => Number.isInteger(count) && (count as number) >= 0);
}

function isDegradationArray(value: unknown): value is FlowRunDegradation[] | undefined {
  if (value === undefined) return true;
  if (!Array.isArray(value)) return false;
  return value.every(
    (entry) =>
      isRecord(entry) &&
      typeof entry.transition === "string" &&
      typeof entry.cause === "string" &&
      entry.cause.trim().length > 0,
  );
}

function isAttemptArray(value: unknown): value is FlowRunAttempt[] {
  if (!Array.isArray(value)) return false;
  return value.every(
    (entry) =>
      isRecord(entry) &&
      typeof entry.invocation_id === "string" &&
      Number.isInteger(entry.attempt) &&
      typeof entry.request_digest === "string" &&
      typeof entry.transition === "string" &&
      (entry.batch_iteration === undefined ||
        (Number.isInteger(entry.batch_iteration) && (entry.batch_iteration as number) >= 1)) &&
      (entry.parent_request_digest === null || typeof entry.parent_request_digest === "string"),
  );
}
