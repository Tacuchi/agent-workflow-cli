/** Flow names shared by the run registry, CLI and session lifecycle. */
export const WORKLINE_FLOWS = [
  "spec-refine",
  "plan-new",
  "plan-refine",
  "plan-exec",
  "quick",
] as const;

export type WorklineFlow = (typeof WORKLINE_FLOWS)[number];
