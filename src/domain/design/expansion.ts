/**
 * Why a design would stop being one document — the closed list, and who may say
 * each one.
 *
 * The default route is a single readable `DESIGN.md`. The package — manifest,
 * catalog, screens, flows, maturity ladder, governance — is the EXCEPTION, and an
 * exception nobody can name a cause for is just the old default wearing a new
 * word. So the causes are enumerated here, once, and every extra stage or
 * artifact points back at the one that produced it.
 *
 * The frontier is the same one the flow registry draws between an `agent` row and
 * a `condition.threshold`: recognizing a signal is judgment, counting them is a
 * rule. Three of the five are semantic — only somebody who read the material can
 * say whether two outcomes are independent, whether a decision is functionally
 * blocked, or whether one document has stopped being clear. Two are STRUCTURAL:
 * they are facts the CLI already holds about the invocation, so asking anyone to
 * declare them would be asking for a claim that can disagree with the evidence.
 *
 * A signal outside this vocabulary never expands anything.
 */

import type { DesignSource } from "./sources.js";

/** Who may put a signal on the table. */
export type SignalOrigin =
  /** Judgment over the material: only the agent can observe it. */
  | "semantic"
  /** A fact about the invocation: the CLI derives it and nobody declares it. */
  | "structural";

export interface ExpansionSignal {
  id: string;
  origin: SignalOrigin;
  /** What the signal asserts, in the user's language. */
  means: string;
}

/**
 * The five causes, and nothing else.
 *
 * `as const` plus the lookup below is what makes it closed in practice and not
 * only in prose: an id that is not here has no entry to read, so it cannot carry
 * a meaning into a receipt.
 */
export const DESIGN_EXPANSION_SIGNALS: readonly ExpansionSignal[] = [
  {
    id: "design.independent-outcomes",
    origin: "semantic",
    means: "el trabajo produce dos o más resultados que valen por separado",
  },
  {
    id: "design.functional-blocking",
    origin: "semantic",
    means: "una decisión funcional sin cerrar bloquea el diseño y hay que resolverla aparte",
  },
  {
    id: "design.clarity-lost",
    origin: "semantic",
    means: "un solo documento dejaría de entenderse: el material ya no cabe legible",
  },
  {
    id: "design.governance-or-system-reuse",
    origin: "structural",
    means:
      "el trabajo continúa un package que ya lleva decisiones de gobierno o varias revisiones publicadas",
  },
  {
    id: "design.special-source-or-effect",
    origin: "structural",
    means:
      "hay una fuente sensible, una transmisión externa o una fuente declarada que no llegó a usarse",
  },
] as const;

const BY_ID = new Map(DESIGN_EXPANSION_SIGNALS.map((s) => [s.id, s]));

/** The signal an id names, or null when it is outside the vocabulary. */
export function expansionSignal(id: string): ExpansionSignal | null {
  return BY_ID.get(id) ?? null;
}

/** The ids the AGENT may declare — the structural ones are never declared. */
export const SEMANTIC_EXPANSION_SIGNALS: readonly string[] = DESIGN_EXPANSION_SIGNALS.filter(
  (s) => s.origin === "semantic",
).map((s) => s.id);

/**
 * How many distinct signals expand the route.
 *
 * One. Each of the five is on its own sufficient — the spec enumerates them as
 * alternatives, not as evidence to accumulate — and a threshold of two would mean
 * a design with a genuinely blocking functional decision stayed simple because
 * nothing else was wrong with it.
 */
export const EXPANSION_THRESHOLD = 1;

export type DesignRouteMode = "simple" | "package";

/** The facts the CLI reads to derive its own half of the vocabulary. */
export interface StructuralFacts {
  /** The invocation reads a source the policy marked sensitive. */
  sensitiveSources: boolean;
  /** The result, or part of it, leaves the machine. */
  externalTransmission: boolean;
  /** Sources as the run classified them: one that did not contribute counts. */
  sources: readonly DesignSource[];
  /** Governance records the targeted package already carries. */
  governanceRecords: number;
  /** Revisions the targeted package has already published. */
  publishedRevisions: number;
}

/**
 * The structural signals these facts really support.
 *
 * Derived and never declared: the two members it can emit are the two the CLI can
 * be held to, which is why an agent that "declares" one of them is refused rather
 * than believed.
 */
export function deriveStructuralSignals(facts: StructuralFacts): string[] {
  const fired: string[] = [];
  if (facts.governanceRecords > 0 || facts.publishedRevisions > 1) {
    fired.push("design.governance-or-system-reuse");
  }
  if (
    facts.sensitiveSources ||
    facts.externalTransmission ||
    facts.sources.some((s) => s.disposition !== "used")
  ) {
    fired.push("design.special-source-or-effect");
  }
  return fired;
}

export interface FiredSignal {
  id: string;
  origin: SignalOrigin;
  means: string;
}

export interface ExpansionVerdict {
  mode: DesignRouteMode;
  /** Every signal that fired, in vocabulary order, deduped. */
  fired: FiredSignal[];
  /** One line naming the cause, or null when the route stayed simple. */
  cause: string | null;
  /** Declared ids outside the vocabulary, or declared where only the CLI decides. */
  rejected: Array<{ id: string; why: string }>;
}

/**
 * The verdict: which route, which signals fired, and why.
 *
 * Rejections are REPORTED rather than thrown away. An agent that declared
 * `design.special-source-or-effect` is trying to expand on a fact the CLI already
 * checks, and one that declared an invented id is asking for a route nobody can
 * explain later; both deserve to see the answer instead of watching the signal
 * disappear.
 */
export function judgeExpansion(
  declared: readonly string[],
  structural: readonly string[],
): ExpansionVerdict {
  const rejected: ExpansionVerdict["rejected"] = [];
  const accepted = new Set<string>(structural);

  for (const id of declared) {
    const signal = expansionSignal(id);
    if (signal === null) {
      rejected.push({
        id,
        why: `'${id}' no pertenece al vocabulario de expansión: ${DESIGN_EXPANSION_SIGNALS.map((s) => s.id).join(", ")}`,
      });
      continue;
    }
    if (signal.origin === "structural") {
      rejected.push({
        id,
        why: `'${id}' lo deriva el CLI de la invocación: declararlo no lo hace verdadero`,
      });
      continue;
    }
    accepted.add(id);
  }

  // Vocabulary order, not arrival order: the cause a receipt shows has to read
  // the same way for two runs that observed the same things.
  const fired = DESIGN_EXPANSION_SIGNALS.filter((s) => accepted.has(s.id)).map((s) => ({
    id: s.id,
    origin: s.origin,
    means: s.means,
  }));

  if (fired.length < EXPANSION_THRESHOLD) {
    return { mode: "simple", fired, cause: null, rejected };
  }
  return {
    mode: "package",
    fired,
    cause: fired.map((s) => `${s.id}: ${s.means}`).join(" · "),
    rejected,
  };
}
