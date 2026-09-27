/** Declared review evidence. Identity is attributable, not independently authenticated. */
export interface BatchReviewer {
  kind: "subagent" | "person" | "clean-reread";
  id: string;
  /** The explicit exception for hosts without subagents. */
  no_subagents?: true;
}

export interface BatchReview {
  implementers: string[];
  reviewer: BatchReviewer;
  detail: string;
  findings: { id: string; detail: string; resolution: "fixed" | "deferred"; reason?: string }[];
  corrections: {
    findings: string[];
    implementers: string[];
    reviewer: BatchReviewer;
    detail: string;
  }[];
}

export const BATCH_REVIEW_CONTRACT =
  "En decisions.review entregá {implementers: [id], reviewer: {kind: subagent|person|clean-reread, id}, detail, findings: [{id, detail, resolution: fixed|deferred, reason?}], corrections: [{findings: [id], implementers: [id], reviewer, detail}]}. " +
  "Cada hallazgo fixed exige una ronda de corrección revisada; deferred exige reason. El revisor no puede implementar el lote ni sus correcciones. Sólo clean-reread con no_subagents: true admite la relectura propia cuando el host carece de subagentes. Las listas findings y corrections pueden estar vacías.";

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value === value.trim();
}

function ids(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every(text) &&
    new Set(value).size === value.length
  );
}

function reviewer(value: unknown, authors: readonly string[]): boolean {
  if (!record(value) || !text(value.id)) return false;
  if (value.kind === "clean-reread") return value.no_subagents === true;
  return (
    (value.kind === "subagent" || value.kind === "person") &&
    !authors.includes(value.id) &&
    value.no_subagents === undefined
  );
}

function finding(value: unknown): value is BatchReview["findings"][number] {
  if (!record(value) || !text(value.id) || !text(value.detail)) return false;
  return value.resolution === "fixed" || (value.resolution === "deferred" && text(value.reason));
}

function correction(value: unknown): value is BatchReview["corrections"][number] {
  return (
    record(value) &&
    ids(value.findings) &&
    ids(value.implementers) &&
    text(value.detail) &&
    record(value.reviewer)
  );
}

/** The same guard judges an answer and the persisted record; no second permissive reader. */
export function isBatchReview(value: unknown): value is BatchReview {
  if (
    !record(value) ||
    !ids(value.implementers) ||
    !text(value.detail) ||
    !Array.isArray(value.findings) ||
    !value.findings.every(finding) ||
    !Array.isArray(value.corrections) ||
    !value.corrections.every(correction)
  )
    return false;
  const findings = value.findings;
  if (new Set(findings.map((entry) => entry.id)).size !== findings.length) return false;
  const authors = [
    ...value.implementers,
    ...value.corrections.flatMap((round) => round.implementers),
  ];
  if (!reviewer(value.reviewer, authors)) return false;
  const fixed = new Set(
    findings.filter((entry) => entry.resolution === "fixed").map((entry) => entry.id),
  );
  const reviewed = new Set<string>();
  for (const round of value.corrections) {
    if (!reviewer(round.reviewer, authors) || round.findings.some((id) => !fixed.has(id)))
      return false;
    for (const id of round.findings) reviewed.add(id);
  }
  return [...fixed].every((id) => reviewed.has(id));
}
