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
}

/** A decision computes a verdict; writing is the exception that declares itself. */
export const DEFAULT_TRANSITION_EFFECTS: readonly EffectClass[] = ["read_only"];

/** What applying this transition does. */
export function effectsOf(decision: FlowDecision): readonly EffectClass[] {
  return decision.effects ?? DEFAULT_TRANSITION_EFFECTS;
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

  // ── QUICK — the pilot tranche ─────────────────────────────────────────────
  {
    id: "quick.entry-gate-signal",
    scope: "quick",
    title: "reconocer cada señal de tamaño en el objetivo recibido",
    authority: "agent",
    ownership: "legacy",
    document: QUICK_LOOP,
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
    ownership: "legacy",
    document: QUICK_LOOP,
  },
  {
    id: "quick.anti-duplicate",
    scope: "quick",
    title: "recomendar reanudar la spec o sesión que ya cubre este objetivo",
    authority: "cli",
    ownership: "legacy",
    document: QUICK_LOOP,
  },
  {
    id: "quick.gate-choice",
    scope: "quick",
    title: "elegir entre cambiar a SPEC, seguir en quick o recortar el alcance",
    authority: "human",
    ownership: "legacy",
    document: QUICK_LOOP,
  },
  {
    id: "quick.session-create",
    scope: "quick",
    title: "crear la sesión liviana de la tarea",
    authority: "cli",
    ownership: "legacy",
    document: QUICK_LOOP,
    effects: ["local_additive"],
  },
  {
    id: "quick.success-criteria-authoring",
    scope: "quick",
    title: "redactar la prueba o la rúbrica proporcional del entregable",
    authority: "agent",
    ownership: "legacy",
    document: QUICK_LOOP,
  },
  {
    id: "quick.success-criteria-ratification",
    scope: "quick",
    title: "ratificar la rúbrica cuando el entregable es análisis o diseño",
    authority: "human",
    ownership: "legacy",
    document: QUICK_LOOP,
  },
  {
    id: "quick.artifact-seed-order",
    scope: "quick",
    title: "sembrar objetivo, criterios y CHECKPOINT antes de trabajar",
    authority: "cli",
    ownership: "legacy",
    document: QUICK_LOOP,
    effects: ["local_additive"],
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
    ownership: "legacy",
    document: QUICK_LOOP,
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
    ownership: "legacy",
    document: QUICK_LOOP,
  },
  {
    id: "quick.escalation-destination",
    scope: "quick",
    title: "resolver SPEC en vivo y PLAN diferido como destinos de la escalación",
    authority: "cli",
    ownership: "legacy",
    document: QUICK_LOOP,
  },
  {
    id: "quick.convergence-gate",
    scope: "quick",
    title: "evaluar los criterios proporcionales de la tarea",
    authority: "cli",
    ownership: "legacy",
    document: QUICK_LOOP,
    effects: ["execute"],
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
  },
  {
    id: "resume.priority-derivation",
    scope: cmd("resume"),
    title: "derivar qué continuar y con qué comando exacto",
    authority: "cli",
    ownership: "cli-owned",
    document: "commands/resume.md",
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
  },
  {
    id: "context-budget.verdict",
    scope: cmd("context-budget"),
    title: "medir el costo de carga de un comando contra su techo",
    authority: "cli",
    ownership: "cli-owned",
    document: "commands/plan-exec.md",
  },
  {
    id: "session-create.numbering",
    scope: cmd("session-create"),
    title: "asignar el NNN global al crear la sesión",
    authority: "cli",
    ownership: "cli-owned",
    document: "modules/SESSION-NUMBERING.md",
    effects: ["local_additive"],
  },
  {
    id: "session-close.closure",
    scope: cmd("session-close"),
    title: "cerrar la sesión y actualizar su fila del registro durable",
    authority: "cli",
    ownership: "cli-owned",
    document: "modules/SESSION-NUMBERING.md",
    effects: ["mutate_overwrite"],
  },
  {
    id: "session-resume.reopen",
    scope: cmd("session-resume"),
    title: "resolver y reabrir la sesión que continúa el trabajo",
    authority: "cli",
    ownership: "cli-owned",
    document: "modules/SESSION-NUMBERING.md",
    effects: ["mutate_overwrite"],
  },
  {
    id: "check-branch.verdict",
    scope: cmd("check-branch"),
    title: "verificar si la fuente está en la rama que el trabajo espera",
    authority: "cli",
    ownership: "cli-owned",
    document: CODE_POLICIES_MD,
  },
  {
    id: "next-number.correlative",
    scope: cmd("next-number"),
    title: "entregar el correlativo siguiente de una carpeta documental",
    authority: "cli",
    ownership: "cli-owned",
    document: "modules/SESSION-NUMBERING.md",
  },
  {
    id: "capability.routing",
    scope: cmd("capability"),
    title: "resolver ruta, autorización de efectos y receipt de un intento",
    authority: "cli",
    ownership: "cli-owned",
    document: "roles/design/CONTRACT.md",
  },
  {
    id: "designs.reference-verdict",
    scope: cmd("designs"),
    title: "decidir si una referencia de diseño resuelve, cambió, fue revocada o no cierra",
    authority: "cli",
    ownership: "cli-owned",
    document: "modules/DESIGN-REFERENCES.md",
  },
  {
    id: "workspace-init.scaffold",
    scope: cmd("workspace-init"),
    title: "sembrar el andamiaje mínimo del workspace",
    authority: "cli",
    ownership: "cli-owned",
    document: "modules/WORKSPACE-SCAFFOLD.md",
    effects: ["local_additive"],
  },
  {
    id: "generate-launch.detection",
    scope: cmd("generate-launch"),
    title: "detectar el stack de cada fuente y generar sus artefactos de arranque",
    authority: "cli",
    ownership: "cli-owned",
    document: "modules/LAUNCH-DETECTION.md",
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
