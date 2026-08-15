/**
 * Who decides what, for every public journey — as data.
 *
 * The registry below is the answer to one question asked of every decision and
 * transition Workline makes: is the correct result derivable from validated
 * inputs, persisted state and explicit rules (`cli`), does it need
 * interpretation, research, synthesis or authorship (`agent`), or is it a
 * preference or an authorization nobody may infer (`human`)?
 *
 * It is a TABLE, never a branch — the same shape `COMPOSED_OPERATIONS` uses. A
 * new transition is a new row; the engine, the ownership projection and the
 * doctrine guards all read this one source. Forcing determinism with a heuristic
 * is explicitly NOT the goal: a decision that is really interpretation is
 * classified `agent` and stays there.
 *
 * `ownership` is the migration axis, and it is deliberately separate from
 * authority: `cli-owned` means this CLI decides WHEN the step is asked and the
 * doctrine may no longer re-state it as a rule, while `authority` still answers
 * who produces the answer. The axis started with a second value — `legacy`, "the
 * doctrine Markdown still decides it" — and every row began there so the
 * migration would be observable rather than asserted. It is now CLOSED: the
 * vocabulary has one member, so a row that fails to declare ownership is a
 * compile error instead of a silent return to a document.
 */

import { WORKLINE_FLOWS, type WorklineFlow } from "../../application/capability/compose.js";
import type { EffectClass } from "../capability/effects.js";

export const FLOW_AUTHORITIES = ["cli", "agent", "human"] as const;

/** Who owns one decision: the CLI's rules, the agent's judgment, or the person. */
export type FlowAuthority = (typeof FLOW_AUTHORITIES)[number];

export const TRANSITION_OWNERSHIPS = ["cli-owned"] as const;

/**
 * That this CLI decides when the transition is asked.
 *
 * One member on purpose. The field survives the migration that emptied it because
 * it is what the directive carries to whoever executes, and because keeping the
 * vocabulary CLOSED is what stops a later row from re-opening the axis quietly: a
 * second value would have to be added here, in the open, next to the mechanism
 * that no longer exists to serve it.
 */
export type TransitionOwnership = (typeof TRANSITION_OWNERSHIPS)[number];

/** Transversal rules of the chassis that no single flow owns. */
export const CHASSIS_SCOPE = "chassis";

/** Prefix of a scope that belongs to a transversal command instead of a flow. */
export const COMMAND_SCOPE_PREFIX = "cmd:";

/**
 * Which public journey a decision belongs to: a flow, the transversal chassis,
 * or one transversal command (`cmd:<name>`).
 *
 * One string instead of a discriminated union, for the same reason
 * `capability.operation` is one string: the table stays readable and the two
 * resolvers below are the only places that need to take it apart.
 */
export type DecisionScope = string;

/** The four migration tranches the plan cuts over one at a time. */
export const FLOW_TRANCHES = ["quick", "spec", "plan", "chassis"] as const;

export type FlowTranche = (typeof FLOW_TRANCHES)[number];

export interface FlowDecision {
  /** Stable id, `<scope>.<decision>`; what the run state records as applied. */
  id: string;
  scope: DecisionScope;
  /** What is being decided, in one line, in the user's language. */
  title: string;
  authority: FlowAuthority;
  ownership: TransitionOwnership;
  /** Bundle-relative document that states it today. Must exist in the bundle. */
  document: string;
  /**
   * What applying it DOES, as the closed effect taxonomy says it.
   *
   * Absent means {@link DEFAULT_TRANSITION_EFFECTS} — a decision that computes a
   * verdict and persists nothing. Only the transitions that really write, really
   * overwrite or really run something declare it, and that declaration is what
   * the authorization gate reads: a row claiming `read_only` while it rewrites a
   * plan-doc would let the automatic advance edit a document nobody approved.
   */
  effects?: readonly EffectClass[];
  /**
   * Whose books the declared effects write: the run's own, or somebody else's.
   *
   * `"run"` says every effect this row exercises lands on the run's own
   * bookkeeping — its session artifacts, its flow state, the progress marks of
   * the flow's own document, or running the checks the run itself declared.
   * The authorization gate covers those without a preflight: whoever started
   * the run consented to it keeping its own books, and a person asked to
   * "authorize" them has nothing left to decide. The cover is bounded twice —
   * it never reaches `destructive` or `network_external` whatever the row
   * claims (the gate is fail-closed about them), and a standing proposal is
   * never covered by it, because sealed bytes are somebody's material, not
   * bookkeeping.
   *
   * Absent means the effects reach past the run's own ledger and the ordinary
   * preflight applies.
   */
  custody?: "run";
  /**
   * Signals the agent may declare at THIS boundary, by id.
   *
   * Only an `agent` row carries them, and they are the exact frontier the spec
   * draws: recognizing a signal is judgment, counting them against a threshold is
   * a rule. The ids are declared once in the bundle's manifest (`flow_signals`);
   * a signal outside that vocabulary never advances a journey.
   */
  signals?: readonly string[];
  /**
   * The text in {@link document} that attributes this decision to the CLI.
   *
   * Present on EVERY `cli-owned` row and on no other: what makes ownership
   * observable in the doctrine is that the document says out loud who decides.
   * The guard reads this field and demands the marker verbatim, so the day a
   * document drops the attribution — the first symptom of doctrine taking a
   * migrated rule back — the suite fails instead of two sources drifting apart.
   *
   * It is a marker, not a summary: it has to be text already earning its place in
   * the document, which is why the guard also refuses one that names neither an
   * `aw` invocation nor the CLI nor the capability that runs it.
   */
  attribution?: string;
  /**
   * The invocation that applies this transition when the engine cannot.
   *
   * Absent — the overwhelming default — means the engine applies it internally.
   * Present makes it an `execution` boundary: the directive names the invocation,
   * the caller runs it, and the transition applies only when a verifiable result
   * comes back. Only a `cli` row may carry one; an `agent` or `human` row already
   * returns to the caller for a different reason and adding a second would make
   * the boundary ambiguous. See {@link DelegatedAction}.
   */
  action?: DelegatedAction;
  /**
   * When this transition happens at all.
   *
   * Absent means always — the normal case. Present means the step is CONDITIONAL:
   * the run passes over it without applying it when the named rule did not fire.
   * A journey that always asked would not be equivalent to the doctrine it
   * replaces, and one that silently dropped the step would leave the trace
   * claiming a decision nobody made. See {@link TransitionCondition}.
   */
  condition?: TransitionCondition;
  /**
   * The alternatives this boundary emits, when they are the row's own.
   *
   * Absent means the generic pair (resolve / stop). A migrated tranche declares
   * the exact options its doctrine used to enumerate, so the engine emits them
   * verbatim instead of the caller re-deriving them from a document.
   */
  alternatives?: readonly FlowChoice[];
  /**
   * This row's answer carries the exact bytes a later boundary approves.
   *
   * Only an `agent` row may declare it: authoring the content is judgment, and
   * the CLI is what seals, previews, authorizes and writes it. The declaration is
   * the write boundary — an artifact outside {@link ProposalContract.destinations}
   * never reaches the seal. See {@link ProposalContract}.
   */
  proposes?: ProposalContract;
  /**
   * This row's answer FIXES the run's scope: its plan and the sources it edits.
   *
   * Only an `agent` row may declare it — which sources a plan touches is read off
   * the plan, and the engine never read it — and what the answer hands over is
   * checked before it is persisted: every alias against the WORKSPACE block, and
   * the plan against the document it names. See {@link FlowRunScope}.
   */
  scopes_sources?: true;
  /**
   * This human row decides the standing proposal, and its `approve` label is the
   * one alternative that grants.
   *
   * The grant is scoped to that proposal's seal, so it authorizes the bytes,
   * destinations, bases, scope and effect classes the preview showed and nothing
   * else. Every other alternative — including the flow control — produces no
   * effect at all.
   */
  publishes?: { approve: string };
  /**
   * This human row's `approve` label authorizes the named transition's effects.
   *
   * The move {@link publishes} makes for a sealed proposal, for a delegated
   * execution instead: approving IS the authorization, so the run does not stop
   * again downstream to re-ask the decision it just took, worded as an effect.
   * The grant is computed over the target transition's own seal and covers that
   * transition and nothing else; every other alternative grants nothing.
   */
  authorizes?: { approve: string; transition: string };
  /**
   * Where this transversal row is composed into every flow's journey.
   *
   * Only a `chassis` row carries one, and carrying it is what makes the row a
   * STEP a real run crosses instead of an entry in an inventory. See
   * {@link RunPlacement} and {@link journeyOfFlow}.
   */
  placement?: RunPlacement;
  /**
   * What already makes this rule true, when no run walks it as a step.
   *
   * Present exactly on the `cli-owned` rows that are neither steps of a journey
   * nor owned by a command of their own. See {@link Realization}.
   */
  realized_by?: Realization;
}

/** One alternative of a boundary that chooses: what it is, and what it costs. */
export interface FlowChoice {
  label: string;
  /** What choosing it produces. A choice without a consequence is not a choice. */
  consequence: string;
  recommended: boolean;
}

/**
 * A rule that turns observed signals into a verdict.
 *
 * Recognizing a signal is judgment and belongs to an `agent` row; counting them
 * against a threshold is a rule and belongs to the CLI. This is that frontier,
 * expressed as the two numbers it needs: whose signals, and how many.
 *
 * It is always reached through the {@link TransitionCondition} that reads it: a
 * threshold declared where nothing consumes it would be a rule with no effect,
 * and two rows that apply the same rule share the constant instead of restating
 * the number.
 */
export interface SignalThreshold {
  /** Transition whose declared signals it counts. */
  observed: string;
  /**
   * Which of that row's signals count. Absent means all of them.
   *
   * A boundary can declare several signals that answer DIFFERENT questions — one
   * says the solution space is unexplored, another that a functional ambiguity is
   * blocking — and two rules reading the same row would otherwise be
   * indistinguishable: either signal would fire both. Naming the subset is what
   * keeps "how many" from silently becoming "how many of anything".
   */
  of?: readonly string[];
  /** How many DISTINCT declared signals make it fire. */
  min: number;
}

/**
 * The rule of a transition that only happens sometimes.
 *
 * It carries the threshold itself rather than pointing at the row that applies
 * one: a condition and a decision are different things, and making one depend on
 * the other's presence would mean a step could only be conditional where some
 * other row happened to declare a rule. Two rows that share a threshold share the
 * constant, which keeps the single source where a reader can see it.
 */
export interface TransitionCondition {
  threshold: SignalThreshold;
  /** Why the step is passed over when the rule did not fire. Never empty. */
  otherwise: string;
}

/**
 * What an authoring row may hand back as the exact local change.
 *
 * The destinations are an allowlist, not a hint: they travel into the semantic
 * request the boundary emits and the protocol refuses an artifact that lands
 * outside them, so "the CLI decides where a flow may write" stays a property of
 * the contract instead of a review someone performs.
 *
 * The effects are declared once, here, and the row that publishes reads them off
 * the sealed proposal. Restating them on the publishing row would be a second
 * answer to "what does this do", and the two could disagree about a class the
 * person was shown.
 */
export interface ProposalContract {
  /** Workspace-relative folders (or exact files) the artifacts may land in. */
  destinations: readonly string[];
  /** What publishing them really exercises. */
  effects: readonly EffectClass[];
  limits: { maxArtifacts: number; maxArtifactBytes: number };
}

/** The proposal contract of an authoring row, or `null` when it proposes nothing. */
export function proposalContractOf(decision: FlowDecision): ProposalContract | null {
  return decision.proposes ?? null;
}

/** The approve label of a row that decides a standing proposal, or `null`. */
export function publishApprovalOf(decision: FlowDecision): string | null {
  return decision.publishes?.approve ?? null;
}

/** Whether this row's answer is what fixes the run's plan and its sources. */
export function scopesSources(decision: FlowDecision): boolean {
  return decision.scopes_sources === true;
}

/** Whose books this row's effects write: the run's own, or nobody's to assume. */
export function custodyOf(decision: FlowDecision): "run" | null {
  return decision.custody ?? null;
}

/** The effect grant a human row's approve label carries, or `null`. */
export function approvalGrantOf(
  decision: FlowDecision,
): { approve: string; transition: string } | null {
  return decision.authorizes ?? null;
}

/** A decision computes a verdict; writing is the exception that declares itself. */
export const DEFAULT_TRANSITION_EFFECTS: readonly EffectClass[] = ["read_only"];

/** What applying this transition does. */
export function effectsOf(decision: FlowDecision): readonly EffectClass[] {
  return decision.effects ?? DEFAULT_TRANSITION_EFFECTS;
}

/**
 * The exact thing to run, named by the CLI and executed by whoever called.
 *
 * Structured rather than a command string because the result has to be checkable
 * against it: "the executor ran something else" is only detectable if the two can
 * be compared field by field.
 *
 * Arguments and target may carry the run's own coordinates as placeholders
 * ({@link RUN_PLACEHOLDERS}); the engine binds them from the run state BEFORE
 * emitting the boundary, and the seal is computed over the bound form. A
 * placeholder that reached whoever executes would be a command nobody can run.
 */
export interface DelegatedInvocation {
  program: string;
  args: readonly string[];
  /** Where it runs, or what it acts on. Never implicit. */
  target: string;
  /** Payload for its stdin, when the invocation takes one. */
  input: string | null;
}

/**
 * The run coordinates an invocation may reference, and nothing else.
 *
 * Closed on purpose: an invocation that could interpolate arbitrary state would
 * be a template language, and a registry row would stop being readable as the
 * exact thing that runs. These three are what a session-scoped command needs —
 * the folder, its correlative and its slug — and all three are facts the engine
 * owns, read off the session folder it already has.
 *
 * The slug joined the set for a defect the closed vocabulary is exactly what
 * prevents. A row wrote its slug as `<slug>` — the metavariable the PROSE uses,
 * copied into a machine-readable invocation. Angle brackets bind to nothing and
 * the unbound-placeholder guard does not recognize them either, so the template
 * travelled intact to whoever executes. The honest agent substituted it and its
 * report no longer matched the sealed invocation; the literal one created a file
 * named after the template. Documents and invocations do NOT share a notation:
 * prose says `<slug>` to a reader, a row says `{slug}` to the engine, and only
 * the second one fails closed when the run cannot supply it.
 */
export const RUN_PLACEHOLDERS = ["{session}", "{code}", "{slug}"] as const;

/**
 * The Workline operations this CLI materializes inside its own process.
 *
 * A CLOSED union, and closed is the whole point of it. An action executed
 * internally is one nobody read as a command line first, so what may run that way
 * has to be enumerable, auditable and impossible to widen with data: the row names
 * an operation, never a program. `invocation.program` and `invocation.args` are
 * NEVER interpreted — they stay as the equivalent command a person would run to
 * obtain the same reading, which is what keeps the two comparable.
 *
 * The four members are exactly the deterministic surface the plan names: the
 * board, the sessions' own artifacts (their reading and their seeding), the close
 * and the publication of an already approved proposal. Everything that runs code,
 * touches git or produces a judgment is deliberately NOT here.
 *
 * Publishing is the one that writes documents the engine does not author, and it
 * is admissible for a reason the others do not need: it writes NOTHING of its own
 * — only the exact bytes a person approved, under the seal they approved them by.
 */
export const INTERNAL_ACTION_OPERATIONS = [
  /** Project the workspace board — what `aw status --json` returns. */
  "workspace.board",
  /** Read, and where the command seeds them, a session's own artifacts. */
  "session.artifacts",
  /** Close the session and upsert its HISTORY row. */
  "session.close",
  /** Obtain the run's isolation unit on every source its scope declares. */
  "worktree.ensure",
  /** Write the run's approved proposal, all of it or none of it. */
  "proposal.publish",
] as const;

export type InternalActionOperation = (typeof INTERNAL_ACTION_OPERATIONS)[number];

/**
 * The effect classes each internal operation can really apply.
 *
 * Read by the guard, not by the runtime: at runtime the executor reports what it
 * ACTUALLY applied and the same `executionVerdict` that judges an external result
 * refuses anything short of the row's declared effects. This table is what makes
 * the mismatch a failing test instead of a run that discovers it — a row declaring
 * `mutate_overwrite` while its operation only reads can never be satisfied, and
 * finding that out at the boundary is finding it out too late.
 */
