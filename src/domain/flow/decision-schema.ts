/** Field vocabulary shared by directive hints and structured-decision readers. */
export const SCOPE_DECISION = {
  plan: "string (ruta del plan)",
  sources: "(string | {alias: string})[]",
} as const;

export const ROUTE_DECISION = {
  summary: "{finding: string, diagnosis: string, solution: string}",
  basis: "{intention: string, checkout: string, conventions: string, adopted_decisions: string}",
  controls: "{transition: string, disposition: apply|omit|substitute, reason: string}[]",
} as const;

export const NOTE_DECISION = {
  question: "{assertions: string[], behaviors: {key: string, summary: string}[]}",
  draft: "objeto de nota de decisión",
} as const;

export const SETTLEMENT_DECISION = {
  settlement:
    "{note: string, index: number, outcome: settled|handoff|pending, evidence?: string}[]",
} as const;

export function decisionFieldsFor(transition: string | null): Record<string, string> {
  switch (transition) {
    case "plan-exec.source-scope":
      return { ...SCOPE_DECISION };
    case "chassis.route-evaluation":
      return { route: `objeto ${Object.keys(ROUTE_DECISION).join(", ")}` };
    case "plan-exec.deviation-recognition":
      return { decision: `objeto ${Object.keys(NOTE_DECISION).join(", ")}` };
    case "plan-exec.settlement-authoring":
      return { ...SETTLEMENT_DECISION };
    default:
      return {};
  }
}
