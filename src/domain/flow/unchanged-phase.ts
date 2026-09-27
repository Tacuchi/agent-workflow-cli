import type { FlowRunState, PlanExecBatch } from "./run-state.js";

export const UNCHANGED_PHASE_CONSENT = "plan-exec.unchanged-phase-consent";
export const APPROVE_UNCHANGED_PHASE = "Aprobar validación sin cambios";

/** Approval covers the entry observation of this plan, never a later assertion by the executor. */
export function approvedValidationOnly(state: FlowRunState, batch: PlanExecBatch): boolean {
  const entry = state.plan_exec_entry;
  if (
    batch.kind !== "validation-only" ||
    batch.tasks.length !== 0 ||
    batch.phases.length === 0 ||
    entry?.plan === null ||
    entry?.plan !== state.scope?.plan
  )
    return false;
  return batch.phases.every(
    (phase) =>
      entry?.phases_without_open_tasks?.includes(phase) === true &&
      entry.approved_without_changes?.includes(phase) === true,
  );
}