export const INTERNAL_OPERATION_EFFECTS: Readonly<
  Record<InternalActionOperation, readonly EffectClass[]>
> = {
  "workspace.board": ["read_only"],
  "session.artifacts": ["read_only", "local_additive"],
  "session.close": ["read_only", "local_additive", "mutate_overwrite"],
  // A unit is a new working tree on a new branch, inside the run's own namespace:
  // it replaces nothing and it destroys nothing. That the CLI reaches git to make
  // it is not what the class measures — `workspace.board` already reads git the
  // same way and is `read_only`.
  "worktree.ensure": ["local_additive"],
  // Creating and replacing, both real — and which of the two happens is decided
  // by the proposal, not by the row: what the row declares here is the ceiling.
  "proposal.publish": ["local_additive", "mutate_overwrite"],
};

/**
 * Who materializes a delegated action: this CLI, or whoever called it.
 *
 * The classification is DECLARED, never inferred. Inferring it — "the program is
 * `aw`, so we can run it" — would make every future row internal by accident, and
 * the one property this union exists to hold is that widening the executor is a
 * visible edit. `external` carries its reason for the same reason a blocker
 * carries its cause: a boundary that says "you run this" without saying why the
 * CLI will not is a dead end for whoever reads it.
 */
export type InternalActionPlan =
  | { operation: "workspace.board" }
  /**
   * The artifact kinds whose content the transition needs, or none for the
   * presence report.
   *
   * Declared HERE and not read off `invocation.args`, which is what keeps "the
   * arguments are never interpreted" true rather than nearly true. Parsing them
   * would make the row's command line an input to the executor, and a flag added
   * to that line for a human reader would silently change what runs.
   */
  | { operation: "session.artifacts"; dump?: readonly string[] }
  | { operation: "session.close" }
  /**
   * Obtain one isolation unit per source the run declared, before it edits any.
   *
   * It takes no parameters either, and for the same reason `proposal.publish`
   * does not: what it may touch is the run's own persisted scope, so a row cannot
   * widen the acquisition by naming a source the run never fixed.
   */
  | { operation: "worktree.ensure" }
  /**
   * Publish the exact proposal the run is holding — all of it or none of it.
   *
   * It takes no parameters at all, and that is the safety property: what gets
   * written is the sealed proposal in the state, so a row cannot widen the write
   * by declaring a destination, and the approval that authorized it named the
   * same seal.
   */
  | { operation: "proposal.publish" };

export type ActionExecution =
  | ({ kind: "internal" } & InternalActionPlan)
  | { kind: "external"; reason: string };

/**
 * How a transition gets APPLIED — a mode orthogonal to authority, ownership and
 * effects.
 *
 * Absent means the engine applies it inside its own process, which is the default
 * and the cheap case. Present means the engine can DIRECT the step but cannot
 * materialize it: the search, the write or the check happens outside, so the
 * transition stays pending until the sealed invocation comes back with a result.
 * Deciding and executing are different acts, and this field is the seam between
 * them — the reason `advance` never records "seeded" or "validations run" for
 * something nothing ran.
 *
 * The effect classes are NOT restated here: they are the row's `effects`, read
 * through {@link effectsOf}. A second declaration could contradict the first, and
 * then "what does this do?" would have two answers.
 */
export interface DelegatedAction {
  invocation: DelegatedInvocation;
  /**
   * Who runs it — required, so a new row cannot arrive without answering.
   *
   * The field is not optional and has no default: an omitted class would have to
   * fall back to something, and either fallback is wrong. Defaulting to `internal`
   * would let a row be executed without anybody deciding it may be; defaulting to
   * `external` would silently keep a deterministic step as a round-trip and look
   * exactly like a decision. So the compiler asks, and the guard checks that the
   * answer is coherent with the row's effects.
   */
  execution: ActionExecution;
  /**
   * Ids of the validations whose REAL output has to come back, non-empty.
   *
   * An action whose result nobody can check is a confirmation, and a confirmation
   * is exactly what this contract exists to refuse.
   */
  evidence: readonly string[];
  /** Whether re-running it is safe — what a retry after a partial result rests on. */
  idempotent: boolean;
  /** What to do when the result comes back failed or partial. Never empty. */
  recovery: string;
}

/** The delegated action of a transition, or `null` when the engine applies it itself. */
export function actionOf(decision: FlowDecision): DelegatedAction | null {
  return decision.action ?? null;
}

/**
 * What this transition runs in-process, or `null` when whoever called it must.
 *
 * One predicate for every caller — the walk, the driver and the guard — so none of
 * them can answer "does the CLI run this itself?" differently from the others.
 *
 * An action with no `execution` at all cannot happen through the type, and it is
 * still read defensively: the answer for a malformed row is "not the CLI's", which
 * fails closed. Throwing instead would take down every caller that merely ASKS the
 * question — and asking it is now on the path of every boundary.
 */
export function internalActionOf(decision: FlowDecision): InternalActionPlan | null {
  const action = actionOf(decision);
  if (action === null || action.execution?.kind !== "internal") return null;
  const { kind: _internal, ...plan } = action.execution;
  return plan;
}

/** What makes this transition happen at all, or `null` when it always does. */
export function conditionOf(decision: FlowDecision): TransitionCondition | null {
  return decision.condition ?? null;
}

/** The alternatives this row declares as its own, or `null` for the generic pair. */
export function alternativesOf(decision: FlowDecision): readonly FlowChoice[] | null {
  return decision.alternatives ?? null;
}

/**
 * Where a transversal row sits inside a flow's journey.
 *
 * The chassis is not a `WorklineFlow`, so nothing walks `chassis` on its own: a
 * run walks ONE flow, and a transversal step is only crossed if it is composed
 * into that flow's journey at a declared position. `prefix` runs before the
 * flow's own first step and `suffix` after its last — which is exactly the two
 * positions the engine's transversal steps occupy, one establishing a constraint
 * the whole run is held to, the other closing it.
 *
 * Declared as data next to the row for the same reason the journey itself is a
 * table: a position computed in code would be a second place to look when asking
 * "when does this happen?".
 */
export const RUN_PLACEMENTS = ["prefix", "suffix"] as const;

export type RunPlacement = (typeof RUN_PLACEMENTS)[number];

/**
 * What already makes a rule true, for a row nothing walks and no command owns.
 *
 * The third way a migrated rule becomes observable. A row can be `cli-owned`
 * without being a step — the CLI decides it, but by holding a shape everywhere
 * rather than by stopping at one point — and the honest way to say that is to
 * name the thing that holds it. Without this field such a row would be ownership
 * asserted and nothing else, which is the one defect this migration cannot ship:
 * the reviews of F11 and F12 already retired two surfaces that had no caller.
 *
 * Two kinds because there are two real answers. `engine` names a symbol in this
 * codebase that enforces the rule on every boundary; `transitions` names the flow
 * rows that INSTANCE it — a transversal rule whose every occurrence was already
 * migrated as part of some tranche is realized by those rows and by nothing else.
 * The guard checks both directions: the symbol exists in its module, the named
 * rows exist and are themselves migrated, and no `cli-owned` row is left with no
 * form at all.
 */
export type Realization =
  | { kind: "engine"; module: string; symbol: string }
  | { kind: "transitions"; ids: readonly string[] };

/** How this row is observable when no run walks it, or `null` when one does. */
export function realizationOf(decision: FlowDecision): Realization | null {
  return decision.realized_by ?? null;
}

/** Where this row sits in a flow's journey, or `null` when it is the flow's own. */
export function placementOf(decision: FlowDecision): RunPlacement | null {
  return decision.placement ?? null;
}

/**
 * A public command with no journey decision of its own, and why.
 *
 * The exclusion is the honest half of exhaustiveness: `aw mcp` configures MCP
 * servers and decides nothing about how a flow advances. Leaving it unlisted
 * would look identical to forgetting it, so the guard demands one or the other.
 */
export interface CommandExclusion {
  command: string;
  reason: string;
}

const CHASSIS = CHASSIS_SCOPE;
const cmd = (name: string): DecisionScope => `${COMMAND_SCOPE_PREFIX}${name}`;

/**
 * What `loops/quick-loop/LOOP.md` says about who decides its deterministic steps.
 *
 * ONE marker for the whole tranche, not one per row: the guard demands the text
 * be present in the document, and twelve variants of the same sentence would cost
 * context budget to say the same thing twelve times. The document keeps the
 * EXPLANATION of each rule and hands over the rule itself.
 */
const QUICK_ATTRIBUTION =
  "the deterministic steps below are decided by the CLI (`aw flow advance`), not by this document";

/**
 * What the engine's own document says about who decides its transversal steps.
 *
 * Deliberately the SAME sentence the tranches use. The chassis is the last
 * document to hand its rules over, and reading the identical marker there is the
 * point: a rule the CLI decides says so the same way wherever it used to live.
 */
const CHASSIS_ATTRIBUTION = QUICK_ATTRIBUTION;

/**
 * What `modules/COMPACTION.md` says about who decides compaction.
 *
 * Its own marker rather than the shared one: compaction is not a step of any
 * journey — it fires at whatever boundary the run happens to be standing on —
 * so the sentence names the command that executes it instead of the walk.
 */
const COMPACTION_ATTRIBUTION = "`aw checkpoint-write --can-pause`";

/**
 * What the continuity documents say about who resolves which line a prompt joins.
 *
 * Also its own: these rules fire BEFORE a run exists, so no directive can carry
 * them. What decides is the session resolution of the commands named here.
 */
const CONTINUITY_ATTRIBUTION = "`aw resume`";

/**
 * The entry gate's rule: two of the five declared signals.
 *
 * Shared by the row that APPLIES it and by the row that only happens when it
 * fired, so the number lives once. Changing it here changes both, which is the
 * whole reason it is a constant and not two literals.
 */
const ENTRY_SIZE_THRESHOLD: SignalThreshold = { observed: "quick.entry-gate-signal", min: 2 };

/**
 * The one thing a session-scoped action needs: this run's session.
 *
 * `aw` runs from the workspace root, so the target of a session-scoped
 * invocation is the session it acts ON, and the correlative travels in the
 * arguments. Both are bound from the run state before the boundary is emitted.
 */
const SESSION_TARGET = "{session}";

const CHASSIS_MD = "loops/CHASSIS.md";
const CODE_POLICIES_MD = "loops/CODE-POLICIES.md";
const SKILL_MD = "SKILL.md";
const QUICK_LOOP = "loops/quick-loop/LOOP.md";
const SPEC_LOOP = "loops/spec-refine-loop/LOOP.md";
const IDEATION_GATE = "modules/IDEATION-GATE.md";
const CHANGE_SHAPE = "modules/SPEC-CHANGE-SHAPE.md";

/**
 * What SPEC's documents say about who decides their deterministic steps.
 *
 * One marker per document, because the guard reads each row's own document: the
 * loop states it once for its nine rows, and each migrated module states it for
 * its own. Three documents used to be absent from this list because a tranche that
 * had not been cut over still read them; the closing tranche resolved each on its
 * own terms. `SPEC-CHANGE-SHAPE.md` gained the split branch's steps, which were
 * carrying `spec-new`'s document by mistake. `DESIGN-REFERENCES.md` attributes its
 * one remaining row to `aw designs` rather than to this marker, because the CLI
 * puts the inventory in front of the judgment instead of deciding the step.
 * `SPLIT-GATE.md` keeps its rule and gets no marker at all: it belongs to
 * `/w:spec-new`, which starts no loop, and the registry declares that exclusion.
 */
const SPEC_ATTRIBUTION =
  "the deterministic steps below are decided by the CLI (`aw flow advance`), not by this document";
const PLAN_NEW_LOOP = "loops/plan-new-loop/LOOP.md";
const PLAN_REFINE_LOOP = "loops/plan-refine-loop/LOOP.md";
const PLAN_EXEC_LOOP = "loops/plan-exec-loop/LOOP.md";
const BATCHES_MD = "modules/PLAN-EXECUTION-BATCHES.md";
const PLAN_SPLIT_GATE = "modules/PLAN-SPLIT-GATE.md";
const PLAN_REFINE_SPLIT = "modules/PLAN-REFINE-SPLIT.md";
const PLAN_INPUT = "modules/PLAN-INPUT.md";
const DB_SCRIPTS_ONLY = "modules/DB-SCRIPTS-ONLY.md";

/**
 * What PLAN's documents say about who decides their deterministic steps.
 *
 * Nine documents, one marker each — the three loops, the four PLAN modules, and
 * the two the code-editing loops share. `CODE-POLICIES.md` and
 * `DB-SCRIPTS-ONLY.md` are here for a reason worth stating: their only readers
 * are `quick` and `plan-exec`, and with PLAN cut over neither is doctrine's
 * anymore. Until that tranche they had to stay, because retiring a rule from a
 * document an undirected journey reads would leave that journey without it.
 */
const PLAN_ATTRIBUTION =
  "the deterministic steps below are decided by the CLI (`aw flow advance`), not by this document";

/**
 * The multi-plan gate's rule: two of the five declared signals.
 *
 * A factory rather than a constant because the SAME rule is applied by two
 * journeys over their own observation — `plan-new` cuts a plan being generated,
 * `plan-refine` cuts one that already exists — and a threshold may only count
 * signals declared inside the journey it belongs to. What must not be duplicated
 * is the number, and this keeps it in one place.
 */
const splitThreshold = (observed: string): SignalThreshold => ({ observed, min: 2 });

/**
 * The batching rule, stated the way the module states it.
 *
 * "A range is eligible only when ALL of these are true… anything else is
 * `isolated`." So the threshold counts the facts that BREAK eligibility, and one
 * is enough: `min: 1` is not a weak bar here, it is the whole rule. The three
 * journeys that infer a partition each observe their own row, for the same reason
 * the split gate does.
 */
const ineligibleRange = (observed: string): SignalThreshold => ({ observed, min: 1 });

/** The five observable facts that make a consecutive range ineligible for `continuous`. */
const BATCH_ELIGIBILITY_SIGNALS = [
  "plan.dependency-outside-range",
  "plan.result-shapes-later",
  "plan.blocker-between-phases",
  "plan.recovery-boundary",
  "plan.not-one-reviewable-unit",
] as const;

/** The five signals of the multi-plan split gate, shared by both plan loops. */
const PLAN_SPLIT_SIGNALS = [
  "plan.independent-tranches",
  "plan.no-shared-deps",
  "plan.distinct-priorities",
  "plan.far-beyond-s",
  "plan.staging-requested",
] as const;

/**
 * Every decision and transition of every public journey, in journey order
 * within each scope. The engine walks a scope's rows in this order.
 */
