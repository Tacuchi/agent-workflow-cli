/**
 * The accepted methodological route of one flow run.
 *
 * A route never weakens an unconfigured transition: only rows that explicitly
 * opt into `route_control` may be applied differently.  That makes the default
 * the legacy, hard-gate behaviour instead of an accidental opt-out.
 */

export const ROUTE_DISPOSITIONS = ["apply", "omit", "substitute"] as const;

export type RouteDisposition = (typeof ROUTE_DISPOSITIONS)[number];

export const ROUTE_ACCEPT_LABEL = "Aceptar propuesta";
export const ROUTE_ADJUST_LABEL = "Pedir ajustes";

export const ASSURANCE_STATUSES = [
  "verified",
  "partially_verified",
  "unverified_accepted",
] as const;

export type AssuranceStatus = (typeof ASSURANCE_STATUSES)[number];

export interface RouteControlConfiguration {
  recommendation: RouteDisposition;
  consequences: Readonly<Record<RouteDisposition, string>>;
  risk: string;
}

/** What the agent reports before a person accepts the route. */
export interface RouteProposal {
  /**
   * The user-facing explanation shown before any choice.
   *
   * Optional only so an in-flight v11 run written before this field existed stays
   * readable. Every new proposal is required to provide it at submit time.
   */
  summary?: RouteProposalSummary;
  basis: {
    intention: string;
    checkout: string;
    conventions: string;
    adopted_decisions: string;
  };
  controls: RouteProposalControl[];
}

export interface RouteProposalSummary {
  finding: string;
  diagnosis: string;
  solution: string;
}

export interface RouteProposalControl {
  transition: string;
  title: string;
  disposition: RouteDisposition;
  recommendation: RouteDisposition;
  alternatives: Readonly<Record<RouteDisposition, string>>;
  consequence: string;
  risk: string;
  reason: string;
  substitution: RouteSubstitution | null;
}

/** A replacement must be named; it never turns missing evidence green. */
export interface RouteSubstitution {
  validation: string;
  risk: string;
}

/** The person-approved disposition, stored separately from the proposal. */
export interface RouteDecision {
  transition: string;
  disposition: RouteDisposition;
  substitution: RouteSubstitution | null;
}

/**
 * A substitution is not proof by declaration. It stays partial until its own
 * configured transition has completed with the normal execution verdict.
 */
export function assuranceForRoute(
  decisions: readonly RouteDecision[],
  completed: readonly string[] = [],
): AssuranceStatus {
  if (decisions.some((decision) => decision.disposition === "omit")) {
    return "unverified_accepted";
  }
  if (
    decisions.some(
      (decision) =>
        decision.disposition === "substitute" && !completed.includes(decision.transition),
    )
  ) {
    return "partially_verified";
  }
  return "verified";
}

export function dispositionOf(
  decisions: readonly RouteDecision[] | null | undefined,
  transition: string,
): RouteDecision | null {
  return decisions?.find((decision) => decision.transition === transition) ?? null;
}

export function isRouteDisposition(value: unknown): value is RouteDisposition {
  return typeof value === "string" && (ROUTE_DISPOSITIONS as readonly string[]).includes(value);
}

export function isAssuranceStatus(value: unknown): value is AssuranceStatus {
  return typeof value === "string" && (ASSURANCE_STATUSES as readonly string[]).includes(value);
}
