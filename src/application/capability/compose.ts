/** Flow names shared by the run registry, CLI and session lifecycle. */
export const AGENT_WORKFLOW_FLOWS = [
  "spec-refine",
  "plan-new",
  "plan-refine",
  "plan-exec",
  "quick",
] as const;

export type AgentWorkflowFlow = (typeof AGENT_WORKFLOW_FLOWS)[number];