export const FLOW_DECISIONS: readonly FlowDecision[] = [
  // ── Transversal chassis: the engine every loop runs underneath its deltas ──
  //
  // Three forms of observable ownership live in this block, and which one a row
  // takes is a fact about the RULE, not a preference. A row with a `placement` is
  // composed into every flow's journey and a real run crosses it. A row with a
  // `realized_by` is held by something that already exists — a symbol of this
  // engine, or the flow rows that instance it. Everything else that used to be
  // here moved to the scope of the command that executes it, because a rule that
  // fires between prompts or at an arbitrary boundary is not a step of a journey.
  {
    id: "chassis.docs-boundary",
    scope: CHASSIS,
    title: "resolver en qué carpeta de docs puede escribir el loop",
    authority: "cli",
    ownership: "cli-owned",
    document: CHASSIS_MD,
    attribution: CHASSIS_ATTRIBUTION,
    // First of the whole journey, and deliberately so: it fixes the only folders
    // this run may write BEFORE any step that writes is even emitted. Resolved
    // afterwards it would be a rule checked against writes that already happened.
    placement: "prefix",
  },
  {
    id: "chassis.research-exhaustion",
    scope: CHASSIS,
    title: "marcar un gap agotado tras el tope de intentos y degradarlo",
    authority: "cli",
    ownership: "cli-owned",
    document: CHASSIS_MD,
    attribution: CHASSIS_ATTRIBUTION,
    // Same shape as the boundary above: the step fixes the cap the whole run is
    // held to, and the engine applies it at every boundary. What it prevents is
    // the loop the doctrine names — asking the same thing until something gives —
    // by turning the attempt after the cap into a degradation with a destination.
    placement: "prefix",
  },
  {
    id: "chassis.session-create-or-resume",
    scope: CHASSIS,
    title: "abrir la sesión de la corrida o reanudar la existente",
    authority: "cli",
    ownership: "cli-owned",
    document: CHASSIS_MD,
    attribution: CHASSIS_ATTRIBUTION,
    effects: ["local_additive"],
    // Not a step of the composed journey, and the reason is precise: every flow
    // ALREADY opens with its own session row, so composing a sixth one would ask
    // the same question twice per run. The rule is transversal; its occurrences
    // are these five, and they are what make it true.
    realized_by: {
      kind: "transitions",
      ids: [
        "quick.session-create",
        "spec-refine.session",
        "plan-new.session",
        "plan-refine.session",
        "plan-exec.session",
      ],
    },
  },
  {
    id: "chassis.session-numbering",
    scope: CHASSIS,
    title: "asignar el NNN global y secuencial de la sesión",
    authority: "cli",
    ownership: "cli-owned",
    document: "modules/SESSION-NUMBERING.md",
    attribution: "The CLI owns the number (hard rule)",
    realized_by: { kind: "transitions", ids: ["session-create.numbering"] },
  },
  {
    id: "chassis.success-criteria-seed",
    scope: CHASSIS,
    title: "sembrar los criterios de éxito antes de ejecutar (verification-first)",
    authority: "cli",
    ownership: "cli-owned",
    document: CHASSIS_MD,
    attribution: CHASSIS_ATTRIBUTION,
    // QUICK's two, and only QUICK's: it is the one flow whose deliverable has no
    // document of its own, so its criteria have to be authored and ratified as a
    // step. The other four take theirs from the spec or plan they already read —
    // "referenced, not duplicated" — so there is nothing for them to seed, and
    // inventing a row for each would be four steps that ask nothing.
    realized_by: {
      kind: "transitions",
      ids: ["quick.success-criteria-authoring", "quick.success-criteria-ratification"],
    },
  },
  {
    id: "chassis.gap-detection",
    scope: CHASSIS,
    title: "detectar los gaps materiales del trabajo",
    authority: "agent",
    ownership: "cli-owned",
    document: CHASSIS_MD,
    attribution: CHASSIS_ATTRIBUTION,
    realized_by: {
      kind: "transitions",
      ids: ["spec-refine.gap-recognition", "plan-exec.entry-gap-recognition"],
    },
  },
  {
    id: "chassis.gap-batching",
    scope: CHASSIS,
    title: "tomar un lote de a lo sumo 3 gaps por vuelta",
    authority: "cli",
    ownership: "cli-owned",
    document: CHASSIS_MD,
    attribution: CHASSIS_ATTRIBUTION,
    // The engine holds the stricter form of the same rule: it stops at the FIRST
    // step it cannot apply, so a run never carries more than one open boundary.
    // "At most three" is the ceiling of a loop that batches; one is what a
    // directed journey emits, and it satisfies the ceiling by construction.
    realized_by: {
      kind: "engine",
      module: "src/application/flow/advance.ts",
      symbol: "resolveBoundary",
    },
  },
  {
    id: "chassis.resolver-selection",
    scope: CHASSIS,
    title: "elegir el resolvedor de un gap con la regla adoptar/investigar/probar/preguntar",
    authority: "cli",
    ownership: "cli-owned",
    document: CHASSIS_MD,
    attribution: CHASSIS_ATTRIBUTION,
    // The ask-vs-research discriminator IS the boundary taxonomy, already: a
    // `semantic` boundary is the judgment the agent produces, a `human` one the
    // preference only a person holds, an `execution` one the thing that has to be
    // run. Choosing the resolver and classifying the boundary are one act.
    realized_by: {
      kind: "engine",
      module: "src/application/flow/advance.ts",
      symbol: "boundaryKind",
    },
  },
  {
    id: "chassis.minimality-lens",
    scope: CHASSIS,
    title: "juzgar si el entregable pesa más de lo que sus criterios exigen",
    authority: "agent",
    ownership: "cli-owned",
    document: CHASSIS_MD,
    attribution: CHASSIS_ATTRIBUTION,
    realized_by: {
      kind: "transitions",
      ids: ["quick.review-findings", "plan-exec.review-findings"],
    },
  },
  {
    id: "chassis.convergence-gate",
    scope: CHASSIS,
    title: "evaluar el gate de convergencia sobre los criterios de éxito",
    authority: "cli",
    ownership: "cli-owned",
    document: CHASSIS_MD,
    attribution: CHASSIS_ATTRIBUTION,
    // One per flow, which is what "each heir names its own instance of this gate"
    // means once the heirs stopped naming it in prose.
    realized_by: {
      kind: "transitions",
      ids: [
        "quick.convergence-gate",
        "spec-refine.ready-gate",
        "plan-new.coherence-gate",
        "plan-refine.executability-gate",
        "plan-exec.final-validation",
      ],
    },
  },
  {
    id: "chassis.criteria-flip",
    scope: CHASSIS,
    title: "marcar en verde los criterios que el gate aprobó",
    authority: "cli",
    ownership: "cli-owned",
    document: CHASSIS_MD,
    attribution: CHASSIS_ATTRIBUTION,
    effects: ["mutate_overwrite"],
    // The two rows that WRITE the approved state into the document the gate
    // judged. `quick` has none because it has no document to write it into, and
    // the two plan-authoring flows converge on a document they hand to the next
    // flow rather than on one they mark green.
    //
    // SPEC's used to be a promotion of its own, `status: ready-for-plan` written
    // after the save. It is now the publication: the stamp travels inside the
    // approved bytes, so the row that marks the criteria green is the row that
    // writes them — one document, one write.
    realized_by: {
      kind: "transitions",
      ids: ["spec-refine.publication", "plan-exec.plan-done"],
    },
  },
  {
    id: "chassis.structured-choice-shape",
    scope: CHASSIS,
    title: "armar la pregunta: hasta 3 de contenido más el control de flujo, recomendación primero",
    authority: "cli",
    ownership: "cli-owned",
    document: CHASSIS_MD,
    attribution: CHASSIS_ATTRIBUTION,
    // Enforced at construction, not advised: a directive whose choices lack a
    // consequence, or carry zero or two recommendations, is refused before it
    // reaches anybody. That is stronger than the doctrine it replaces, which
    // could only state the shape and hope.
    realized_by: {
      kind: "engine",
      module: "src/domain/flow/directive.ts",
      symbol: "checkChoices",
    },
  },
  {
    id: "chassis.flow-control",
    scope: CHASSIS,
    title: "decidir Compactar o Cerrar en cualquier momento",
    authority: "human",
    ownership: "cli-owned",
    document: CHASSIS_MD,
    attribution: CHASSIS_ATTRIBUTION,
    // The control is appended by the engine to every boundary that offers
    // alternatives — never by the row, which is what keeps a tranche from writing
    // a question nobody can walk away from or pause.
    realized_by: {
      kind: "engine",
      module: "src/application/flow/advance.ts",
      symbol: "flowControlChoices",
    },
  },
  {
    id: "chassis.finalize",
    scope: CHASSIS,
    title: "persistir CHECKPOINT, escribir BACKLOG solo si algo quedó diferido y cerrar la sesión",
    authority: "cli",
    ownership: "cli-owned",
    document: CHASSIS_MD,
    attribution: CHASSIS_ATTRIBUTION,
    effects: ["mutate_overwrite"],
    // Closing its own session is the canonical run bookkeeping: CHECKPOINT,
    // BACKLOG and the HISTORY row are the run's own ledger, so custody covers
    // the overwrite and nobody is asked to authorize the chassis keeping its
    // books.
    custody: "run",
    // The only suffix: every flow ends the same way, and no flow row says so —
    // each tranche stopped at its own last decision and the close was doctrine's.
    placement: "suffix",
    // Delegated for the reason every write is: closing the session upserts its
    // HISTORY row, and a run that recorded "finalized" without that having
    // happened would leave the durable register disagreeing with the session.
    action: {
      invocation: {
        program: "aw",
        args: ["session-close", "--code", "{code}"],
        target: ".",
        input: null,
      },
      execution: { kind: "internal", operation: "session.close" },
      evidence: ["chassis.sesion-cerrada"],
      idempotent: true,
      recovery:
        "una sesión que no cerró deja la corrida abierta: no la marques finalizada — reparás la fila del registro con 'aw history-update' y volvés a cerrar",
    },
  },

  // ── QUICK — the pilot tranche, and the first one this CLI decides ──────────
  //
  // Twelve rows migrated with the pilot: every decision whose rule lived in the
  // loop's own document. The five in CODE-POLICIES/DB-SCRIPTS-ONLY waited for the
  // PLAN tranche and travelled with it — those two documents are read by `quick`
  // and `plan-exec` and by nobody else, so only once execution was cut over could
  // their rules be retired without leaving a journey without them.
  {
    id: "quick.entry-gate-signal",
    scope: "quick",
    title: "reconocer cada señal de tamaño en el objetivo recibido",
    authority: "agent",
    ownership: "cli-owned",
    document: QUICK_LOOP,
    attribution: QUICK_ATTRIBUTION,
    signals: [
      "quick.needs-architecture",
      "quick.two-or-more-sources",
      "quick.multiple-deliverables",
      "quick.large-feature-or-refactor",
      "quick.ambiguous-requirements",
    ],
  },
  {
    id: "quick.entry-size-gate",
    scope: "quick",
    title: "aplicar el umbral de dos señales que dispara el gate de entrada",
    authority: "cli",
    ownership: "cli-owned",
    document: QUICK_LOOP,
    attribution: QUICK_ATTRIBUTION,
    // The row is the MOMENT the verdict is computed; the rule itself is
    // `ENTRY_SIZE_THRESHOLD`, read by every step conditional on it. Declaring the
    // threshold here too would be a second copy that nothing reads.
  },
  {
    id: "quick.anti-duplicate",
    scope: "quick",
    title: "recomendar reanudar la spec o sesión que ya cubre este objetivo",
    authority: "cli",
    ownership: "cli-owned",
    document: QUICK_LOOP,
    attribution: QUICK_ATTRIBUTION,
    // Conditional for the same reason the choice is: the search exists to change
    // what the gate recommends, so on a task that never triggers the gate it is a
    // read nobody asked for. The doctrine had it INSIDE the gate branch.
    condition: {
      threshold: ENTRY_SIZE_THRESHOLD,
      otherwise: "el umbral no disparó: no hay gate que recomiende reanudar nada",
    },
    // The search is the board this CLI already projects — specs, plans and
    // sessions in one read — so what the run credits is a real listing and not
    // "I looked". Read-only, so it never stops to be authorized.
    action: {
      invocation: { program: "aw", args: ["status", "--json"], target: ".", input: null },
      execution: { kind: "internal", operation: "workspace.board" },
      evidence: ["quick.board-listed"],
      idempotent: true,
      recovery:
        "volvé a correr 'aw status --json' y devolvé su salida real; si el tablero no se puede leer, resolvé eso antes de seguir",
    },
  },
  {
    id: "quick.gate-choice",
    scope: "quick",
    title: "elegir entre cambiar a SPEC, seguir en quick o recortar el alcance",
    authority: "human",
    ownership: "cli-owned",
    document: QUICK_LOOP,
    attribution: QUICK_ATTRIBUTION,
    // The gate only exists when it fired. Asking always would make the directed
    // journey ask what the doctrine it replaces does not ask — and "borderline
    // continues in quick without asking" is the doctrine's own words.
    condition: {
      threshold: ENTRY_SIZE_THRESHOLD,
      otherwise: "el umbral de dos señales no disparó: la tarea sigue en quick sin preguntar nada",
    },
    alternatives: [
      {
        label: "Cambiar a SPEC",
        consequence:
          "no se crea sesión quick: la línea de trabajo pasa al flow SPEC con el objetivo original",
        recommended: true,
      },
      {
        label: "Seguir en quick",
        consequence: "el recorrido continúa como quick con el objetivo tal cual llegó",
        recommended: false,
      },
      {
        label: "Recortar alcance",
        consequence:
          "el objetivo pasa a ser la sub-tarea que sí entra en un quick y el resto queda en BACKLOG",
        recommended: false,
      },
    ],
  },
  {
    id: "quick.session-create",
    scope: "quick",
    title: "crear la sesión liviana de la tarea",
    authority: "cli",
    ownership: "cli-owned",
    document: QUICK_LOOP,
    attribution: QUICK_ATTRIBUTION,
    effects: ["local_additive"],
    // The engine cannot author the descriptor or the objective — those are the
    // caller's — so what it names is the read that proves the session it is
    // running inside really exists as an artifact, with its SESSION.md.
    action: {
      invocation: {
        program: "aw",
        args: ["session-artifacts", "--code", "{code}"],
        target: SESSION_TARGET,
        input: null,
      },
      execution: { kind: "internal", operation: "session.artifacts" },
      evidence: ["quick.session-present"],
      idempotent: true,
      recovery:
        "creá la sesión con 'aw session-create --type quick --name <slug>-quick --objetivo \"<objetivo>\"' y volvé a devolver la lectura",
    },
  },
  {
    id: "quick.success-criteria-authoring",
    scope: "quick",
    title: "redactar la prueba o la rúbrica proporcional del entregable",
    authority: "agent",
    ownership: "cli-owned",
    document: QUICK_LOOP,
    attribution: QUICK_ATTRIBUTION,
    // One signal, and it is the one the next row's condition reads: whether what
    // is being verified is a rubric a person has to ratify, or a check that runs.
    signals: ["quick.deliverable-is-analysis"],
  },
  {
    id: "quick.success-criteria-ratification",
    scope: "quick",
    title: "ratificar la rúbrica cuando el entregable es análisis o diseño",
    authority: "human",
    ownership: "cli-owned",
    document: QUICK_LOOP,
    attribution: QUICK_ATTRIBUTION,
    condition: {
      threshold: { observed: "quick.success-criteria-authoring", min: 1 },
      otherwise:
        "el entregable no es análisis ni diseño: su criterio es una prueba que corre, y no se ratifica",
    },
  },
  {
    id: "quick.artifact-seed-order",
    scope: "quick",
    title: "sembrar objetivo, criterios y CHECKPOINT antes de trabajar",
    authority: "cli",
    ownership: "cli-owned",
    document: QUICK_LOOP,
    attribution: QUICK_ATTRIBUTION,
    effects: ["local_additive"],
    // Verification-first is only real if the seed is checkable: the three pieces
    // come back as the artifacts' actual content, not as a claim that they were
    // written.
    action: {
      invocation: {
        program: "aw",
        args: ["session-artifacts", "--code", "{code}", "--dump", "objetivo,checkpoint"],
        target: SESSION_TARGET,
        input: null,
      },
      execution: {
        kind: "internal",
        operation: "session.artifacts",
        dump: ["objetivo", "checkpoint"],
      },
      evidence: [
        "quick.objetivo-sembrado",
        "quick.criterios-sembrados",
        "quick.checkpoint-sembrado",
      ],
      idempotent: true,
      recovery:
        "sembrá lo que falte (objetivo, criterios de éxito y CHECKPOINT.Pending) y volvé a devolver el dump: sembrar de nuevo lo ya escrito no rompe nada",
    },
  },
  {
    id: "quick.branch-precondition",
    scope: "quick",
    title: "verificar la rama esperada de cada fuente antes de editar",
    authority: "cli",
    ownership: "cli-owned",
    document: CODE_POLICIES_MD,
    attribution: PLAN_ATTRIBUTION,
    // Same read as PLAN's, and for the same reason: `aw check-branch` with no
    // --source resolves no target and passes unconditionally.
    action: {
      invocation: { program: "aw", args: ["sources", "--verbose"], target: ".", input: null },
      execution: {
        kind: "external",
        reason:
          "la rama esperada de cada fuente es un veredicto sobre git, y un workspace sin fuentes declaradas no lo tiene: leerlo desde adentro diría 'verificada' donde no hay nada que verificar",
      },
      evidence: ["quick.rama-verificada"],
      idempotent: true,
      recovery:
        "resolvé la rama de la fuente que no coincide y volvé a leer las fuentes: nunca limpies ni cambies de rama sin confirmación",
    },
  },
  {
    id: "quick.deliverable-authoring",
    scope: "quick",
    title: "producir el cambio mínimo o el análisis que la tarea pide",
    authority: "agent",
    ownership: "cli-owned",
    document: QUICK_LOOP,
    attribution: QUICK_ATTRIBUTION,
  },
  {
    id: "quick.db-touched",
    scope: "quick",
    title: "reconocer si la tarea llegó a tocar una base de datos",
    authority: "agent",
    ownership: "cli-owned",
    document: DB_SCRIPTS_ONLY,
    attribution: PLAN_ATTRIBUTION,
    // A quick that never went near a database has no statement to derive and no
    // `SCRIPTS.sql` to hand back, so the row below it used to demand an artifact
    // that should not exist. Declaring the signal is what lets the rule apply
    // exactly where it has something to govern.
    signals: ["quick.db-touched"],
  },
  {
    id: "quick.db-scripts-only",
    scope: "quick",
    title: "derivar todo DDL o DML al script de la sesión sin ejecutarlo",
    authority: "cli",
    ownership: "cli-owned",
    document: DB_SCRIPTS_ONLY,
    attribution: PLAN_ATTRIBUTION,
    effects: ["local_additive"],
    condition: {
      threshold: { observed: "quick.db-touched", of: ["quick.db-touched"], min: 1 },
      otherwise: "la tarea no tocó ninguna base de datos: no hay sentencia que derivar",
    },
    // Migrated with the PLAN tranche and not with QUICK, for the same reason
    // CODE-POLICIES was: `plan-exec` reads this module too, and retiring its rule
    // while execution still decided from it would have left that journey without
    // it. What comes back is the script itself — the whole point of the rule is
    // that the statement was WRITTEN and not run.
    action: {
      invocation: {
        program: "aw",
        args: ["session-artifacts", "--code", "{code}", "--dump", "scripts"],
        target: SESSION_TARGET,
        input: null,
      },
      execution: { kind: "internal", operation: "session.artifacts", dump: ["scripts"] },
      evidence: ["quick.scripts-derivados"],
      idempotent: true,
      recovery:
        "escribí el DDL o DML en el SCRIPTS.sql de la sesión y volvé a devolver el dump; ejecutarlo no es una alternativa que este contrato admita",
    },
  },
  {
    id: "quick.growth-escalation",
    scope: "quick",
    title: "aplicar el mismo umbral de señales cuando la tarea crece a mitad del loop",
    authority: "cli",
    ownership: "cli-owned",
    document: QUICK_LOOP,
    attribution: QUICK_ATTRIBUTION,
    // "The same threshold" as the entry gate, and it is the same one: the mid-loop
    // escalation re-applies `ENTRY_SIZE_THRESHOLD` over the signals declared then.
  },
  {
    id: "quick.escalation-destination",
    scope: "quick",
    title: "resolver SPEC en vivo y PLAN diferido como destinos de la escalación",
    authority: "cli",
    ownership: "cli-owned",
    document: QUICK_LOOP,
    attribution: QUICK_ATTRIBUTION,
  },
  {
    id: "quick.convergence-gate",
    scope: "quick",
    title: "evaluar los criterios proporcionales de la tarea",
    authority: "cli",
    ownership: "cli-owned",
    document: QUICK_LOOP,
    attribution: QUICK_ATTRIBUTION,
    effects: ["execute"],
    // The criteria are authored per task, so no fixed runner can be named without
    // inventing a rule this CLI does not have. What it CAN name is the artifact
    // that holds them — and it demands back the real output of running them.
    // Running the checks the run itself declared is the run keeping its own
    // books, so custody covers the `execute` and the boundary emitted is the
    // execution one — what stays non-negotiable is the real output.
    custody: "run",
    action: {
      invocation: {
        program: "aw",
        args: ["session-artifacts", "--code", "{code}", "--dump", "objetivo"],
        target: SESSION_TARGET,
        input: null,
      },
      execution: {
        kind: "external",
        reason:
          "los criterios verdes exigen haber CORRIDO la prueba del entregable, y correr código nunca es una operación interna",
      },
      evidence: ["quick.criterios-verdes"],
      idempotent: true,
      recovery:
        "arreglá lo que el criterio reprobó y volvé a correr sus validaciones: la transición sigue pendiente hasta que su salida real vuelva en verde",
    },
  },
  {
    id: "quick.review-precedence",
    scope: "quick",
    title: "exigir el gate de revisión antes de proponer el commit",
    authority: "cli",
    ownership: "cli-owned",
    document: CODE_POLICIES_MD,
    attribution: PLAN_ATTRIBUTION,
  },
  {
    id: "quick.review-findings",
    scope: "quick",
    title: "releer el diff y juzgar sus hallazgos con las convenciones instaladas",
    authority: "agent",
    ownership: "cli-owned",
    document: CODE_POLICIES_MD,
    attribution: PLAN_ATTRIBUTION,
  },
  {
    id: "quick.commit-authorization",
    scope: "quick",
    title: "aprobar el commit propuesto de la tarea",
    authority: "human",
    ownership: "cli-owned",
    document: CODE_POLICIES_MD,
    attribution: PLAN_ATTRIBUTION,
    alternatives: [
      {
        label: "Aprobar el commit",
        consequence:
          "se crea un solo commit al cierre de la tarea; sin push, sin --amend y sin --no-verify",
        recommended: true,
      },
      {
        label: "Dejar la tarea sin commitear",
        consequence: "los cambios quedan en el árbol de trabajo y la tarea se registra en BACKLOG",
        recommended: false,
      },
    ],
  },

  // ── SPEC ──────────────────────────────────────────────────────────────────
  {
    id: "spec-refine.session",
    scope: "spec-refine",
    title: "abrir o reanudar la sesión de refinamiento de la spec",
    authority: "cli",
    ownership: "cli-owned",
    document: SPEC_LOOP,
    attribution: SPEC_ATTRIBUTION,
    effects: ["local_additive"],
    // Same shape as QUICK's: the engine cannot author the descriptor, so what it
    // names is the read that proves the session it runs inside exists as an
    // artifact — with its objective and its seeded criteria.
    action: {
      invocation: {
        program: "aw",
        args: ["session-artifacts", "--code", "{code}"],
        target: SESSION_TARGET,
        input: null,
      },
      execution: { kind: "internal", operation: "session.artifacts" },
      evidence: ["spec.session-present"],
      idempotent: true,
      recovery:
        "creá la sesión con 'aw session-create --type refine --name <slug>-spec-refine --objetivo \"<objetivo>\"' y volvé a devolver la lectura",
    },
  },
  {
    id: "spec-refine.baseline-scope",
    scope: "spec-refine",
    title: "decidir cuánto comportamiento actual hace falta establecer",
    authority: "agent",
    ownership: "cli-owned",
    document: SPEC_LOOP,
    attribution: SPEC_ATTRIBUTION,
  },
  {
    id: "spec-refine.change-shape-gate",
    scope: "spec-refine",
    title: "resolver la forma del cambio: una sola spec, dividir o reemplazar",
    authority: "cli",
    ownership: "cli-owned",
    document: CHANGE_SHAPE,
    attribution: SPEC_ATTRIBUTION,
  },
  // The split branch of the shape gate, and its document is the shape module, not
  // `SPLIT-GATE.md`. That was the mis-scoping this tranche had to resolve before
  // it could migrate anything: the three rows carried `spec-new`'s document —
  // which `spec-refine` never loads — so a real run stopped here handing the step
  // back to a file its own read-set had not given it. The steps belong to
  // `SPEC-CHANGE-SHAPE.md`, which already states this branch; the CRITERION stays
  // stated once in `SPLIT-GATE.md`, and the shape module points at it.
  {
    id: "spec-refine.split-signal",
    scope: "spec-refine",
    title: "reconocer cada señal de división en la spec investigada",
    authority: "agent",
    ownership: "cli-owned",
    document: CHANGE_SHAPE,
    attribution: SPEC_ATTRIBUTION,
    signals: [
      "spec.independent-outcomes",
      "spec.enumerated-features",
      "spec.distinct-moments",
      "spec.independent-value",
    ],
  },
  {
    id: "spec-refine.split-gate",
    scope: "spec-refine",
    title: "aplicar el umbral de dos señales que dispara la rama de división",
    authority: "cli",
    ownership: "cli-owned",
    document: CHANGE_SHAPE,
    attribution: SPEC_ATTRIBUTION,
  },
  {
    id: "spec-refine.split-choice",
    scope: "spec-refine",
    title: "elegir entre dividir en varias specs o conservar una sola",
    authority: "human",
    ownership: "cli-owned",
    document: CHANGE_SHAPE,
    attribution: SPEC_ATTRIBUTION,
    // "Borderline, or evidence too thin to tell → one spec, NO QUESTION." Not the
    // PLAN factory even though the number matches: that one counts PLAN's five
    // signals over PLAN's document, and collapsing them would tie two gates that
    // are free to move apart to a single literal.
    condition: {
      threshold: { observed: "spec-refine.split-signal", min: 2 },
      otherwise:
        "el umbral de dos señales no disparó: la spec conserva su forma y no se pregunta nada",
    },
    alternatives: [
      {
        label: "Dividir en varias specs",
        consequence:
          "el original queda reducido a su resultado restante y cada resultado extraído nace como spec hermana",
        recommended: true,
      },
      {
        label: "Una sola spec",
        consequence:
          "el gap queda agotado para esta corrida y el refinamiento sigue sobre esta spec",
        recommended: false,
      },
    ],
  },
  {
    id: "spec-refine.gap-recognition",
    scope: "spec-refine",
    title: "reconocer qué clase de gap tiene la spec delante",
    authority: "agent",
    ownership: "cli-owned",
    document: SPEC_LOOP,
    attribution: SPEC_ATTRIBUTION,
    // Two of the taxonomy's kinds decide whether a later step happens at all, so
    // they travel as declared signals instead of as prose the next reader has to
    // re-derive. Recognizing them is judgment — the taxonomy that explains HOW to
    // recognize them stays in the document.
    signals: ["spec.functional-ambiguity", "spec.solution-space-unexplored"],
  },
  {
    id: "spec-refine.gap-destination",
    scope: "spec-refine",
    title: "clasificar el gap por destino: bloquea SPEC, es de PLAN o se difiere",
    authority: "cli",
    ownership: "cli-owned",
    document: SPEC_LOOP,
    attribution: SPEC_ATTRIBUTION,
  },
  {
    id: "spec-refine.ideation-trigger",
    scope: "spec-refine",
    title: "aplicar el disparador condicional del gate de ideación",
    authority: "cli",
    ownership: "cli-owned",
    document: IDEATION_GATE,
    attribution: SPEC_ATTRIBUTION,
  },
  {
    id: "spec-refine.ideation-consent",
    scope: "spec-refine",
    title: "consentir la ronda de ideación o seguir sin ella",
    authority: "human",
    ownership: "cli-owned",
    document: IDEATION_GATE,
    attribution: SPEC_ATTRIBUTION,
    // "Unexplored solution space is not a universal gap": the gate stays shut
    // unless the signal is declared. Offering it always would burn context on a
    // spec whose direction nobody doubts — the document's own words.
    condition: {
      threshold: {
        observed: "spec-refine.gap-recognition",
        of: ["spec.solution-space-unexplored"],
        min: 1,
      },
      otherwise: "ningún disparador de ideación fue declarado: la spec no abre la ronda divergente",
    },
    alternatives: [
      {
        label: "Explorar ideas",
        consequence:
          "se corre una ronda de ideación y sus veredictos vuelven como un lote propio de la conversación",
        recommended: true,
      },
      {
        label: "Seguir sin ideación",
        consequence: "el gap queda agotado para esta corrida y el refinamiento sigue sin la ronda",
        recommended: false,
      },
    ],
  },
  {
    id: "spec-refine.content-authoring",
    scope: "spec-refine",
    title: "redactar requisito, contexto, criterios y escenarios de la spec",
    authority: "agent",
    ownership: "cli-owned",
    document: SPEC_LOOP,
    attribution: SPEC_ATTRIBUTION,
  },
  {
    id: "spec-refine.functional-ambiguity",
    scope: "spec-refine",
    title: "cerrar una ambigüedad funcional que puede cambiar lo que se construye",
    authority: "human",
    ownership: "cli-owned",
    document: SPEC_LOOP,
    attribution: SPEC_ATTRIBUTION,
    // Only when one was declared. A spec with no ambiguity that stopped to ask
    // about one would train the reader to answer questions with no subject.
    condition: {
      threshold: {
        observed: "spec-refine.gap-recognition",
        of: ["spec.functional-ambiguity"],
        min: 1,
      },
      otherwise:
        "no se declaró ninguna ambigüedad funcional bloqueante: no hay nada que la persona tenga que cerrar",
    },
  },
  {
    id: "spec-refine.design-reuse",
    scope: "spec-refine",
    title: "juzgar si un baseline de diseño compatible sirve o hace falta una revisión nueva",
    authority: "agent",
    ownership: "cli-owned",
    document: "modules/DESIGN-REFERENCES.md",
    // The judgment is the agent's and the criterion stays in the module. What the
    // CLI owns is the step: `aw designs` is what puts the existing baselines in
    // front of whoever judges, so the question is asked over a real inventory
    // instead of a recollection.
    attribution: "`aw designs` lists what the workspace already has",
  },
  {
    id: "spec-refine.design-publication",
    scope: "spec-refine",
    title: "validar y publicar la revisión del package de diseño",
    authority: "cli",
    ownership: "cli-owned",
    document: "modules/DESIGN-REFERENCES.md",
    attribution: "capability over the **UI Design Package v1**",
    effects: ["local_additive"],
  },
  {
    id: "spec-refine.ready-gate",
    scope: "spec-refine",
    title: "evaluar el gate ready-for-plan sobre los criterios declarados",
    authority: "cli",
    ownership: "cli-owned",
    document: SPEC_LOOP,
    attribution: SPEC_ATTRIBUTION,
    // The checklist is the run's own `Success criteria`, seeded before refining.
    // The engine names the read that holds them and demands the real state of
    // each one back: "the gate passed" is not a result.
    action: {
      invocation: {
        program: "aw",
        args: ["session-artifacts", "--code", "{code}", "--dump", "objetivo"],
        target: SESSION_TARGET,
        input: null,
      },
      execution: {
        kind: "external",
        reason:
          "el checklist de ready-for-plan es un juicio sobre lo que dice la spec, no la lectura del artefacto que lo contiene",
      },
      evidence: ["spec.ready-for-plan-checklist"],
      idempotent: true,
      recovery:
        "lo que el checklist reprobó vuelve al loop como gap: resolvelo y volvé a evaluar el gate con su estado real",
    },
  },
  {
    id: "spec-refine.save-proposal",
    scope: "spec-refine",
    title: "entregar los bytes exactos de la spec refinada, con su status ya sellado",
    authority: "agent",
    ownership: "cli-owned",
    document: SPEC_LOOP,
    attribution: SPEC_ATTRIBUTION,
    // The stamp travels INSIDE these bytes, and that is the whole reason the
    // separate promotion row is gone: `status: ready-for-plan` is a projection of
    // the same save, so writing it apart made the person confirm one half and
    // authorize the other. One document, one proposal, one write.
    proposes: {
      destinations: ["docs/specs"],
      effects: ["local_additive", "mutate_overwrite"],
      limits: { maxArtifacts: 8, maxArtifactBytes: 256 * 1024 },
    },
  },
  {
    id: "spec-refine.save-confirmation",
    scope: "spec-refine",
    title: "aprobar la vista previa de la spec y guardarla",
    authority: "human",
    ownership: "cli-owned",
    document: SPEC_LOOP,
    attribution: SPEC_ATTRIBUTION,
    // BEFORE the stamp, and the real walk is what proved it: the migrated journey
    // was promoting the status and asking for the overwrite afterwards, so the
    // person would have been confirming a write that already happened. The
    // doctrine's own line is `edit_in_place_with_confirm(spec) + stamp`.
    publishes: { approve: "Aprobar y guardar" },
    alternatives: [
      {
        label: "Aprobar y guardar",
        consequence:
          "se escriben exactamente los archivos de la vista previa —la spec en su lugar, sellada como ready-for-plan— y no se vuelve a preguntar por esos efectos",
        recommended: true,
      },
      {
        label: "Refinar",
        consequence: "el refinamiento sigue abierto, no se escribe nada y la spec queda como está",
        recommended: false,
      },
    ],
  },
  {
    id: "spec-refine.publication",
    scope: "spec-refine",
    title: "publicar la propuesta aprobada de la spec en un solo acto",
    authority: "cli",
    ownership: "cli-owned",
    document: SPEC_LOOP,
    attribution: SPEC_ATTRIBUTION,
    effects: ["local_additive", "mutate_overwrite"],
    action: {
      invocation: { program: "aw", args: ["flow", "advance"], target: ".", input: null },
      execution: { kind: "internal", operation: "proposal.publish" },
      evidence: ["spec.propuesta-publicada"],
      idempotent: true,
      recovery:
        "la publicación es todo-o-nada: si falló, nada quedó escrito y se reintenta el mismo contenido sin volver a aprobar; si la base cambió, volvé a redactar la propuesta sobre el documento vigente",
    },
  },

  // ── PLAN — new ────────────────────────────────────────────────────────────
  //
  // The third tranche, and the one with the most effect surface: it writes plan
  // documents, runs checks and reaches Git. Row ORDER is left exactly as the
  // previous tranches found it wherever the doctrine does not force a change —
  // reordering without evidence would be a claim about the journey nobody made.
  {
    id: "plan-new.spec-readiness",
    scope: "plan-new",
    title: "leer el status de la spec y sugerir refinar sin bloquear",
    authority: "cli",
    ownership: "cli-owned",
    document: PLAN_NEW_LOOP,
    attribution: PLAN_ATTRIBUTION,
    // "Read from the spec's frontmatter `status`, never from the filename" — so
    // what the run credits is the board's reading of that document, not a claim
    // that somebody looked. Suggesting is the outcome; it never blocks.
    action: {
      invocation: { program: "aw", args: ["status", "--json"], target: ".", input: null },
      execution: { kind: "internal", operation: "workspace.board" },
      evidence: ["plan.spec-status-leido"],
      idempotent: true,
      recovery:
        "volvé a correr 'aw status --json' y devolvé su salida real; sin el status de la spec no hay nada que sugerir ni que dar por listo",
    },
  },
  {
    id: "plan-new.session",
    scope: "plan-new",
    title: "abrir o reanudar la sesión de generación del plan",
    authority: "cli",
    ownership: "cli-owned",
    document: PLAN_NEW_LOOP,
    attribution: PLAN_ATTRIBUTION,
    effects: ["local_additive"],
    action: {
      invocation: {
        program: "aw",
        args: ["session-artifacts", "--code", "{code}"],
        target: SESSION_TARGET,
        input: null,
      },
      execution: { kind: "internal", operation: "session.artifacts" },
      evidence: ["plan.session-present"],
      idempotent: true,
      recovery:
        "creá la sesión con 'aw session-create --type refine --name <slug>-plan-new --objetivo \"<objetivo>\"' y volvé a devolver la lectura",
    },
  },
  {
    id: "plan-new.slug-derivation",
    scope: "plan-new",
    title: "derivar el slug del plan desde el requisito de la spec",
    authority: "agent",
    ownership: "cli-owned",
    document: PLAN_NEW_LOOP,
    attribution: PLAN_ATTRIBUTION,
  },
  {
    id: "plan-new.numbering",
    scope: "plan-new",
    title: "reclamar para esta corrida el correlativo del documento del plan",
    authority: "cli",
    ownership: "cli-owned",
    // The numbering contract is `PLAN-INPUT` § *Numbering* and the loop says so
    // itself ("Naming follows PLAN-INPUT"): the invocation lives there once, and
    // this row cites the document that actually rules it.
    document: PLAN_INPUT,
    attribution: "aw next-number docs/plans --claim",
    // The row used to be attribution and nothing else: no effect, no evidence, no
    // result. So the number was "assigned" by whoever narrated it, and the engine
    // credited a transition that had never touched the workspace — which is also
    // why nothing downstream could tell this run's slot from a stranger's file.
    // The claim is a WRITE and now travels as one, with the slot it produced as
    // the evidence.
    effects: ["local_additive"],
    action: {
      invocation: {
        program: "aw",
        args: ["next-number", "docs/plans", "--claim", "plan-{slug}.md", "--code", "{code}"],
        target: ".",
        input: null,
      },
      execution: {
        kind: "external",
        reason:
          "la reserva la materializa el comando bajo el candado del workspace y devuelve su claimed_path: el motor nombra el reclamo pero no lo mintea",
      },
      evidence: ["plan.numero-reclamado"],
      // Asking again returns the SAME slot: the claim recognizes a reservation this
      // session already holds under this name instead of minting a second one.
      idempotent: true,
      recovery:
        "volvé a correr el reclamo con el mismo --claim y el mismo --code: devuelve la reserva que ya tenés. Sin claimed_path no hay slot que completar, y sin --code la reserva es de nadie y el guardado la rechazará",
    },
  },
  {
    id: "plan-new.phase-shaping",
    scope: "plan-new",
    title: "agrupar el trabajo en estados verificables del sistema",
    authority: "agent",
    ownership: "cli-owned",
    document: PLAN_NEW_LOOP,
    attribution: PLAN_ATTRIBUTION,
  },
  {
    id: "plan-new.batch-eligibility-signal",
    scope: "plan-new",
    title: "reconocer qué hecho observable rompe la elegibilidad de un rango continuo",
    authority: "agent",
    ownership: "cli-owned",
    document: BATCHES_MD,
    attribution: PLAN_ATTRIBUTION,
    // The module's five eligibility conditions, stated as what BREAKS them. The
    // document phrased them as "the AI infers from observable facts, not a
    // preference question" — and that is exactly the frontier: seeing the fact is
    // judgment, turning it into `isolated` is the rule below.
    signals: [...BATCH_ELIGIBILITY_SIGNALS],
  },
  {
    id: "plan-new.batch-inference",
    scope: "plan-new",
    title: "inferir la partición máxima de execution batches",
    authority: "cli",
    ownership: "cli-owned",
    document: BATCHES_MD,
    attribution: PLAN_ATTRIBUTION,
  },
  {
    id: "plan-new.batch-isolation",
    scope: "plan-new",
    title: "aislar el rango cuyo hecho observable rompe su elegibilidad",
    authority: "cli",
    ownership: "cli-owned",
    document: BATCHES_MD,
    attribution: PLAN_ATTRIBUTION,
    condition: {
      threshold: ineligibleRange("plan-new.batch-eligibility-signal"),
      otherwise:
        "ningún hecho observable rompe la elegibilidad: el rango máximo entra entero como un batch continuo",
    },
  },
  {
    id: "plan-new.split-signal",
    scope: "plan-new",
    title: "reconocer cada señal de división en tramos del plan",
    authority: "agent",
    ownership: "cli-owned",
    document: PLAN_SPLIT_GATE,
    attribution: PLAN_ATTRIBUTION,
    signals: [...PLAN_SPLIT_SIGNALS],
  },
  {
    id: "plan-new.split-gate",
    scope: "plan-new",
    title: "aplicar el umbral de dos señales del gate multi-plan",
    authority: "cli",
    ownership: "cli-owned",
    document: PLAN_SPLIT_GATE,
    attribution: PLAN_ATTRIBUTION,
  },
  {
    id: "plan-new.split-choice",
    scope: "plan-new",
    title: "elegir entre dividir en varios planes o conservar uno solo",
    authority: "human",
    ownership: "cli-owned",
    document: PLAN_SPLIT_GATE,
    attribution: PLAN_ATTRIBUTION,
    // "It fires ONLY on clear signals… borderline → one plan, no question." A
    // directed journey that asked anyway would ask what the doctrine it replaces
    // explicitly refuses to ask.
    condition: {
      threshold: splitThreshold("plan-new.split-signal"),
      otherwise:
        "el umbral de dos señales no disparó: el trabajo queda en un solo plan y no se pregunta nada",
    },
    alternatives: [
      {
        label: "Dividir en varios planes",
        consequence:
          "cada tramo se elabora completo como plan hermano, con su origen y el orden entre ellos",
        recommended: true,
      },
      {
        label: "Un solo plan",
        consequence: "el gap queda agotado para esta corrida y el trabajo sigue como un plan único",
        recommended: false,
      },
    ],
  },
  {
    id: "plan-new.coherence-gate",
    scope: "plan-new",
    title: "evaluar el gate de coherencia del plan generado",
    authority: "cli",
    ownership: "cli-owned",
    document: PLAN_NEW_LOOP,
    attribution: PLAN_ATTRIBUTION,
    // Same shape as SPEC's ready gate: the checklist is the run's own `Success
    // criteria`, seeded before planning, and what comes back is the real state of
    // each line. "The gate passed" is not a result.
    action: {
      invocation: {
        program: "aw",
        args: ["session-artifacts", "--code", "{code}", "--dump", "objetivo"],
        target: SESSION_TARGET,
        input: null,
      },
      execution: {
        kind: "external",
        reason:
          "la coherencia del plan es un juicio sobre lo que dice, no la lectura del artefacto que lo contiene",
      },
      evidence: ["plan.coherence-checklist"],
      idempotent: true,
      recovery:
        "lo que el checklist reprobó vuelve al loop como gap: resolvelo y volvé a evaluar el gate con su estado real",
    },
  },
  {
    id: "plan-new.save-proposal",
    scope: "plan-new",
    title: "entregar los bytes exactos del plan y de los hermanos que se extraigan",
    authority: "agent",
    ownership: "cli-owned",
    document: PLAN_NEW_LOOP,
    attribution: PLAN_ATTRIBUTION,
    // The generation used to write with NO effect row at all: the person confirmed
    // and the document appeared, with the engine crediting nothing. The proposal
    // is what makes that write visible — enumerated, weighed and sealed before it
    // is approved.
    proposes: {
      destinations: ["docs/plans"],
      effects: ["local_additive"],
      limits: { maxArtifacts: 8, maxArtifactBytes: 256 * 1024 },
    },
  },
  {
    id: "plan-new.save-confirmation",
    scope: "plan-new",
    title: "aprobar la vista previa del plan y guardarlo",
    authority: "human",
    ownership: "cli-owned",
    document: PLAN_NEW_LOOP,
    attribution: PLAN_ATTRIBUTION,
    publishes: { approve: "Aprobar y guardar" },
    alternatives: [
      {
        label: "Aprobar y guardar",
        consequence:
          "se escriben exactamente los archivos de la vista previa en docs/plans, hermanos incluidos si el split fue aceptado",
        recommended: true,
      },
      {
        label: "Refinar",
        consequence: "la generación sigue abierta y no se escribe ningún documento",
        recommended: false,
      },
    ],
  },
  {
    id: "plan-new.publication",
    scope: "plan-new",
    title: "publicar la propuesta aprobada del plan en un solo acto",
    authority: "cli",
    ownership: "cli-owned",
    document: PLAN_NEW_LOOP,
    attribution: PLAN_ATTRIBUTION,
    effects: ["local_additive"],
    action: {
      invocation: { program: "aw", args: ["flow", "advance"], target: ".", input: null },
      execution: { kind: "internal", operation: "proposal.publish" },
      evidence: ["plan.propuesta-publicada"],
      idempotent: true,
      recovery:
        "la publicación es todo-o-nada: si falló, no quedó ningún documento a medias y se reintenta el mismo contenido sin volver a aprobar",
    },
  },
  {
    id: "plan-new.adoption",
    scope: "plan-new",
    title: "adoptar en una sola pasada un plan construido fuera del loop",
    authority: "cli",
    ownership: "cli-owned",
    document: PLAN_INPUT,
    attribution: PLAN_ATTRIBUTION,
  },

  // ── PLAN — refine ─────────────────────────────────────────────────────────
  {
    id: "plan-refine.session",
    scope: "plan-refine",
    title: "abrir, reanudar o reabrir la sesión de refinamiento del plan",
    authority: "cli",
    ownership: "cli-owned",
    document: PLAN_REFINE_LOOP,
    attribution: PLAN_ATTRIBUTION,
    effects: ["local_additive"],
    action: {
      invocation: {
        program: "aw",
        args: ["session-artifacts", "--code", "{code}"],
        target: SESSION_TARGET,
        input: null,
      },
      execution: { kind: "internal", operation: "session.artifacts" },
      evidence: ["plan.session-present"],
      idempotent: true,
      recovery:
        "creá o reabrí la sesión con 'aw session-create' o 'aw session-resume --code <NNN> --reopen' y volvé a devolver la lectura",
    },
  },
  {
    id: "plan-refine.journey-map",
    scope: "plan-refine",
    title: "mapear contrato observable, recorrido técnico, estrategia incremental y evidencia",
    authority: "agent",
    ownership: "cli-owned",
    document: PLAN_REFINE_LOOP,
    attribution: PLAN_ATTRIBUTION,
  },
  {
    id: "plan-refine.preserve-validated",
    scope: "plan-refine",
    title: "conservar las fases validadas y rediseñar solo el trabajo pendiente",
    authority: "cli",
    ownership: "cli-owned",
    document: PLAN_REFINE_LOOP,
    attribution: PLAN_ATTRIBUTION,
  },
  {
    id: "plan-refine.batch-eligibility-signal",
    scope: "plan-refine",
    title: "reconocer qué hecho observable rompe la elegibilidad de un rango continuo",
    authority: "agent",
    ownership: "cli-owned",
    document: BATCHES_MD,
    attribution: PLAN_ATTRIBUTION,
    signals: [...BATCH_ELIGIBILITY_SIGNALS],
  },
  {
    id: "plan-refine.batch-reinference",
    scope: "plan-refine",
    title: "re-inferir y escribir la partición completa de batches",
    authority: "cli",
    ownership: "cli-owned",
    document: BATCHES_MD,
    attribution: PLAN_ATTRIBUTION,
  },
  {
    id: "plan-refine.batch-isolation",
    scope: "plan-refine",
    title: "aislar el rango cuyo hecho observable rompe su elegibilidad",
    authority: "cli",
    ownership: "cli-owned",
    document: BATCHES_MD,
    attribution: PLAN_ATTRIBUTION,
    condition: {
      threshold: ineligibleRange("plan-refine.batch-eligibility-signal"),
      otherwise:
        "ningún hecho observable rompe la elegibilidad: el rango máximo entra entero como un batch continuo",
    },
  },
  {
    id: "plan-refine.split-signal",
    scope: "plan-refine",
    title: "reconocer cada señal de división sobre el plan que ya existe",
    authority: "agent",
    ownership: "cli-owned",
    document: PLAN_SPLIT_GATE,
    attribution: PLAN_ATTRIBUTION,
    // The gate is defined ONCE in that module and this loop only adds the
    // in-place semantics — so the signals are read from the same vocabulary. The
    // row exists per journey because a threshold may only count signals declared
    // inside the journey it belongs to.
    signals: [...PLAN_SPLIT_SIGNALS],
  },
  {
    id: "plan-refine.executability-gate",
    scope: "plan-refine",
    title: "evaluar el gate de ejecutabilidad del plan",
    authority: "cli",
    ownership: "cli-owned",
    document: PLAN_REFINE_LOOP,
    attribution: PLAN_ATTRIBUTION,
    action: {
      invocation: {
        program: "aw",
        args: ["session-artifacts", "--code", "{code}", "--dump", "objetivo"],
        target: SESSION_TARGET,
        input: null,
      },
      execution: {
        kind: "external",
        reason:
          "la forma ejecutable del plan es un juicio sobre lo que dice, no la lectura del artefacto que lo contiene",
      },
      evidence: ["plan.executability-checklist"],
      idempotent: true,
      recovery:
        "lo que el checklist reprobó vuelve al loop como gap: resolvelo y volvé a evaluar el gate con su estado real",
    },
  },
  {
    id: "plan-refine.split-in-place",
    scope: "plan-refine",
    title: "reducir el plan original y extraer los hermanos sin mover trabajo completado",
    authority: "agent",
    ownership: "cli-owned",
    document: PLAN_REFINE_SPLIT,
    attribution: PLAN_ATTRIBUTION,
    // It used to be a delegated WRITE after the confirmation, which is what made
    // the refinement ask twice: once to confirm the plan and again to authorize
    // the siblings. Reducing the original and extracting the siblings is drafting
    // — it decides what the bytes are — so it happens BEFORE the proposal and its
    // result is visible where it belongs, as files enumerated in the preview.
    // Nothing is credited here: this row no longer claims a write happened.
    condition: {
      threshold: splitThreshold("plan-refine.split-signal"),
      otherwise:
        "el umbral de dos señales no disparó: el plan conserva su número y su alcance, y no se extrae ningún hermano",
    },
  },
  {
    id: "plan-refine.save-proposal",
    scope: "plan-refine",
    title:
      "entregar los bytes exactos del plan refinado, ya normalizado, sin bloques condicionales vacíos y sin tocar estados ni casillas",
    authority: "agent",
    ownership: "cli-owned",
    document: PLAN_REFINE_LOOP,
    attribution: PLAN_ATTRIBUTION,
    // The normalization rule lives in this row's own contract now, and that is the
    // merge that removes a write: normalizing the form is not a second edit of the
    // plan, it is what the drafted bytes already are. A separate row for it wrote
    // the same document twice and asked to be authorized for the second half.
    proposes: {
      destinations: ["docs/plans"],
      effects: ["local_additive", "mutate_overwrite"],
      limits: { maxArtifacts: 8, maxArtifactBytes: 256 * 1024 },
    },
  },
  {
    id: "plan-refine.save-confirmation",
    scope: "plan-refine",
    title: "aprobar la vista previa del plan refinado y guardarlo",
    authority: "human",
    ownership: "cli-owned",
    document: PLAN_REFINE_LOOP,
    attribution: PLAN_ATTRIBUTION,
    publishes: { approve: "Aprobar y guardar" },
    alternatives: [
      {
        label: "Aprobar y guardar",
        consequence:
          "se escriben exactamente los archivos de la vista previa —el plan en su lugar y los hermanos extraídos, si los hay— y no se vuelve a preguntar por esos efectos",
        recommended: true,
      },
      {
        label: "Refinar",
        consequence: "el refinamiento sigue abierto, no se escribe nada y el plan queda como está",
        recommended: false,
      },
    ],
  },
  {
    id: "plan-refine.publication",
    scope: "plan-refine",
    title: "publicar la propuesta aprobada del plan refinado en un solo acto",
    authority: "cli",
    ownership: "cli-owned",
    document: PLAN_REFINE_LOOP,
    attribution: PLAN_ATTRIBUTION,
    effects: ["local_additive", "mutate_overwrite"],
    action: {
      invocation: { program: "aw", args: ["flow", "advance"], target: ".", input: null },
      execution: { kind: "internal", operation: "proposal.publish" },
      evidence: ["plan.propuesta-publicada"],
      idempotent: true,
      recovery:
        "la publicación es todo-o-nada: el original reducido y sus hermanos entran juntos o no entra ninguno; si la base cambió, volvé a redactar la propuesta sobre el plan vigente",
    },
  },

  // ── PLAN — exec ───────────────────────────────────────────────────────────
  {
    id: "plan-exec.session",
    scope: "plan-exec",
    title: "abrir o reanudar la sesión única de la corrida de ejecución",
    authority: "cli",
    ownership: "cli-owned",
    document: PLAN_EXEC_LOOP,
    attribution: PLAN_ATTRIBUTION,
    effects: ["local_additive"],
    action: {
      invocation: {
        program: "aw",
        args: ["session-artifacts", "--code", "{code}"],
        target: SESSION_TARGET,
        input: null,
      },
      execution: { kind: "internal", operation: "session.artifacts" },
      evidence: ["plan.session-present"],
      idempotent: true,
      recovery:
        "creá la sesión con 'aw session-create --type exec --name <slug>-plan-exec --objetivo \"<objetivo>\"' y volvé a devolver la lectura",
    },
  },
  {
    id: "plan-exec.entry-gate",
    scope: "plan-exec",
    title: "verificar en la entrada que el plan tiene forma ejecutable",
    authority: "cli",
    ownership: "cli-owned",
    document: PLAN_EXEC_LOOP,
    attribution: PLAN_ATTRIBUTION,
    // The board already parses what the gate checks — the phase blocks, their
    // state lines and the plan's own status — so what comes back is that reading
    // and not "I read the plan". A plan whose shape the board cannot resolve is
    // the gate's finding, not a detail to wave through.
    action: {
      invocation: { program: "aw", args: ["status", "--json"], target: ".", input: null },
      execution: {
        kind: "external",
        reason:
          "la forma ejecutable del plan es un juicio sobre lo que dice, no la lectura del tablero que lo lista",
      },
      evidence: ["plan.forma-ejecutable"],
      idempotent: true,
      recovery:
        "volvé a correr 'aw status --json' y devolvé su salida real; si el plan no se puede leer, eso ES el hallazgo del gate",
    },
  },
  {
    id: "plan-exec.entry-gap-recognition",
    scope: "plan-exec",
    title: "reconocer qué clase de hueco dejó el gate de entrada",
    authority: "agent",
    ownership: "cli-owned",
    document: PLAN_EXEC_LOOP,
    attribution: PLAN_ATTRIBUTION,
    // Two signals for two different consequences, and neither is "no gap": a plan
    // that passes the gate declares nothing here, which is what makes both rules
    // below skip. Recognizing the class is judgment; what each class costs is the
    // rule the CLI applies.
    signals: ["plan.entry-gap-minor", "plan.entry-gap-structural"],
  },
  {
    id: "plan-exec.entry-gap-severity",
    scope: "plan-exec",
    title: "distinguir un hueco menor de uno estructural en el plan",
    authority: "cli",
    ownership: "cli-owned",
    document: PLAN_EXEC_LOOP,
    attribution: PLAN_ATTRIBUTION,
    condition: {
      threshold: { observed: "plan-exec.entry-gap-recognition", min: 1 },
      otherwise: "el gate de entrada no encontró ningún hueco: no hay severidad que clasificar",
    },
  },
  {
    id: "plan-exec.normalization-consent",
    scope: "plan-exec",
    title: "consentir la normalización del plan o derivar a plan-refine",
    authority: "human",
    ownership: "cli-owned",
    document: PLAN_EXEC_LOOP,
    attribution: PLAN_ATTRIBUTION,
    // ONLY the minor gap is offered. A structural one "does not improvise": it
    // leaves this loop, and putting `Normalizar y ejecutar` in front of somebody
    // holding a structural gap is how a plan gets patched instead of refined.
    condition: {
      threshold: {
        observed: "plan-exec.entry-gap-recognition",
        of: ["plan.entry-gap-minor"],
        min: 1,
      },
      otherwise: "no se declaró ningún hueco menor: no hay normalización que consentir",
    },
    alternatives: [
      {
        label: "Normalizar y ejecutar",
        consequence:
          "los bloques de fase se editan en su lugar sin agregar alcance ni mover ninguna frontera, y la ejecución sigue",
        recommended: true,
      },
      {
        label: "Ir a plan-refine",
        consequence:
          "la ejecución no arranca: el hallazgo queda en CHECKPOINT y el trabajo sigue en /w:plan-refine",
        recommended: false,
      },
    ],
  },
  {
    id: "plan-exec.batch-eligibility-signal",
    scope: "plan-exec",
    title: "reconocer qué hecho del checkout vivo rompe la elegibilidad de un rango",
    authority: "agent",
    ownership: "cli-owned",
    document: BATCHES_MD,
    attribution: PLAN_ATTRIBUTION,
    // Execution observes the same five facts as planning, but over live state —
    // dependencies, branches, working trees, blockers and risks — which is why it
    // may merge or split what the plan declared without asking.
    signals: [...BATCH_ELIGIBILITY_SIGNALS],
  },
  {
    id: "plan-exec.batch-inference",
    scope: "plan-exec",
    title: "re-inferir los batches efectivos sobre el estado vivo",
    authority: "cli",
    ownership: "cli-owned",
    document: BATCHES_MD,
    attribution: PLAN_ATTRIBUTION,
  },
  {
    id: "plan-exec.batch-isolation",
    scope: "plan-exec",
    title: "aislar el rango cuyo hecho del checkout vivo rompe su elegibilidad",
    authority: "cli",
    ownership: "cli-owned",
    document: BATCHES_MD,
    attribution: PLAN_ATTRIBUTION,
    condition: {
      threshold: ineligibleRange("plan-exec.batch-eligibility-signal"),
      otherwise:
        "ningún hecho del checkout vivo rompe la elegibilidad: el rango máximo entra entero como un batch continuo",
    },
  },
  {
    id: "plan-exec.design-precondition",
    scope: "plan-exec",
    title: "resolver el veredicto de diseño de una tarea que pinea una referencia",
    authority: "cli",
    ownership: "cli-owned",
    document: "modules/DESIGN-REFERENCES.md",
    attribution: "`aw designs --plan`",
  },
  {
    id: "plan-exec.source-scope",
    scope: "plan-exec",
    title: "fijar el plan de la corrida y las fuentes exactas que va a editar",
    authority: "agent",
    ownership: "cli-owned",
    document: CODE_POLICIES_MD,
    attribution: PLAN_ATTRIBUTION,
    // Which sources a plan touches is read off the plan, and the engine never read
    // one — so this is judgment, and it is the only thing here that is. What the
    // answer hands over is CHECKED before it is persisted: an alias the WORKSPACE
    // block does not declare, or one the plan never names, is refused. That is the
    // half a rule can hold; the other half is why the row exists at all.
    //
    // It carries no signals on purpose. A vocabulary would be a verdict over a
    // fixed taxonomy, and the aliases of a workspace are not one.
    scopes_sources: true,
  },
  {
    id: "plan-exec.unit-acquisition",
    scope: "plan-exec",
    title: "adquirir la unidad de aislamiento de cada fuente del scope antes de editar",
    authority: "cli",
    ownership: "cli-owned",
    document: CODE_POLICIES_MD,
    attribution: PLAN_ATTRIBUTION,
    effects: ["local_additive"],
    // BEFORE `plan-exec.implementation`, and the position is the whole rule: the
    // policy says a loop that edits code edits inside its unit, and a unit obtained
    // after the first write would be an isolation nobody was ever isolated by.
    //
    // Idempotent because the underlying service is: a unit that already exists is
    // returned as it is, which is what makes resuming reuse the same tree instead
    // of cutting a second one — and what makes the effect true on re-entry, since
    // the tree IS there however it got there.
    action: {
      invocation: {
        program: "aw",
        args: ["worktree", "ensure", "--code", "{code}"],
        target: ".",
        input: null,
      },
      execution: { kind: "internal", operation: "worktree.ensure" },
      evidence: ["plan.unidades-adquiridas"],
      idempotent: true,
      recovery:
        "adquirí una unidad por alias del scope con 'aw worktree ensure --source <alias> --code <NNN>'; si la rama está tomada por otro árbol, es otro flujo el que la tiene y hay que cerrarlo o liberarla, nunca forzarla",
    },
  },
  {
    id: "plan-exec.branch-precondition",
    scope: "plan-exec",
    title: "verificar la rama y el árbol de la unidad de cada fuente antes del batch",
    authority: "cli",
    ownership: "cli-owned",
    document: CODE_POLICIES_MD,
    attribution: PLAN_ATTRIBUTION,
    // "Before editing… verify EVERY current branch" — every, y bajo aislamiento la
    // rama que importa es la de la UNIDAD, no la del checkout compartido. Leía
    // `aw sources --verbose`, que informa el checkout: con dos corridas sobre el
    // mismo source esa lectura da verde en la rama de trabajo de alguien más y
    // acredita "rama verificada" contra un árbol que este flujo no edita.
    //
    // `aw worktree list --code` es la lectura ligada a la sesión: sólo las unidades
    // de esta corrida, cada una con su path, su rama `aw/<sesión>`, su estado sucio
    // y su HEAD. Una fuente del scope sin unidad no aparece, y esa ausencia es
    // exactamente lo que deja la frontera pendiente.
    //
    // (`aw check-branch` sigue sin poder servir acá: sin --source no resuelve
    // ningún target y contesta `match: true` incondicional.)
    action: {
      invocation: {
        program: "aw",
        args: ["worktree", "list", "--code", "{code}"],
        target: ".",
        input: null,
      },
      execution: {
        kind: "external",
        reason:
          "la unidad esperada de cada fuente es un veredicto sobre git, y una corrida sin unidades todavía no lo tiene",
      },
      evidence: ["plan.rama-verificada"],
      idempotent: true,
      recovery:
        "a la fuente del scope que no tiene su unidad, dásela con 'aw worktree ensure --source <alias> --code <NNN>' y volvé a leer; nunca limpies ni cambies de rama sin confirmación",
    },
  },
  {
    id: "plan-exec.implementation",
    scope: "plan-exec",
    title: "implementar el trabajo mínimo de cada tarea de la fase",
    authority: "agent",
    ownership: "cli-owned",
    document: PLAN_EXEC_LOOP,
    attribution: PLAN_ATTRIBUTION,
  },
  {
    id: "plan-exec.deviation-recognition",
    scope: "plan-exec",
    title: "reconocer qué toca el cambio que apareció al implementar",
    authority: "agent",
    ownership: "cli-owned",
    document: PLAN_EXEC_LOOP,
    attribution: PLAN_ATTRIBUTION,
    // Only the two that LEAVE the loop are signals. A local decision declares
    // nothing, which is the doctrine's own default — "plan-exec continues" — and
    // it is what keeps the gate below from stopping a run that has nothing to
    // classify.
    signals: ["plan.deviation-structural", "plan.deviation-functional"],
  },
  {
    id: "plan-exec.deviation-gate",
    scope: "plan-exec",
    title: "clasificar la desviación en local, estructural o funcional y derivar",
    authority: "cli",
    ownership: "cli-owned",
    document: PLAN_EXEC_LOOP,
    attribution: PLAN_ATTRIBUTION,
    condition: {
      threshold: { observed: "plan-exec.deviation-recognition", min: 1 },
      otherwise:
        "no se declaró ninguna desviación estructural ni funcional: lo local se resuelve en la fase y la ejecución sigue",
    },
  },
  {
    id: "plan-exec.pending-effects",
    scope: "plan-exec",
    title: "reconocer qué queda por hacer al cerrar el batch",
    authority: "agent",
    ownership: "cli-owned",
    document: PLAN_EXEC_LOOP,
    attribution: PLAN_ATTRIBUTION,
    // The three rows below it write, run or commit — and in a legitimate batch any
    // of the three may have nothing to do: boxes already ticked by an earlier run,
    // phases still pending, a batch with no code. Without this row each of them
    // demanded its effect anyway, so the only truthful answer was to refuse, and a
    // refused boundary that keeps being re-emitted exhausts and stops the run.
    //
    // The signals are POSITIVE — "there IS something to do" — because the engine's
    // threshold is positive: a row applies when its signal was observed and is
    // passed over when it was not. The inverse cannot be expressed, and inverting
    // one by mistake would skip a step that DID apply, crediting work nobody did.
    signals: ["plan.tasks-to-mark", "plan.plan-closable", "plan.commit-pending"],
  },
  {
    id: "plan-exec.task-marking",
    scope: "plan-exec",
    title: "marcar la tarea cuando su trabajo local termina",
    authority: "cli",
    ownership: "cli-owned",
    document: PLAN_EXEC_LOOP,
    attribution: PLAN_ATTRIBUTION,
    effects: ["mutate_overwrite"],
    // The checkbox is the run's own progress mark on the flow's document —
    // bookkeeping under run custody, so no preflight; the board's real reading
    // is still what applies it.
    custody: "run",
    condition: {
      threshold: {
        observed: "plan-exec.pending-effects",
        of: ["plan.tasks-to-mark"],
        min: 1,
      },
      otherwise:
        "ninguna casilla terminó su trabajo local en este batch: no hay nada que marcar en el plan",
    },
    // The plan-doc is the per-task source of truth, and the engine does not edit
    // it — so the write is delegated and what comes back is the board's count of
    // ticked boxes. "I marked it" is the one thing this contract will not take.
    action: {
      invocation: { program: "aw", args: ["status", "--json"], target: ".", input: null },
      execution: {
        kind: "external",
        reason: "marcar la casilla reescribe el plan-doc, y este motor no lo edita",
      },
      evidence: ["plan.casillas-marcadas"],
      idempotent: true,
      recovery:
        "marcá la casilla de la tarea cuyo trabajo local terminó y volvé a devolver la lectura del tablero; marcar de nuevo lo ya marcado no rompe nada",
    },
  },
  {
    id: "plan-exec.phase-state-transition",
    scope: "plan-exec",
    title: "aplicar la transición de estado de fase con sus precondiciones",
    authority: "cli",
    ownership: "cli-owned",
    document: PLAN_EXEC_LOOP,
    attribution: PLAN_ATTRIBUTION,
    effects: ["mutate_overwrite"],
    // The `> Estado:` line is the run's own phase ledger on the flow's document:
    // run custody, no preflight — the precondition below is what really guards it.
    custody: "run",
    // The precondition is what this row exists for: `validada` requires the proof
    // to have RUN and passed, never the checkboxes. The state line is a write on a
    // document the engine does not own, so the board's reading of that line is the
    // evidence — and the board is the same thing that calls a plan `inconsistent`
    // when a state and its boxes disagree.
    action: {
      invocation: { program: "aw", args: ["status", "--json"], target: ".", input: null },
      execution: {
        kind: "external",
        reason:
          "escribir el '> Estado:' de la fase reescribe el plan-doc, y este motor no lo edita",
      },
      evidence: ["plan.estado-de-fase-aplicado"],
      idempotent: true,
      recovery:
        "escribí el '> Estado:' que la fase realmente tiene —con su '> Bloqueo:' si quedó bloqueada— y volvé a devolver la lectura; una fase sin su prueba corrida no pasa a validada",
    },
  },
  {
    id: "plan-exec.validation-execution",
    scope: "plan-exec",
    title: "correr las pruebas de fase y las validaciones aplicables al cierre del batch",
    authority: "cli",
    ownership: "cli-owned",
    document: PLAN_EXEC_LOOP,
    attribution: PLAN_ATTRIBUTION,
    effects: ["execute"],
    // Running the proofs the plan itself declares is the run verifying its own
    // work: custody covers the `execute`, and the real output stays mandatory.
    custody: "run",
    // The proofs are authored per phase, so no fixed runner can be named without
    // inventing a rule this CLI does not have. What it CAN name is the artifact
    // holding the run's criteria, and it demands the real output of having run
    // them. This is the row `plan-exec.commit-enablement` stands on: reaching the
    // commit means having come THROUGH here with a result.
    action: {
      invocation: {
        program: "aw",
        args: ["session-artifacts", "--code", "{code}", "--dump", "objetivo"],
        target: SESSION_TARGET,
        input: null,
      },
      execution: {
        kind: "external",
        reason: "correr las pruebas de fase es ejecutar código, nunca una operación interna",
      },
      evidence: ["plan.validaciones-de-fase-verdes"],
      idempotent: true,
      recovery:
        "arreglá lo que la validación reprobó y volvé a correr las pruebas afectadas: la transición sigue pendiente hasta que su salida real vuelva en verde",
    },
  },
  {
    id: "plan-exec.deferred-check",
    scope: "plan-exec",
    title: "dejar bloqueada la fase cuyo chequeo operativo no puede correrse",
    authority: "cli",
    ownership: "cli-owned",
    document: PLAN_EXEC_LOOP,
    attribution: PLAN_ATTRIBUTION,
  },
  {
    id: "plan-exec.review-findings",
    scope: "plan-exec",
    title: "releer el diff del batch y juzgar sus hallazgos",
    authority: "agent",
    ownership: "cli-owned",
    document: CODE_POLICIES_MD,
    attribution: PLAN_ATTRIBUTION,
  },
  {
    id: "plan-exec.final-validation",
    scope: "plan-exec",
    title: "evaluar la validación final que habilita cerrar el plan",
    authority: "cli",
    ownership: "cli-owned",
    document: PLAN_EXEC_LOOP,
    attribution: PLAN_ATTRIBUTION,
    // BEFORE Git, and the real walk is what proved it: the registry had inherited
    // an order where the plan was committed and only then validated and stamped.
    // The document says the opposite — "last Batch also runs final validation
    // before Git" — and that half has not moved. What moved is where the `done`
    // seal sits relative to Git: see `plan-exec.unit-integration`.
    // The convergence gate of PLAN-exec. The board is what distinguishes the three
    // states this rule turns on — every phase green with no closure reads
    // `final_validation_pending`, and a deferred check keeps its phase blocked —
    // so it is read, not asserted.
    action: {
      invocation: { program: "aw", args: ["status", "--json"], target: ".", input: null },
      execution: {
        kind: "external",
        reason:
          "la validación final es el gate de convergencia del recorrido: darlo por verde desde una lectura sería aprobarlo sin correrlo",
      },
      evidence: ["plan.validacion-final-verde"],
      idempotent: true,
      recovery:
        "un chequeo diferido nunca cuenta como aprobado: deja su fase bloqueada y el plan abierto, así que corré lo que falte y volvé a leer el tablero",
    },
  },
  {
    id: "plan-exec.commit-enablement",
    scope: "plan-exec",
    title: "habilitar un commit por fuente solo tras un batch realmente verde",
    authority: "cli",
    ownership: "cli-owned",
    document: CODE_POLICIES_MD,
    attribution: PLAN_ATTRIBUTION,
    // "A failed or UNRUN check never authorizes a commit." The rule is enforced by
    // position, not by asking: this row sits behind the delegated validation and
    // behind the review, and neither can be passed with a narration. There is no
    // field a caller could set to arrive here without them.
  },
  {
    id: "plan-exec.commit-authorization",
    scope: "plan-exec",
    title: "aprobar los commits del batch o preautorizarlos condicionalmente",
    authority: "human",
    ownership: "cli-owned",
    document: CODE_POLICIES_MD,
    attribution: PLAN_ATTRIBUTION,
    // Approving here IS authorizing the commit effect downstream: the grant is
    // computed over `commit-execution`'s exact seal, so the person decides once
    // and the run never re-asks the same decision worded as an effect.
    authorizes: {
      approve: "Aprobar los commits del batch",
      transition: "plan-exec.commit-execution",
    },
    alternatives: [
      {
        label: "Aprobar los commits del batch",
        consequence:
          "se crea exactamente un commit por fuente afectada; sin push, sin --amend y sin --no-verify",
        recommended: true,
      },
      {
        label: "Dejar el batch sin commitear",
        consequence:
          "los cambios quedan en el árbol de trabajo y el batch se registra sin commitear en CHECKPOINT y BACKLOG",
        recommended: false,
      },
    ],
  },
  {
    id: "plan-exec.commit-execution",
    scope: "plan-exec",
    title: "crear un commit por fuente afectada y dejar cada árbol limpio o reconocido",
    authority: "cli",
    ownership: "cli-owned",
    document: CODE_POLICIES_MD,
    attribution: PLAN_ATTRIBUTION,
    effects: ["execute", "local_additive"],
    condition: {
      threshold: {
        observed: "plan-exec.pending-effects",
        of: ["plan.commit-pending"],
        min: 1,
      },
      otherwise: "ninguna fuente afectada quedó con cambios sin commitear: no hay commit que crear",
    },
    // Approving is not committing: the human approval above already carries the
    // grant over this row's exact seal, and what applies the transition is still
    // the real git state coming back — which is also the between-unit precondition
    // the policy demands ("each working tree clean or explicitly acknowledged").
    //
    // Read off the UNITS for the same reason the branch precondition is: a commit
    // lands in the unit's branch, and `aw sources --verbose` would report the
    // shared checkout — clean, because nothing was ever written there — so a batch
    // that committed nothing at all could still come back green.
    action: {
      invocation: {
        program: "aw",
        args: ["worktree", "list", "--code", "{code}"],
        target: ".",
        input: null,
      },
      execution: {
        kind: "external",
        reason: "crear un commit es un efecto sobre git que este ejecutor no aplica",
      },
      evidence: ["plan.commits-por-fuente"],
      idempotent: false,
      recovery:
        "una fuente que quedó con cambios sin commitear deja el batch SIN commitear: registralo así en CHECKPOINT y BACKLOG en vez de commitear a medias",
    },
  },
  {
    id: "plan-exec.unit-integration",
    scope: "plan-exec",
    title: "integrar cada unidad de la sesión en la rama de trabajo de su fuente",
    authority: "cli",
    ownership: "cli-owned",
    document: PLAN_EXEC_LOOP,
    attribution: PLAN_ATTRIBUTION,
    // The two classes a merge really applies: it runs git, and it moves files in
    // a checkout that already had contents. No `custody: "run"` — this is the one
    // row of the journey whose effect lands OUTSIDE the run's own ledger, on the
    // branch everybody else reads, so it stops to be authorized. That stop is not
    // the commit approval asked twice: approving the commits of a batch decides
    // what gets recorded in the run's own unit, and this decides that it lands on
    // the shared branch. Two decisions, and only the second can conflict.
    effects: ["execute", "mutate_overwrite"],
    // Why this row exists at all, and why HERE. A run that isolates its writing
    // ends holding commits that live on `aw/<session>` and nowhere else: without
    // this transition the journey reported "finished" over work no branch anybody
    // reads contains. It sits AFTER the commit because a merge of uncommitted work
    // has no losing side to report, and BEFORE the `done` seal because sealing a
    // plan whose result is still only in a unit would make `done` true of nothing.
    //
    // Delegated, not internal, although this CLI owns the service: a merge into
    // the source's working branch writes on somebody else's books, and its failure
    // mode — a conflict — opens a journey (`aw fix-git`) that is a person's, not
    // this executor's. What comes back is the command's own per-unit report.
    action: {
      invocation: {
        program: "aw",
        args: ["worktree", "integrate", "--code", "{code}"],
        target: ".",
        input: null,
      },
      execution: {
        kind: "external",
        reason: "un merge sobre la rama compartida es un efecto que este ejecutor no aplica",
      },
      evidence: ["plan.unidades-integradas"],
      // Re-entrant on purpose: this is the transition a conflict comes BACK to.
      // Integrating an already-integrated session is a no-op that reports the same
      // thing, which is what lets the recovery end where it started.
      idempotent: true,
      recovery:
        "una unidad en conflicto conserva su merge y sus commits: resolvé con 'aw fix-git --path <fuente>' (prepare → apply → commit --confirm) y volvé a correr la integración; la transición sigue pendiente mientras la sesión conserve una unidad",
    },
  },
  {
    id: "plan-exec.plan-done",
    scope: "plan-exec",
    title: "escribir el estado done del plan con su línea de cierre",
    authority: "cli",
    ownership: "cli-owned",
    document: PLAN_EXEC_LOOP,
    attribution: PLAN_ATTRIBUTION,
    effects: ["mutate_overwrite"],
    // The done seal is the last progress mark of the flow's own document: run
    // custody — its condition and the board's reading are the guards that count.
    custody: "run",
    condition: {
      threshold: {
        observed: "plan-exec.pending-effects",
        of: ["plan.plan-closable"],
        min: 1,
      },
      otherwise:
        "al plan le quedan fases sin validar: sellarlo acá sería marcarlo done desde los contadores",
    },
    action: {
      invocation: { program: "aw", args: ["status", "--json"], target: ".", input: null },
      execution: {
        kind: "external",
        reason: "sellar el done reescribe el plan-doc, y este motor no lo edita",
      },
      evidence: ["plan.estado-done-sellado"],
      idempotent: true,
      recovery:
        "escribí '> Estado: done' y su '> Cierre:' en la línea de abajo y volvé a devolver la lectura; si el tablero no lo lee cerrado, la transición sigue pendiente",
    },
  },

  // ── Transversal commands (universe = the command registry) ────────────────
  {
    id: "status.board-projection",
    scope: cmd("status"),
    title: "proyectar el tablero del workspace desde el índice documental",
    authority: "cli",
    ownership: "cli-owned",
    document: "commands/status.md",
    attribution: "`aw status`",
  },
  {
    id: "resume.priority-derivation",
    scope: cmd("resume"),
    title: "derivar qué continuar y con qué comando exacto",
    authority: "cli",
    ownership: "cli-owned",
    document: "commands/resume.md",
    attribution: "`aw resume`",
  },
  {
    id: "resume.route-choice",
    scope: cmd("resume"),
    title: "elegir cuál de las continuaciones propuestas se ejecuta",
    authority: "human",
    ownership: "cli-owned",
    document: "commands/resume.md",
    // The person picks; what the CLI owns is the ballot. Which candidates appear,
    // in what order and with what next command all come from `aw resume`, and the
    // document says the offer is made over those and no others.
    attribution: "only for CLI candidates",
  },
  // Continuity across prompts, contracted where it is executed. These rules were
  // the chassis' and could not become steps of a journey: they decide WHICH run a
  // prompt belongs to, which is answered before any run state exists. What
  // decides is `resolveSessionTarget` behind the three commands below.
  {
    id: "resume.bare-prompt-continues",
    scope: cmd("resume"),
    title: "continuar la sesión más reciente ante un prompt sin comando",
    authority: "cli",
    ownership: "cli-owned",
    document: "modules/PROMPT-CONTINUITY.md",
    attribution: CONTINUITY_ATTRIBUTION,
  },
  {
    id: "resume.prompt-relatedness",
    scope: cmd("resume"),
    title: "juzgar si el prompt nuevo pertenece a la línea de trabajo abierta",
    authority: "agent",
    ownership: "cli-owned",
    document: "modules/PROMPT-CONTINUITY.md",
    attribution: CONTINUITY_ATTRIBUTION,
  },
  {
    id: "resume.escalation-consent",
    scope: cmd("resume"),
    title: "consentir una escalación que abre línea nueva sin comando",
    authority: "human",
    ownership: "cli-owned",
    document: SKILL_MD,
    attribution: CONTINUITY_ATTRIBUTION,
  },
  {
    id: "persist.shape-classification",
    scope: cmd("persist"),
    title: "clasificar la forma del trabajo ya hecho en la conversación",
    authority: "agent",
    ownership: "cli-owned",
    document: "commands/persist.md",
    // Classifying is judgment and the routing table is the module's. What the CLI
    // owns is that the classification is answered against the inventory `prepare`
    // returned and admitted only through the digest `validate` hands back — a
    // shape nobody may assert on their own word. That is the line this sentence
    // draws, and it names who holds the other side of it.
    attribution: "belong to `aw persist`",
  },
  {
    id: "persist.routing",
    scope: cmd("persist"),
    title: "resolver destino, numeración y escritura del trabajo persistido",
    authority: "cli",
    ownership: "cli-owned",
    document: "modules/PERSIST-ROUTING.md",
    attribution: "(owned by this command)",
    effects: ["local_additive"],
  },
  {
    id: "context-plan.signal-declaration",
    scope: cmd("context-plan"),
    title: "declarar qué señales observa la corrida",
    authority: "agent",
    ownership: "cli-owned",
    document: "commands/plan-exec.md",
    // Recognizing that a case carries a signal is judgment; which signals exist
    // and what each one loads is not. The invocation is the vocabulary: a signal
    // outside it returns nothing, so the declaration is answered against the
    // catalog instead of against whatever the reader remembers.
    attribution: "aw context-plan --command plan-exec --signal",
  },
  {
    id: "context-plan.read-set",
    scope: cmd("context-plan"),
    title: "resolver el read-set exacto que la invocación debe cargar",
    authority: "cli",
    ownership: "cli-owned",
    document: "commands/plan-exec.md",
    attribution: "aw context-plan --command plan-exec",
  },
  {
    id: "context-budget.verdict",
    scope: cmd("context-budget"),
    title: "medir el costo de carga de un comando contra su techo",
    authority: "cli",
    ownership: "cli-owned",
    // The manifest, not a command doc: the budget policy the verdict reads lives
    // there and nothing else in the bundle states this decision. The attribution
    // guard is what surfaced it — the previous pointer (`commands/plan-exec.md`)
    // names `aw context-plan` and never mentions the measurement at all.
    document: "context/MANIFEST.json",
    attribution: "(aw context-budget)",
  },
  {
    id: "session-create.numbering",
    scope: cmd("session-create"),
    title: "asignar el NNN global al crear la sesión",
    authority: "cli",
    ownership: "cli-owned",
    document: "modules/SESSION-NUMBERING.md",
    attribution: "`aw session-create`",
    effects: ["local_additive"],
  },
  {
    id: "session-create.new-work-line",
    scope: cmd("session-create"),
    title: "tratar un comando de flow como línea de trabajo nueva",
    authority: "cli",
    ownership: "cli-owned",
    document: "modules/PROMPT-CONTINUITY.md",
    attribution: "`aw session-create`",
    effects: ["local_additive"],
  },
  {
    id: "session-close.closure",
    scope: cmd("session-close"),
    title: "cerrar la sesión y actualizar su fila del registro durable",
    authority: "cli",
    ownership: "cli-owned",
    document: "modules/SESSION-NUMBERING.md",
    attribution: "`aw session-close`",
    effects: ["mutate_overwrite"],
  },
  {
    id: "session-resume.reopen",
    scope: cmd("session-resume"),
    title: "resolver y reabrir la sesión que continúa el trabajo",
    authority: "cli",
    ownership: "cli-owned",
    document: "modules/SESSION-NUMBERING.md",
    attribution: "`aw session-resume --code <NNN> --reopen`",
    effects: ["mutate_overwrite"],
  },
  {
    id: "session-resume.locate",
    scope: cmd("session-resume"),
    title: "localizar una sesión existente por descriptor y origen",
    authority: "cli",
    ownership: "cli-owned",
    document: "modules/SESSION-NUMBERING.md",
    attribution: "`aw session-resume --code <NNN> --reopen`",
  },
  {
    id: "session-resume.rerun-is-create-or-resume",
    scope: cmd("session-resume"),
    title: "re-ejecutar el mismo comando sobre la misma entrada como crear-o-reanudar",
    authority: "cli",
    ownership: "cli-owned",
    document: SKILL_MD,
    attribution: "`aw session-resume --code <NNN> --reopen`",
    effects: ["mutate_overwrite"],
  },
  // Compaction, contracted in the command the host already wires as its
  // PreCompact hook. Not a step either, and for a sharper reason than continuity:
  // it fires at whatever boundary the run is standing on, so no position in a
  // journey could be its own.
  {
    id: "checkpoint-write.context-pressure-signal",
    scope: cmd("checkpoint-write"),
    title: "reconocer que la corrida está bajo presión de contexto",
    authority: "agent",
    ownership: "cli-owned",
    document: "modules/COMPACTION.md",
    attribution: COMPACTION_ATTRIBUTION,
    signals: ["chassis.context-pressure"],
  },
  {
    id: "checkpoint-write.compaction-mode",
    scope: cmd("checkpoint-write"),
    title: "elegir el modo de compactación confirm o auto desde la configuración",
    authority: "cli",
    ownership: "cli-owned",
    document: "modules/COMPACTION.md",
    attribution: COMPACTION_ATTRIBUTION,
  },
  {
    id: "checkpoint-write.compaction-degradation",
    scope: cmd("checkpoint-write"),
    title: "degradar auto a confirm cuando el host no tiene mecanismo no interactivo",
    authority: "cli",
    ownership: "cli-owned",
    document: "modules/COMPACTION.md",
    attribution: COMPACTION_ATTRIBUTION,
  },
  {
    id: "checkpoint-write.before-compacting",
    scope: cmd("checkpoint-write"),
    title: "exigir el CHECKPOINT escrito antes de que dispare cualquier compactación",
    authority: "cli",
    ownership: "cli-owned",
    document: "modules/COMPACTION.md",
    attribution: COMPACTION_ATTRIBUTION,
    effects: ["mutate_overwrite"],
  },
  {
    id: "check-branch.verdict",
    scope: cmd("check-branch"),
    title: "verificar si la fuente está en la rama que el trabajo espera",
    authority: "cli",
    ownership: "cli-owned",
    document: CODE_POLICIES_MD,
    attribution: "aw check-branch",
  },
  {
    id: "next-number.correlative",
    scope: cmd("next-number"),
    title: "entregar el correlativo siguiente de una carpeta documental",
    authority: "cli",
    ownership: "cli-owned",
    document: "modules/SESSION-NUMBERING.md",
    attribution: "The CLI owns the number (hard rule)",
  },
  {
    id: "worktree.unit-lifecycle",
    scope: cmd("worktree"),
    title: "entregar, listar y liberar la unidad de aislamiento de un flujo",
    authority: "cli",
    ownership: "cli-owned",
    document: CODE_POLICIES_MD,
    attribution: "aw worktree ensure | list | release",
    // Creating and removing a working tree is a real effect on the source, and
    // the answer to "is this unit free?" is git's, not a narration's: a run that
    // could declare itself the owner of a tree it never got is exactly the
    // collision the unit exists to prevent.
    effects: ["mutate_overwrite"],
  },
  {
    id: "capability.routing",
    scope: cmd("capability"),
    title: "resolver ruta, autorización de efectos y receipt de un intento",
    authority: "cli",
    ownership: "cli-owned",
    document: "roles/design/CONTRACT.md",
    attribution: "aw capability prepare",
  },
  {
    id: "designs.reference-verdict",
    scope: cmd("designs"),
    title: "decidir si una referencia de diseño resuelve, cambió, fue revocada o no cierra",
    authority: "cli",
    ownership: "cli-owned",
    document: "modules/DESIGN-REFERENCES.md",
    attribution: "`aw designs`",
  },
  {
    id: "workspace-init.scaffold",
    scope: cmd("workspace-init"),
    title: "sembrar el andamiaje mínimo del workspace",
    authority: "cli",
    ownership: "cli-owned",
    document: "modules/WORKSPACE-SCAFFOLD.md",
    attribution: "CLI-owned `.gitignore`",
    effects: ["local_additive"],
  },
  {
    id: "generate-launch.detection",
    scope: cmd("generate-launch"),
    title: "detectar el stack de cada fuente y generar sus artefactos de arranque",
    authority: "cli",
    ownership: "cli-owned",
    document: "modules/LAUNCH-DETECTION.md",
    attribution: "Loaded when the CLI's detection is wrong",
    effects: ["local_additive"],
  },
  {
    id: "fix-git.intent",
    scope: cmd("fix-git"),
    title: "interpretar la intención de cada conflicto de la fusión en curso",
    authority: "agent",
    ownership: "cli-owned",
    document: "commands/fix-git.md",
    // Reading base/ours/theirs for intent is judgment. What is not: which files
    // may be answered for, that the blob hashes still hold, and that a leftover
    // marker is a rejection. The interpretation is supplied; nothing lands on it
    // alone.
    attribution: "the CLI owns the effects",
  },
  {
    id: "fix-git.resolution-write",
    scope: cmd("fix-git"),
    title: "escribir la resolución validada en los archivos en conflicto",
    authority: "cli",
    ownership: "cli-owned",
    document: "commands/fix-git.md",
    attribution: "`aw fix-git`",
    effects: ["mutate_overwrite"],
  },
  {
    id: "export.selection",
    scope: cmd("export-reports"),
    title: "seleccionar y sintetizar el material de las sesiones que se promueve",
    authority: "agent",
    ownership: "cli-owned",
    document: "commands/export-reports.md",
    // Synthesizing is authorship. What it may synthesize FROM is not: the corpus
    // comes from `prepare`, so the promotion is over the sessions the CLI listed
    // and not over whatever else the conversation remembers.
    attribution: "`aw export-reports` owns the corpus, the numbering and the write",
  },
  {
    id: "export.numbering-and-write",
    scope: cmd("export-reports"),
    title: "resolver corpus, numeración y escritura del dossier promovido",
    authority: "cli",
    ownership: "cli-owned",
    document: "commands/export-reports.md",
    attribution: "`aw export-reports`",
    effects: ["local_additive"],
  },
];

