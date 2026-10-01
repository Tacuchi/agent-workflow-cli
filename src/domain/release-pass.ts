/**
 * A pass to production, as its own object.
 *
 * The hub could already say a plan was CLOSED. Closed is not released, and
 * conflating them is how "done" came to mean the most finished thing the arnés
 * could name while the work sat unshipped. A pass is the missing axis: which
 * plans travelled together, over which sources, and whether each of those
 * sources actually arrived.
 *
 * Two things are deliberately kept apart, per the plan's ID-03:
 *
 * - the **version NAMES the pass** — it is an identifier a person recognizes,
 *   and it is not any source's arrival fact. A pass over two sources whose
 *   versions differ is still one pass with one name;
 * - the **order between passes is the ledger's sequence**, never a comparison of
 *   names. Version strings are not orderable across sources, and a pass named
 *   after a source that publishes no version would have no place in such an
 *   order at all.
 *
 * Uniqueness of the name is therefore enforced where it is cheap and meaningful:
 * at declaration. After that the name identifies, and nothing reads meaning into
 * its shape.
 */

import { type WorklineNodeId, formatNodeId } from "./workline-node.js";

/** Thrown with a `code` the CLI layer turns into `{ ok: false, error }`. */
export class ReleasePassError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ReleasePassError";
  }
}

export interface ReleasePass {
  /** What names this pass. Unique among passes; never a source's arrival fact. */
  version: string;
  /** The plans it carries, by canonical identity. */
  plans: WorklineNodeId[];
  /** The source aliases it goes over, as `AGENTS.md > Fuentes` spells them. */
  sources: string[];
}

/**
 * What constitutes a source's arrival.
 *
 * Three kinds because this hub's own two sources arrive differently and
 * both are ordinary: `agent-workflow-cli` arrives by publishing a package
 * version, `ui-spec-generator` by its work reaching its production branch. A
 * deployment is the third shape the same fact takes elsewhere. None of them is
 * verified against the world — registering an arrival is DECLARING a fact, and
 * a check against a registry or a live host would make the record depend on
 * network reachability to say what somebody already knows.
 */
const ARRIVAL_KINDS = ["published-version", "deployment", "production-branch"] as const;

export type ArrivalKind = (typeof ARRIVAL_KINDS)[number];

export interface SourceArrival {
  source: string;
  kind: ArrivalKind;
  /** The fact itself: the version published, the deployment, the branch reached. */
  detail: string;
  /** The date the arrival happened — not the date it was recorded. */
  at: string;
}

/**
 * What constitutes the SQL of a pass having RUN against an environment.
 *
 * Its own fact, and deliberately NOT a fourth `ArrivalKind`. `passStandingOf`
 * derives the release axis by crossing arrivals against `pass.sources`, and
 * those are CODE source aliases as `AGENTS.md > Fuentes` spells them. An
 * environment is not a source: naming one in `SourceArrival.source` would make
 * any hub whose alias happened to match an environment's name read its
 * release axis as arrived when nothing arrived at all. Two axes that answer two
 * questions stay two axes.
 *
 * Nothing here is verified against a database either, and for a stronger reason
 * than with an arrival: schema introspection only reaches DDL, so an `UPDATE`
 * or an `INSERT` that already ran leaves no detectable trace. The fact is
 * DECLARED by whoever ran it.
 */
export interface SqlApplication {
  /** Where the SQL ran — `certificación`, `producción`, … Never a code source. */
  environment: string;
  /** The fact itself: who applied it, against which instance, under which ticket. */
  detail: string;
  /** The date it ran — not the date it was recorded. */
  at: string;
}

/**
 * Where a pass stands on the APPLICATION axis.
 *
 * `no-record` is NOT "nothing was applied", for the same reason `no-record` is
 * not `pending` on the production axis: a book that says nothing about an
 * environment is a book that was never asked about it, and reporting silence as
 * "nothing ran there" is what would send SQL that already ran back to an
 * operator. Only the record can tell the two apart, and when it says nothing,
 * that is the answer.
 */
export type SqlApplicationStanding =
  | { axis: "applied"; environments: string[] }
  | { axis: "no-record" };

/** The application standing of one pass, derived from its facts. */
export function sqlApplicationStandingOf(
  applications: readonly SqlApplication[],
): SqlApplicationStanding {
  if (applications.length === 0) return { axis: "no-record" };
  // A Set iterates in insertion order, so the environments come back deduplicated
  // and still in the order the book recorded them.
  const environments = [...new Set(applications.map((application) => application.environment))];
  return { axis: "applied", environments };
}

/**
 * Where a pass stands, derived from its facts and never from a written field.
 *
 * `partially-released` is the state the whole object exists for: with one of two
 * sources arrived, neither "open" nor "released" is true, and both of those
 * answers would let the work of the source that did NOT arrive read as shipped.
 */
export type PassState = "open" | "partially-released" | "released" | "reverted";

export interface PassStanding {
  state: PassState;
  /** Sources with an arrival on record, in declaration order. */
  arrived: string[];
  /** Sources still missing one, in declaration order. */
  missing: string[];
}

/**
 * The standing of one pass.
 *
 * Reversion wins over everything: a reverted pass is not partially released, it
 * is reverted, and the work it carried counts as not released again. The
 * arrivals are NOT erased — they happened — which is why the reversion is its
 * own fact rather than the deletion of theirs.
 */
export function passStandingOf(
  pass: ReleasePass,
  arrivals: readonly SourceArrival[],
  reverted: boolean,
): PassStanding {
  const seen = new Set(arrivals.map((arrival) => arrival.source));
  const arrived = pass.sources.filter((source) => seen.has(source));
  const missing = pass.sources.filter((source) => !seen.has(source));
  if (reverted) return { state: "reverted", arrived, missing };
  if (arrived.length === 0) return { state: "open", arrived, missing };
  return {
    state: missing.length === 0 ? "released" : "partially-released",
    arrived,
    missing,
  };
}

/** Validate a declaration before it can be appended. Manual, per DEC-001. */
export function assertDeclarable(pass: ReleasePass): void {
  if (pass.version.trim().length === 0) {
    throw new ReleasePassError(
      "RELEASE_PASS_UNNAMED",
      "un pase se identifica por la versión que publica: nombrala",
    );
  }
  if (pass.sources.length === 0) {
    throw new ReleasePassError(
      "RELEASE_PASS_NO_SOURCES",
      `el pase '${pass.version}' no declara ninguna fuente: sin fuentes no hay llegada que registrar`,
    );
  }
  if (new Set(pass.sources).size !== pass.sources.length) {
    throw new ReleasePassError(
      "RELEASE_PASS_DUPLICATE_SOURCE",
      `el pase '${pass.version}' nombra dos veces la misma fuente`,
    );
  }
  const foreign = pass.plans.find((plan) => plan.kind !== "plan");
  if (foreign !== undefined) {
    throw new ReleasePassError(
      "RELEASE_PASS_NOT_A_PLAN",
      `un pase lleva planes, y '${formatNodeId(foreign)}' no lo es`,
    );
  }
  const seen = new Set<string>();
  for (const plan of pass.plans) {
    const key = formatNodeId(plan);
    if (seen.has(key)) {
      throw new ReleasePassError(
        "RELEASE_PASS_DUPLICATE_PLAN",
        `el pase '${pass.version}' lleva dos veces a '${key}'`,
      );
    }
    seen.add(key);
  }
}

export function isArrivalKind(value: unknown): value is ArrivalKind {
  return typeof value === "string" && (ARRIVAL_KINDS as readonly string[]).includes(value);
}
