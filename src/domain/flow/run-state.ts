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
import type { CapabilityFailure, EffectLedger } from "../capability/protocol.js";
import type { LocalProposal } from "../proposal.js";
import type { FlowDecision } from "./authority.js";
import type { EffectGrant } from "./authorization.js";

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
export const FLOW_RUN_STATE_VERSION = 8;

/**
 * The versions this CLI READS, newest first.
 *
 * Two, and the second one is not a migration: every field version 8 added is
 * OPTIONAL and its absence is the conservative reading — no floor beyond the
 * ledger, nothing forgiven, no degradation declared. So a run written before
 * them is read exactly as it always was, keeps walking, and is re-stamped as
 * version 8 by its first write. Refusing it instead would strand runs that were
 * mid-journey when the CLI was upgraded, which is the compatibility the spec
 * demands; inventing values for the missing fields would be the fabrication the
 * version gate exists to refuse. Neither happens here.
 */
export const FLOW_RUN_STATE_READABLE: readonly number[] = [FLOW_RUN_STATE_VERSION, 7];

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
  const spent = state.attempts.filter((attempt) => attempt.transition === transition).length;
  const floor = state.attempt_floor?.[transition] ?? 0;
  const granted = state.attempt_grants?.[transition] ?? 0;
  return Math.max(0, Math.max(spent, floor) - granted);
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
  const trace = state.events.filter((event) => event.transition === transition);
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
  /** Seal over every field above. */
  digest: string;
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
  return sealRunState({
    ...withoutSeal(state),
    applied: [...state.applied, decisionId],
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
export function grantAttempts(
  state: FlowRunState,
  transition: string,
  attempts: number,
): FlowRunState {
  const granted = { ...(state.attempt_grants ?? {}) };
  granted[transition] = (granted[transition] ?? 0) + attempts;
  return sealRunState({ ...withoutSeal(state), attempt_grants: granted });
}

/**
 * Stamp a state read from an older readable version with the current one.
 *
 * Applied on the way OUT of the reader, so the run walks — and is written back —
 * as one format from the first read onwards, and the version stops being a fact
 * that varies per file within one workspace. Nothing else is touched: the older
 * versions this build reads differ from the current one only by fields whose
 * absence is already the conservative reading, so there is nothing to fill in
 * and nothing is filled in. Re-sealed because the version is inside the seal.
 */
export function atCurrentVersion(state: FlowRunState): FlowRunState {
  if (state.version === FLOW_RUN_STATE_VERSION) return state;
  return sealRunState({ ...withoutSeal(state), version: FLOW_RUN_STATE_VERSION });
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
    last.code === event.code &&
    last.message === event.message
  );
}

/** Keep a validated observation for the rule that consumes it later. */
export function withObservation(state: FlowRunState, observation: FlowObservation): FlowRunState {
  return sealRunState({
    ...withoutSeal(state),
    observations: [
      ...state.observations.filter((past) => past.transition !== observation.transition),
      observation,
    ],
  });
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
  if (typeof parsed.digest !== "string") return invalid("no trae su sello");
  return null;
}

function refuse(code: string, message: string, action: string): FlowRunRead {
  return { ok: false, failure: { code, message, action } };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
    if (typeof entry.transition !== "string" || typeof entry.operation !== "string") return false;
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
      isRecord(entry) && typeof entry.transition === "string" && isStringArray(entry.signals),
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
      (entry.parent_request_digest === null || typeof entry.parent_request_digest === "string"),
  );
}