/**
 * Public commands with no journey decision of their own.
 *
 * Read together with {@link FLOW_DECISIONS} this is the exhaustiveness claim:
 * every registered command is either classified or excluded on the record.
 *
 * The universe is TWO surfaces, not one. Most entries name an `aw` command, but a
 * `/w:` command that starts no loop is a public journey just the same, and the
 * only one of those the engine cannot direct earns its exclusion here rather than
 * a second list: one field, one reason, one guard.
 */
export const COMMAND_EXCLUSIONS: readonly CommandExclusion[] = [
  {
    command: "spec-new",
    reason:
      "comando `/w:` de una sola pasada que no abre loop: sin corrida que dirigir, su gate de división lo aplica el propio comando con la regla de modules/SPLIT-GATE.md, que por eso conserva su enunciado",
  },
  {
    command: "discard",
    reason:
      "comando transversal de retiro: no abre WorklineFlow ni sesión a propósito, porque puede terminar borrando la sesión que lo dirigiera. Su autoridad es su propio contrato: `prepare` read-only y `apply` con el digest exacto, recomputado bajo el lock del workspace",
  },
  {
    command: "reset",
    reason:
      "comando transversal de retiro: mismo contrato que `discard` en modo restauración, sin corrida propia por la misma razón — la sesión que vuelve atrás es la que se retira",
  },
  { command: "sessions", reason: "listado read-only del inventario de sesiones" },
  { command: "session-artifacts", reason: "inspección read-only de lo que guarda una sesión" },
  { command: "checkpoint-read", reason: "lectura del CHECKPOINT sin decidir continuación" },
  { command: "auto-compact-on-close", reason: "gatillo de cierre del host, sin regla propia" },
  { command: "resume-summary", reason: "resumen post-compactación sin decisión de recorrido" },
  { command: "stack", reason: "detección de stack informativa" },
  { command: "sources", reason: "inventario de fuentes del workspace" },
  { command: "set-working-branch", reason: "configuración declarativa de rama" },
  { command: "set-qa-branch", reason: "configuración declarativa de rama" },
  { command: "remove-source", reason: "operación de configuración del workspace" },
  { command: "git-flow", reason: "utilidad de ramas sin recorrido de flow" },
  { command: "merge-state", reason: "lectura del estado de una fusión" },
  { command: "attach-multiroot", reason: "configuración de multiroot" },
  { command: "detach-multiroot", reason: "configuración de multiroot" },
  { command: "visibility", reason: "configuración de visibilidad de fuentes" },
  { command: "skills", reason: "inventario de capacidades instaladas y su readiness" },
  { command: "skill-index", reason: "índice de bindings de capacidades" },
  {
    command: "export-diagrams",
    reason:
      "comparte la clasificación de export-reports: selección semántica del agente más corpus, numeración y escritura del CLI, con su propio destino documental",
  },
  {
    command: "export-manuals",
    reason:
      "comparte la clasificación de export-reports: selección semántica del agente más corpus, numeración y escritura del CLI, con su propio destino documental",
  },
  {
    command: "export-scripts",
    reason:
      "comparte la clasificación de export-reports: selección semántica del agente más corpus, numeración y escritura del CLI, con su propio destino documental",
  },
  { command: "history-update", reason: "reparación del registro durable" },
  { command: "project-md-upsert", reason: "escritura del bloque de proyecto en el host" },
  {
    command: "workspace-migrate",
    reason:
      "puesta al día puntual de un hub con serie legacy: no abre recorrido ni sesión, y su autoridad es su propio contrato — sin `--apply` no escribe nada, y una sesión sobre la que el histórico y el disco se contradicen queda intacta",
  },
  { command: "code-scan", reason: "barrido read-only del código" },
  { command: "plugin-doctor", reason: "diagnóstico de instalación" },
  { command: "plugin-cache", reason: "mantenimiento de caché" },
  { command: "host-doctor", reason: "diagnóstico de hosts" },
  { command: "release-data", reason: "datos de release del paquete" },
  { command: "bootstrap-dsn", reason: "configuración de credenciales de desarrollo" },
  { command: "hook", reason: "punto de entrada de los hooks del host" },
  { command: "mcp", reason: "configuración de servidores MCP" },
  { command: "self", reason: "instalación y mantenimiento del propio CLI" },
  { command: "harness", reason: "dev-only: inspección del harness" },
  { command: "profiles", reason: "dev-only: perfiles de ejecución" },
  { command: "logs", reason: "dev-only: lectura de logs" },
  { command: "flow", reason: "el motor mismo: aplica el registro, no declara una fila propia" },
];

