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
 * authority: `legacy` means the doctrine Markdown still decides it today,
 * `cli-owned` means this CLI does and the doctrine may no longer re-state it as
 * a rule. Every row starts `legacy` except the ones a shipped command already
 * owns — claiming otherwise would make the migration unobservable, which is the
 * one thing the initiative cannot afford.
 */

import { WORKLINE_FLOWS, type WorklineFlow } from "../../application/capability/compose.js";
import type { EffectClass } from "../capability/effects.js";

export const FLOW_AUTHORITIES = ["cli", "agent", "human"] as const;

/** Who owns one decision: the CLI's rules, the agent's judgment, or the person. */
export type FlowAuthority = (typeof FLOW_AUTHORITIES)[number];

export const TRANSITION_OWNERSHIPS = ["cli-owned", "legacy"] as const;

/** Whether this CLI already decides it, or the doctrine still does. */
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
 * exact thing that runs. These two are what a session-scoped command needs — the
 * folder and its correlative — and both are facts the engine owns.
 */
export const RUN_PLACEHOLDERS = ["{session}", "{code}"] as const;

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

/** What makes this transition happen at all, or `null` when it always does. */
export function conditionOf(decision: FlowDecision): TransitionCondition | null {
  return decision.condition ?? null;
}

/** The alternatives this row declares as its own, or `null` for the generic pair. */
export function alternativesOf(decision: FlowDecision): readonly FlowChoice[] | null {
  return decision.alternatives ?? null;
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
const PLAN_NEW_LOOP = "loops/plan-new-loop/LOOP.md";
const PLAN_REFINE_LOOP = "loops/plan-refine-loop/LOOP.md";
const PLAN_EXEC_LOOP = "loops/plan-exec-loop/LOOP.md";
const BATCHES_MD = "modules/PLAN-EXECUTION-BATCHES.md";

/**
 * Every decision and transition of every public journey, in journey order
 * within each scope. The engine walks a scope's rows in this order.
 */
export const FLOW_DECISIONS: readonly FlowDecision[] = [
  // ── Transversal chassis: the engine every loop runs underneath its deltas ──
  {
    id: "chassis.session-create-or-resume",
    scope: CHASSIS,
    title: "abrir la sesión de la corrida o reanudar la existente",
    authority: "cli",
    ownership: "legacy",
    document: CHASSIS_MD,
    effects: ["local_additive"],
  },
  {
    id: "chassis.session-numbering",
    scope: CHASSIS,
    title: "asignar el NNN global y secuencial de la sesión",
    authority: "cli",
    ownership: "cli-owned",
    document: "modules/SESSION-NUMBERING.md",
    attribution: "The CLI owns the number (hard rule)",
  },
  {
    id: "chassis.session-locate",
    scope: CHASSIS,
    title: "localizar o reabrir una sesión existente por descriptor y origen",
    authority: "cli",
    ownership: "legacy",
    document: "modules/SESSION-NUMBERING.md",
  },
  {
    id: "chassis.success-criteria-seed",
    scope: CHASSIS,
    title: "sembrar los criterios de éxito antes de ejecutar (verification-first)",
    authority: "cli",
    ownership: "legacy",
    document: CHASSIS_MD,
  },
  {
    id: "chassis.gap-detection",
    scope: CHASSIS,
    title: "detectar los gaps materiales del trabajo",
    authority: "agent",
    ownership: "legacy",
    document: CHASSIS_MD,
  },
  {
    id: "chassis.gap-batching",
    scope: CHASSIS,
    title: "tomar un lote de a lo sumo 3 gaps por vuelta",
    authority: "cli",
    ownership: "legacy",
    document: CHASSIS_MD,
  },
  {
    id: "chassis.resolver-selection",
    scope: CHASSIS,
    title: "elegir el resolvedor de un gap con la regla adoptar/investigar/probar/preguntar",
    authority: "cli",
    ownership: "legacy",
    document: CHASSIS_MD,
  },
  {
    id: "chassis.research-exhaustion",
    scope: CHASSIS,
    title: "marcar un gap agotado tras el tope de intentos y degradarlo",
    authority: "cli",
    ownership: "legacy",
    document: CHASSIS_MD,
  },
  {
    id: "chassis.minimality-lens",
    scope: CHASSIS,
    title: "juzgar si el entregable pesa más de lo que sus criterios exigen",
    authority: "agent",
    ownership: "legacy",
    document: CHASSIS_MD,
  },
  {
    id: "chassis.convergence-gate",
    scope: CHASSIS,
    title: "evaluar el gate de convergencia sobre los criterios de éxito",
    authority: "cli",
    ownership: "legacy",
    document: CHASSIS_MD,
  },
  {
    id: "chassis.criteria-flip",
    scope: CHASSIS,
    title: "marcar en verde los criterios que el gate aprobó",
    authority: "cli",
    ownership: "legacy",
    document: CHASSIS_MD,
    effects: ["mutate_overwrite"],
  },
  {
    id: "chassis.structured-choice-shape",
    scope: CHASSIS,
    title: "armar la pregunta: hasta 3 de contenido más el control de flujo, recomendación primero",
    authority: "cli",
    ownership: "legacy",
    document: CHASSIS_MD,
  },
  {
    id: "chassis.flow-control",
    scope: CHASSIS,
    title: "decidir Compactar o Cerrar en cualquier momento",
    authority: "human",
    ownership: "legacy",
    document: CHASSIS_MD,
  },
  {
    id: "chassis.context-pressure-signal",
    scope: CHASSIS,
    title: "reconocer que la corrida está bajo presión de contexto",
    authority: "agent",
    ownership: "legacy",
    document: "modules/COMPACTION.md",
    signals: ["chassis.context-pressure"],
  },
  {
    id: "chassis.compaction-mode",
    scope: CHASSIS,
    title: "elegir el modo de compactación confirm o auto desde la configuración",
    authority: "cli",
    ownership: "legacy",
    document: "modules/COMPACTION.md",
  },
  {
    id: "chassis.compaction-degradation",
    scope: CHASSIS,
    title: "degradar auto a confirm cuando el host no tiene mecanismo no interactivo",
    authority: "cli",
    ownership: "legacy",
    document: "modules/COMPACTION.md",
  },
  {
    id: "chassis.checkpoint-before-compacting",
    scope: CHASSIS,
    title: "exigir el CHECKPOINT escrito antes de que dispare cualquier compactación",
    authority: "cli",
    ownership: "legacy",
    document: "modules/COMPACTION.md",
  },
  {
    id: "chassis.prompt-new-work-line",
    scope: CHASSIS,
    title: "tratar un comando de flow como línea de trabajo nueva",
    authority: "cli",
    ownership: "legacy",
    document: "modules/PROMPT-CONTINUITY.md",
  },
  {
    id: "chassis.prompt-rerun",
    scope: CHASSIS,
    title: "re-ejecutar el mismo comando sobre la misma entrada como crear-o-reanudar",
    authority: "cli",
    ownership: "legacy",
    document: SKILL_MD,
  },
  {
    id: "chassis.prompt-bare-continues",
    scope: CHASSIS,
    title: "continuar la sesión más reciente ante un prompt sin comando",
    authority: "cli",
    ownership: "legacy",
    document: "modules/PROMPT-CONTINUITY.md",
  },
  {
    id: "chassis.prompt-relatedness",
    scope: CHASSIS,
    title: "juzgar si el prompt nuevo pertenece a la línea de trabajo abierta",
    authority: "agent",
    ownership: "legacy",
    document: "modules/PROMPT-CONTINUITY.md",
  },
  {
    id: "chassis.escalation-consent",
    scope: CHASSIS,
    title: "consentir una escalación que abre línea nueva sin comando",
    authority: "human",
    ownership: "legacy",
    document: SKILL_MD,
  },
  {
    id: "chassis.docs-boundary",
    scope: CHASSIS,
    title: "resolver en qué carpeta de docs puede escribir el loop",
    authority: "cli",
    ownership: "legacy",
    document: CHASSIS_MD,
  },
  {
    id: "chassis.finalize",
    scope: CHASSIS,
    title: "persistir CHECKPOINT, escribir BACKLOG solo si algo quedó diferido y cerrar la sesión",
    authority: "cli",
    ownership: "legacy",
    document: CHASSIS_MD,
    effects: ["mutate_overwrite"],
  },

  // ── QUICK — the pilot tranche, and the first one this CLI decides ──────────
  //
  // Twelve rows migrated: every decision whose rule lived in the loop's own
  // document. The five that live in CODE-POLICIES/DB-SCRIPTS-ONLY stay `legacy`
  // on purpose — they are the OTHER four flows' rules too, and migrating them
  // here would move a tranche nobody has cut over.
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
    ownership: "legacy",
    document: CODE_POLICIES_MD,
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
    id: "quick.db-scripts-only",
    scope: "quick",
    title: "derivar todo DDL o DML al script de la sesión sin ejecutarlo",
    authority: "cli",
    ownership: "legacy",
    document: "modules/DB-SCRIPTS-ONLY.md",
    effects: ["local_additive"],
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
    // `execute` is not self-authorizable, so the run stops to be authorized
    // BEFORE this invocation is ever emitted.
    action: {
      invocation: {
        program: "aw",
        args: ["session-artifacts", "--code", "{code}", "--dump", "objetivo"],
        target: SESSION_TARGET,
        input: null,
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
    ownership: "legacy",
    document: CODE_POLICIES_MD,
  },
  {
    id: "quick.review-findings",
    scope: "quick",
    title: "releer el diff y juzgar sus hallazgos con las convenciones instaladas",
    authority: "agent",
    ownership: "legacy",
    document: CODE_POLICIES_MD,
  },
  {
    id: "quick.commit-authorization",
    scope: "quick",
    title: "aprobar el commit propuesto de la tarea",
    authority: "human",
    ownership: "legacy",
    document: CODE_POLICIES_MD,
  },

  // ── SPEC ──────────────────────────────────────────────────────────────────
  {
    id: "spec-refine.session",
    scope: "spec-refine",
    title: "abrir o reanudar la sesión de refinamiento de la spec",
    authority: "cli",
    ownership: "legacy",
    document: SPEC_LOOP,
    effects: ["local_additive"],
  },
  {
    id: "spec-refine.baseline-scope",
    scope: "spec-refine",
    title: "decidir cuánto comportamiento actual hace falta establecer",
    authority: "agent",
    ownership: "legacy",
    document: SPEC_LOOP,
  },
  {
    id: "spec-refine.change-shape-gate",
    scope: "spec-refine",
    title: "resolver la forma del cambio: una sola spec, dividir o reemplazar",
    authority: "cli",
    ownership: "legacy",
    document: "modules/SPEC-CHANGE-SHAPE.md",
  },
  {
    id: "spec-refine.split-signal",
    scope: "spec-refine",
    title: "reconocer cada señal de división en el pedido recibido",
    authority: "agent",
    ownership: "legacy",
    document: "modules/SPLIT-GATE.md",
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
    title: "aplicar el umbral de dos señales que dispara el gate de división",
    authority: "cli",
    ownership: "legacy",
    document: "modules/SPLIT-GATE.md",
  },
  {
    id: "spec-refine.split-choice",
    scope: "spec-refine",
    title: "elegir entre dividir en varias specs o conservar una sola",
    authority: "human",
    ownership: "legacy",
    document: "modules/SPLIT-GATE.md",
  },
  {
    id: "spec-refine.gap-recognition",
    scope: "spec-refine",
    title: "reconocer qué clase de gap tiene la spec delante",
    authority: "agent",
    ownership: "legacy",
    document: SPEC_LOOP,
  },
  {
    id: "spec-refine.gap-destination",
    scope: "spec-refine",
    title: "clasificar el gap por destino: bloquea SPEC, es de PLAN o se difiere",
    authority: "cli",
    ownership: "legacy",
    document: SPEC_LOOP,
  },
  {
    id: "spec-refine.ideation-trigger",
    scope: "spec-refine",
    title: "aplicar el disparador condicional del gate de ideación",
    authority: "cli",
    ownership: "legacy",
    document: "modules/IDEATION-GATE.md",
  },
  {
    id: "spec-refine.ideation-consent",
    scope: "spec-refine",
    title: "consentir la ronda de ideación o seguir sin ella",
    authority: "human",
    ownership: "legacy",
    document: "modules/IDEATION-GATE.md",
  },
  {
    id: "spec-refine.content-authoring",
    scope: "spec-refine",
    title: "redactar requisito, contexto, criterios y escenarios de la spec",
    authority: "agent",
    ownership: "legacy",
    document: SPEC_LOOP,
  },
  {
    id: "spec-refine.functional-ambiguity",
    scope: "spec-refine",
    title: "cerrar una ambigüedad funcional que puede cambiar lo que se construye",
    authority: "human",
    ownership: "legacy",
    document: SPEC_LOOP,
  },
  {
    id: "spec-refine.design-reuse",
    scope: "spec-refine",
    title: "juzgar si un baseline de diseño compatible sirve o hace falta una revisión nueva",
    authority: "agent",
    ownership: "legacy",
    document: "modules/DESIGN-REFERENCES.md",
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
    ownership: "legacy",
    document: SPEC_LOOP,
  },
  {
    id: "spec-refine.status-promotion",
    scope: "spec-refine",
    title: "promover el status de la spec a ready-for-plan",
    authority: "cli",
    ownership: "legacy",
    document: SPEC_LOOP,
    effects: ["mutate_overwrite"],
  },
  {
    id: "spec-refine.save-confirmation",
    scope: "spec-refine",
    title: "confirmar la sobreescritura de la spec",
    authority: "human",
    ownership: "legacy",
    document: SPEC_LOOP,
  },

  // ── PLAN — new ────────────────────────────────────────────────────────────
  {
    id: "plan-new.spec-readiness",
    scope: "plan-new",
    title: "leer el status de la spec y sugerir refinar sin bloquear",
    authority: "cli",
    ownership: "legacy",
    document: PLAN_NEW_LOOP,
  },
  {
    id: "plan-new.session",
    scope: "plan-new",
    title: "abrir o reanudar la sesión de generación del plan",
    authority: "cli",
    ownership: "legacy",
    document: PLAN_NEW_LOOP,
    effects: ["local_additive"],
  },
  {
    id: "plan-new.slug-derivation",
    scope: "plan-new",
    title: "derivar el slug del plan desde el requisito de la spec",
    authority: "agent",
    ownership: "legacy",
    document: PLAN_NEW_LOOP,
  },
  {
    id: "plan-new.numbering",
    scope: "plan-new",
    title: "asignar el correlativo del documento del plan",
    authority: "cli",
    ownership: "cli-owned",
    document: PLAN_NEW_LOOP,
    attribution: "`aw next-number docs/plans`",
  },
  {
    id: "plan-new.phase-shaping",
    scope: "plan-new",
    title: "agrupar el trabajo en estados verificables del sistema",
    authority: "agent",
    ownership: "legacy",
    document: PLAN_NEW_LOOP,
  },
  {
    id: "plan-new.batch-inference",
    scope: "plan-new",
    title: "inferir la partición máxima de execution batches",
    authority: "cli",
    ownership: "legacy",
    document: BATCHES_MD,
  },
  {
    id: "plan-new.split-signal",
    scope: "plan-new",
    title: "reconocer cada señal de división en tramos del plan",
    authority: "agent",
    ownership: "legacy",
    document: "modules/PLAN-SPLIT-GATE.md",
    signals: [
      "plan.independent-tranches",
      "plan.no-shared-deps",
      "plan.distinct-priorities",
      "plan.far-beyond-s",
      "plan.staging-requested",
    ],
  },
  {
    id: "plan-new.split-gate",
    scope: "plan-new",
    title: "aplicar el umbral de dos señales del gate multi-plan",
    authority: "cli",
    ownership: "legacy",
    document: "modules/PLAN-SPLIT-GATE.md",
  },
  {
    id: "plan-new.split-choice",
    scope: "plan-new",
    title: "elegir entre dividir en varios planes o conservar uno solo",
    authority: "human",
    ownership: "legacy",
    document: "modules/PLAN-SPLIT-GATE.md",
  },
  {
    id: "plan-new.coherence-gate",
    scope: "plan-new",
    title: "evaluar el gate de coherencia del plan generado",
    authority: "cli",
    ownership: "legacy",
    document: PLAN_NEW_LOOP,
  },
  {
    id: "plan-new.save-confirmation",
    scope: "plan-new",
    title: "confirmar la escritura del plan o de sus hermanos",
    authority: "human",
    ownership: "legacy",
    document: PLAN_NEW_LOOP,
  },
  {
    id: "plan-new.adoption",
    scope: "plan-new",
    title: "adoptar en una sola pasada un plan construido fuera del loop",
    authority: "cli",
    ownership: "legacy",
    document: "modules/PLAN-INPUT.md",
  },

  // ── PLAN — refine ─────────────────────────────────────────────────────────
  {
    id: "plan-refine.session",
    scope: "plan-refine",
    title: "abrir, reanudar o reabrir la sesión de refinamiento del plan",
    authority: "cli",
    ownership: "legacy",
    document: PLAN_REFINE_LOOP,
    effects: ["local_additive"],
  },
  {
    id: "plan-refine.journey-map",
    scope: "plan-refine",
    title: "mapear contrato observable, recorrido técnico, estrategia incremental y evidencia",
    authority: "agent",
    ownership: "legacy",
    document: PLAN_REFINE_LOOP,
  },
  {
    id: "plan-refine.preserve-validated",
    scope: "plan-refine",
    title: "conservar las fases validadas y rediseñar solo el trabajo pendiente",
    authority: "cli",
    ownership: "legacy",
    document: PLAN_REFINE_LOOP,
  },
  {
    id: "plan-refine.batch-reinference",
    scope: "plan-refine",
    title: "re-inferir y escribir la partición completa de batches",
    authority: "cli",
    ownership: "legacy",
    document: BATCHES_MD,
  },
  {
    id: "plan-refine.split-in-place",
    scope: "plan-refine",
    title: "reducir el plan original y extraer los hermanos sin mover trabajo completado",
    authority: "cli",
    ownership: "legacy",
    document: "modules/PLAN-REFINE-SPLIT.md",
    effects: ["local_additive", "mutate_overwrite"],
  },
  {
    id: "plan-refine.normalize-on-write",
    scope: "plan-refine",
    title: "normalizar la forma sin escribir bloques condicionales vacíos ni tocar estados",
    authority: "cli",
    ownership: "legacy",
    document: PLAN_REFINE_LOOP,
    effects: ["mutate_overwrite"],
  },
  {
    id: "plan-refine.executability-gate",
    scope: "plan-refine",
    title: "evaluar el gate de ejecutabilidad del plan",
    authority: "cli",
    ownership: "legacy",
    document: PLAN_REFINE_LOOP,
  },
  {
    id: "plan-refine.save-confirmation",
    scope: "plan-refine",
    title: "confirmar la sobreescritura del plan refinado",
    authority: "human",
    ownership: "legacy",
    document: PLAN_REFINE_LOOP,
  },

  // ── PLAN — exec ───────────────────────────────────────────────────────────
  {
    id: "plan-exec.session",
    scope: "plan-exec",
    title: "abrir o reanudar la sesión única de la corrida de ejecución",
    authority: "cli",
    ownership: "legacy",
    document: PLAN_EXEC_LOOP,
    effects: ["local_additive"],
  },
  {
    id: "plan-exec.entry-gate",
    scope: "plan-exec",
    title: "verificar en la entrada que el plan tiene forma ejecutable",
    authority: "cli",
    ownership: "legacy",
    document: PLAN_EXEC_LOOP,
  },
  {
    id: "plan-exec.entry-gap-severity",
    scope: "plan-exec",
    title: "distinguir un hueco menor de uno estructural en el plan",
    authority: "cli",
    ownership: "legacy",
    document: PLAN_EXEC_LOOP,
  },
  {
    id: "plan-exec.normalization-consent",
    scope: "plan-exec",
    title: "consentir la normalización del plan o derivar a plan-refine",
    authority: "human",
    ownership: "legacy",
    document: PLAN_EXEC_LOOP,
  },
  {
    id: "plan-exec.batch-inference",
    scope: "plan-exec",
    title: "re-inferir los batches efectivos sobre el estado vivo",
    authority: "cli",
    ownership: "legacy",
    document: BATCHES_MD,
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
    id: "plan-exec.branch-precondition",
    scope: "plan-exec",
    title: "verificar la rama de cada fuente afectada antes del batch",
    authority: "cli",
    ownership: "legacy",
    document: CODE_POLICIES_MD,
  },
  {
    id: "plan-exec.implementation",
    scope: "plan-exec",
    title: "implementar el trabajo mínimo de cada tarea de la fase",
    authority: "agent",
    ownership: "legacy",
    document: PLAN_EXEC_LOOP,
  },
  {
    id: "plan-exec.deviation-recognition",
    scope: "plan-exec",
    title: "reconocer qué toca el cambio que apareció al implementar",
    authority: "agent",
    ownership: "legacy",
    document: PLAN_EXEC_LOOP,
  },
  {
    id: "plan-exec.deviation-gate",
    scope: "plan-exec",
    title: "clasificar la desviación en local, estructural o funcional y derivar",
    authority: "cli",
    ownership: "legacy",
    document: PLAN_EXEC_LOOP,
  },
  {
    id: "plan-exec.task-marking",
    scope: "plan-exec",
    title: "marcar la tarea cuando su trabajo local termina",
    authority: "cli",
    ownership: "legacy",
    document: PLAN_EXEC_LOOP,
    effects: ["mutate_overwrite"],
  },
  {
    id: "plan-exec.phase-state-transition",
    scope: "plan-exec",
    title: "aplicar la transición de estado de fase con sus precondiciones",
    authority: "cli",
    ownership: "legacy",
    document: PLAN_EXEC_LOOP,
    effects: ["mutate_overwrite"],
  },
  {
    id: "plan-exec.validation-execution",
    scope: "plan-exec",
    title: "correr las pruebas de fase y las validaciones aplicables al cierre del batch",
    authority: "cli",
    ownership: "legacy",
    document: PLAN_EXEC_LOOP,
    effects: ["execute"],
  },
  {
    id: "plan-exec.deferred-check",
    scope: "plan-exec",
    title: "dejar bloqueada la fase cuyo chequeo operativo no puede correrse",
    authority: "cli",
    ownership: "legacy",
    document: PLAN_EXEC_LOOP,
  },
  {
    id: "plan-exec.review-findings",
    scope: "plan-exec",
    title: "releer el diff del batch y juzgar sus hallazgos",
    authority: "agent",
    ownership: "legacy",
    document: CODE_POLICIES_MD,
  },
  {
    id: "plan-exec.commit-enablement",
    scope: "plan-exec",
    title: "habilitar un commit por fuente solo tras un batch realmente verde",
    authority: "cli",
    ownership: "legacy",
    document: CODE_POLICIES_MD,
  },
  {
    id: "plan-exec.commit-authorization",
    scope: "plan-exec",
    title: "aprobar los commits del batch o preautorizarlos condicionalmente",
    authority: "human",
    ownership: "legacy",
    document: CODE_POLICIES_MD,
  },
  {
    id: "plan-exec.final-validation",
    scope: "plan-exec",
    title: "evaluar la validación final que habilita cerrar el plan",
    authority: "cli",
    ownership: "legacy",
    document: PLAN_EXEC_LOOP,
  },
  {
    id: "plan-exec.plan-done",
    scope: "plan-exec",
    title: "escribir el estado done del plan con su línea de cierre",
    authority: "cli",
    ownership: "legacy",
    document: PLAN_EXEC_LOOP,
    effects: ["mutate_overwrite"],
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
    ownership: "legacy",
    document: "commands/resume.md",
  },
  {
    id: "persist.shape-classification",
    scope: cmd("persist"),
    title: "clasificar la forma del trabajo ya hecho en la conversación",
    authority: "agent",
    ownership: "legacy",
    document: "commands/persist.md",
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
    ownership: "legacy",
    document: "commands/plan-exec.md",
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
    ownership: "legacy",
    document: "commands/fix-git.md",
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
    ownership: "legacy",
    document: "commands/export-reports.md",
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
 */
export const COMMAND_EXCLUSIONS: readonly CommandExclusion[] = [
  { command: "sessions", reason: "listado read-only del inventario de sesiones" },
  { command: "session-artifacts", reason: "inspección read-only de lo que guarda una sesión" },
  { command: "checkpoint-read", reason: "lectura del CHECKPOINT sin decidir continuación" },
  { command: "checkpoint-write", reason: "escritura del snapshot que dispara el hook" },
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

/** Whether any transition of this scope still decides from the doctrine. */
export function hasLegacyOwnership(scope: DecisionScope): boolean {
  return decisionsOfScope(scope).some((decision) => decision.ownership === "legacy");
}
