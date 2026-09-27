import type { BatchReview } from "../../src/domain/flow/batch-review.js";

/** External reviewer evidence supplied by journey fixtures, not by production code. */
export function batchReview(id = "reviewer"): BatchReview {
  return {
    implementers: ["author"],
    reviewer: { kind: "subagent", id },
    detail: "Diff completo revisado; sin hallazgos.",
    findings: [],
    corrections: [],
  };
}