/** The scope's decisions, in the journey order the table declares. */
export function decisionsOfScope(scope: DecisionScope): readonly FlowDecision[] {
  return FLOW_DECISIONS.filter((decision) => decision.scope === scope);
}

/**
 * The journey a run of this flow actually walks: its own steps, with the
 * transversal ones composed in at their declared positions.
 *
 * This function is the answer to why the chassis could not be migrated the way a
 * flow tranche was. A run's cursor is an index into ONE list, and until now that
 * list was `decisionsOfScope(flow)` — so every `chassis` row was unreachable by
 * construction, and flipping one to `cli-owned` would have declared ownership of
 * a step no run can cross. Composing is what turns the declaration into something
 * a real run demonstrates.
 *
 * Every caller that walks, resolves or projects a run reads the journey from
 * HERE. Two of them composing independently would put the same step at two
 * positions, and a cursor is only meaningful against one list.
 */
export function journeyOfFlow(flow: WorklineFlow): readonly FlowDecision[] {
  const transversal = decisionsOfScope(CHASSIS_SCOPE);
  const at = (placement: RunPlacement): readonly FlowDecision[] =>
    transversal.filter((decision) => decision.placement === placement);
  return [...at("prefix"), ...decisionsOfScope(flow), ...at("suffix")];
}

