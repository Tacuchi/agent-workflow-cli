import { parseBatchEvidence } from "./parsers/batch-evidence.js";
import { PLAN_STATES, parsePlanStatus } from "./parsers/plan-status.js";

/** The command that turns a session-model hub into one of the new contract. */
export const HUB_MIGRATE_COMMAND = "aw hub-migrate";

export type PlanStatusContractCode =
  | "PLAN_STATUS_INVALID"
  | "PLAN_STATUS_UNMIGRATED"
  | "PLAN_NEXT_STEP_MISSING"
  | "PLAN_NEXT_STEP_MISPLACED"
  | "PLAN_BATCH_EVIDENCE_TOO_LONG"
  | "PLAN_BATCH_EVIDENCE_INVALID";

export interface PlanStatusContractFailure {
  code: PlanStatusContractCode;
  line?: number;
  message: string;
}

/**
 * The plan's own state contract (spec 066, ID01-ID02), judged over its bytes:
 * one exact state value, a `> Próximo paso:` line exactly while it is
 * `in-progress`, and at most five evidence lines per closed batch.
 *
 * A session-model value (`open`, or a value with a date/session suffix) is not
 * a state of this contract: it is reported as an unmigrated hub, naming the
 * command that migrates it.
 */
export function validatePlanStatusContract(text: string): PlanStatusContractFailure[] {
  const failures: PlanStatusContractFailure[] = [];
  const status = parsePlanStatus(text);
  const at = status.line !== null ? { line: status.line } : {};
  const values = PLAN_STATES.join(" | ");
  // An absent line is not a failure: publication seals it.
  if (status.unmigrated !== null) {
    failures.push({
      code: "PLAN_STATUS_UNMIGRATED",
      ...at,
      message:
        status.unmigrated === "legacy-suffix"
          ? `'> Estado:' lleva un sufijo del modelo de sesiones; el hub no está migrado: corré '${HUB_MIGRATE_COMMAND}'`
          : `'> Estado: ${status.declared}' es un valor del modelo de sesiones; el hub no está migrado: corré '${HUB_MIGRATE_COMMAND}'`,
    });
  } else if (status.declared === "unknown") {
    failures.push({
      code: "PLAN_STATUS_INVALID",
      ...at,
      message: `'> Estado:' no tiene un valor legible; valores: ${values}`,
    });
  }

  if (status.declared === "in-progress" && status.next_step === null) {
    failures.push({
      code: "PLAN_NEXT_STEP_MISSING",
      ...at,
      message: "un plan in-progress declara '> Próximo paso: Tn.m — <frase>' bajo '> Estado:'",
    });
  }
  if (status.next_step !== null && status.declared !== "in-progress") {
    failures.push({
      code: "PLAN_NEXT_STEP_MISPLACED",
      line: status.next_step.line,
      message: "'> Próximo paso:' sólo va mientras el plan está in-progress",
    });
  }

  for (const problem of parseBatchEvidence(text).problems) {
    failures.push({ code: problem.code, line: problem.line, message: problem.message });
  }
  return failures;
}