/**
 * The `docs/` folders a flow may write, as the chassis' boundary states them.
 *
 * A table rather than a rule with exceptions: the boundary is "its own flow's
 * doc, plus the category of a capability it composes", and both halves are facts
 * about the flow. `quick` writes none at all — it has no document — and that
 * empty list is a real answer, not a missing entry, which is why the map is
 * exhaustive over the five flows instead of falling back to a default.
 *
 * The `design` category is here rather than derived from the composition because
 * whether a flow MAY publish a package revision is a property of the flow, not of
 * whichever run happens to compose the capability.
 */
export const DOCS_BOUNDARY: Readonly<Record<WorklineFlow, readonly string[]>> = {
  quick: [],
  "spec-refine": ["docs/specs", "docs/designs"],
  "plan-new": ["docs/plans"],
  "plan-refine": ["docs/plans"],
  "plan-exec": ["docs/plans", "docs/designs"],
};

/** The flow a scope names, or null for the chassis and for command scopes. */
export function flowOfScope(scope: DecisionScope): WorklineFlow | null {
  return (WORKLINE_FLOWS as readonly string[]).includes(scope) ? (scope as WorklineFlow) : null;
}

/** The command a scope names, or null when the scope is a flow or the chassis. */
export function commandOfScope(scope: DecisionScope): string | null {
  return scope.startsWith(COMMAND_SCOPE_PREFIX) ? scope.slice(COMMAND_SCOPE_PREFIX.length) : null;
}

/**
 * The migration tranche a flow belongs to — DERIVED, never stored next to the
 * flow.
 *
 * Persisting both would create two sources for one fact, and the day they
 * disagree the state is unusable: the whole initiative exists to remove exactly
 * that kind of double authority.
 */
export function trancheOfFlow(flow: WorklineFlow): FlowTranche {
  if (flow === "quick") return "quick";
  return flow === "spec-refine" ? "spec" : "plan";
}

// `hasLegacyOwnership(scope)` lived here until the migration closed. It answered
// "does anything in this scope still decide from the doctrine", and the honest
// end of it is deletion, not an inverted twin: the answer is now `false` for
// every scope by construction, and an exported predicate nothing in production
// asks would be exactly the defect this initiative spent seventeen phases
// removing — a declared surface with no consumer. The guards assert the closing
// state over `FLOW_DECISIONS` directly, which is where it is true.
