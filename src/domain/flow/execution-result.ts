/**
 * Whether an execution result earned its transition — one rule, two producers.
 *
 * The verdict used to live inside `submit`, where the only producer was whoever
 * answered from outside. Since the CLI materializes some actions itself there are
 * two, and that is exactly why the rule moved here instead of being reimplemented:
 * an internal execution judged by a softer test than an external one would make
 * "the CLI ran it" a way to pass a check, which is the opposite of what running it
 * internally is for.
 *
 * Four verdicts, and each answers a way a run could claim work that never
 * happened: an outcome short of `completed` did not finish; evidence missing,
 * failed or empty means nothing came back; an effect ledger short of what the row
 * declared means the invocation got partway; and a finished attempt can still
 * declare its own coverage partial. The recovery the action declared travels in
 * every one of them, because a run stopped without a next step is the dead end
 * this contract refuses.
 */

import {
  type CheckoutState,
  validateCheckoutProof,
} from "../../application/source-boundary-policy.js";
import type { EffectClass } from "../capability/effects.js";
import type { CapabilityOutcome } from "../capability/protocol.js";
import { type CheckoutProof, SOURCE_BOUNDED_EVIDENCE } from "../source-boundary.js";
import type { FlowExecutionResult } from "./answer.js";
import type { DelegatedAction } from "./authority.js";
import type { PlanExecBatch } from "./run-state.js";
import {
  type TestFailure,
  readTestFailures,
  testFailureKey,
  testRunProblem,
} from "./test-run-evidence.js";

export interface ExecutionRefusal {
  message: string;
  detail: { code: string; action: string; outcome?: CapabilityOutcome };
}

export function executionVerdict(
  result: FlowExecutionResult | null,
  action: DelegatedAction | null,
  declared: readonly EffectClass[],
  checkoutStates: readonly CheckoutState[] | null = null,
  preexisting: readonly TestFailure[] | null = [],
): ExecutionRefusal | null {
  if (result === null || action === null) {
    return {
      message: "la respuesta no trae el resultado de la invocación",
      detail: {
        code: "FLOW_RESULT_INVALID",
        action:
          "devolvé el resultado real de la acción: outcome, invocación, validaciones y efectos",
      },
    };
  }
  if (result.outcome !== "completed") {
    return {
      message: `la invocación devolvió '${result.outcome}': la transición sigue pendiente`,
      detail: {
        code: "FLOW_EXECUTION_NOT_COMPLETED",
        action: action.recovery,
        outcome: result.outcome,
      },
    };
  }
  const missingCommands = missingFinalCommands(action);
  if (missingCommands !== null) return missingCommands;
  const missing = action.evidence.filter((id) => {
    const found = result.validations.find((validation) => validation.id === id);
    return found === undefined || !found.passed || (found.detail ?? "").trim().length === 0;
  });
  if (missing.length > 0) {
    return {
      message: `falta la evidencia real de ${missing.join(", ")}`,
      detail: {
        code: "FLOW_EVIDENCE_MISSING",
        action: `devolvé cada validación exigida con 'passed' y su 'detail' — la salida de la herramienta, no una afirmación. ${action.recovery}`,
      },
    };
  }
  const testEvidence = validationTestEvidence(result, preexisting);
  if (testEvidence !== null) return testEvidence;
  if (action.evidence.includes(SOURCE_BOUNDED_EVIDENCE)) {
    // Every proof the result carries is judged, not only the first: a batch of
    // several sources brings one per source, and a stale one among them must not
    // ride on a fresh sibling.
    for (const validation of result.validations.filter(
      (item) => item.id === SOURCE_BOUNDED_EVIDENCE,
    )) {
      const proof = validateCheckoutProof(validation.proof, checkoutStates);
      if (proof !== null) {
        return {
          message: proof.message,
          detail: { code: proof.code, action: action.recovery, outcome: "needs_input" },
        };
      }
    }
  }
  const applied = new Set(result.effects.applied);
  const partial = declared.filter((effect) => !applied.has(effect));
  if (partial.length > 0) {
    return {
      message: `la invocación declara completa pero no aplicó ${partial.join(", ")}`,
      detail: { code: "FLOW_EFFECT_PARTIAL", action: action.recovery, outcome: "needs_input" },
    };
  }
  // Completeness is not an outcome — it answers "does what came back cover what
  // was asked?" — so an attempt that FINISHED can still hand back a partial
  // output. Ignoring that here would let the run credit a search that returned
  // half its matches as if it had returned all of them.
  if (result.output?.completeness === "partial") {
    return {
      message: "la invocación terminó pero su salida declara cobertura parcial",
      detail: { code: "FLOW_EFFECT_PARTIAL", action: action.recovery, outcome: "needs_input" },
    };
  }
  return null;
}

function missingFinalCommands(action: DelegatedAction): ExecutionRefusal | null {
  if (action.final_validation === undefined) return null;
  const missing = action.final_validation.flatMap((source) =>
    (["build", "test"] as const).flatMap((field) => {
      const command = source[field];
      return command.command === null
        ? [command.action ?? `${source.alias} · ${field}: declaralo en la fuente o en el plan`]
        : [];
    }),
  );
  if (missing.length === 0 && action.final_validation.length > 0) return null;
  return {
    message: `faltan comandos de validación final: ${missing.join("; ") || "no se resolvió ninguna fuente de código"}`,
    detail: {
      code: "PLAN_FINAL_PIPELINE_MISSING",
      action: action.recovery,
      outcome: "needs_input",
    },
  };
}

function validationTestEvidence(
  result: FlowExecutionResult,
  preexisting: readonly TestFailure[] | null,
): ExecutionRefusal | null {
  for (const validation of result.validations) {
    if (
      validation.id !== "plan.validaciones-de-fase-verdes" &&
      validation.id !== "plan.validacion-final-verde" &&
      !/^plan\.final-validation\..+\.tests$/.test(validation.id)
    )
      continue;
    const problem = testRunProblem(validation.detail ?? "");
    if (problem !== null)
      return {
        message: `${problem.runner}: la suite ${problem.kind === "no-tests" ? "no ejecutó pruebas" : "no cargó"}: ${problem.line}`,
        detail: {
          code: "PLAN_TEST_RUN_NOT_EXECUTED",
          action:
            "corregí la selección o la carga de la suite y volvé a ejecutar; enviá su salida real completa",
        },
      };
    const failures = failureEvidence(
      validation.detail ?? "",
      validation.id === "plan.validaciones-de-fase-verdes" ? preexisting : [],
    );
    if (failures !== null) return failures;
  }
  return null;
}

function failureEvidence(
  detail: string,
  preexisting: readonly TestFailure[] | null,
): ExecutionRefusal | null {
  const action =
    'nombrá cada rojo preexistente dentro de su fase: > Rojos previos: [{"file":"archivo o clase JVM","case":"caso completo"}]; enviá la salida completa del runner con archivo y caso de cada falla';
  if (preexisting === null)
    return {
      message: "no se pueden leer los rojos previos de las fases del lote",
      detail: { code: "PLAN_PREEXISTING_FAILURES_INVALID", action },
    };
  const observed = readTestFailures(detail);
  if (observed.unreadable.length > 0)
    return {
      message: `hay fallas sin identidad legible: ${observed.unreadable.join("; ")}`,
      detail: { code: "PLAN_TEST_FAILURES_UNREADABLE", action },
    };
  const allowed = new Set(preexisting.map(testFailureKey));
  const fresh = observed.failures.filter((failure) => !allowed.has(testFailureKey(failure)));
  if (fresh.length > 0)
    return {
      message: `rojos fuera de la lista: ${fresh.map((failure) => `${failure.file} > ${failure.case}`).join("; ")}`,
      detail: { code: "PLAN_TEST_FAILURE_NEW", action },
    };
  return null;
}

/** What a batch's phase validation is judged against, beyond the live checkouts. */
export interface BatchCreditInput {
  validation_only_approved?: boolean;
  /** The batch this iteration walks. */
  batch: PlanExecBatch;
  /** Every batch of the run, the current one included. */
  batches: readonly PlanExecBatch[];
  /** The sources the batch has to prove, one proof each. */
  sources: readonly string[];
  /**
   * Each source's scoped fingerprint right now; `null` for a caller that has no
   * live reader, which judges the proofs' presence and reuse but not the change.
   */
  scoped: Readonly<Record<string, string | null>> | null;
}

/**
 * Whether a batch earned its credit with proofs of its OWN checkout — and which.
 *
 * The same `detail` in two batches decides nothing: what does is that at least
 * one source of this batch changed since its base, and that the proof of that
 * source did not already credit another batch. A source that did not change may
 * carry the same proof it carried before — a two-source batch that legitimately
 * touches one of them is still one batch of work.
 */
export function batchCreditVerdict(
  result: FlowExecutionResult,
  input: BatchCreditInput,
  recovery: string,
): { ok: true; credit: Record<string, string> } | { ok: false; refusal: ExecutionRefusal } {
  const proofs = result.validations.flatMap((validation) =>
    validation.id === SOURCE_BOUNDED_EVIDENCE && validation.proof !== undefined
      ? [validation.proof]
      : [],
  );
  const refused = (code: string, message: string) => ({
    ok: false as const,
    refusal: { message, detail: { code, action: recovery, outcome: "needs_input" as const } },
  });
  const credit: Record<string, string> = {};
  for (const source of input.sources) {
    const own = proofs.filter((proof) => proof.source === source);
    if (own.length !== 1) {
      return refused(
        own.length === 0 ? "WORKLINE_CHECKOUT_PROOF_MISSING" : "WORKLINE_CHECKOUT_PROOF_INVALID",
        own.length === 0
          ? `el batch ${input.batch.id} exige una prueba de checkout por fuente y falta la de '${source}'`
          : `el batch ${input.batch.id} trae ${own.length} pruebas de '${source}': va una por fuente`,
      );
    }
    credit[source] = (own[0] as CheckoutProof).checkout_digest;
  }
  if (input.batch.kind === "validation-only") {
    return validationOnlyCredit(input, credit, recovery);
  }
  const creditedBy = new Map(
    input.batches
      .filter((batch) => batch.id !== input.batch.id)
      .flatMap((batch) => Object.values(batch.credit ?? {}).map((digest) => [digest, batch.id])),
  );
  const fresh = input.sources.filter((source) => !creditedBy.has(credit[source] as string));
  if (fresh.length === 0) {
    const reused = input.sources
      .map((source) => `'${source}' ya acreditó ${creditedBy.get(credit[source] as string)}`)
      .join("; ");
    return refused(
      "PLAN_EXEC_PROOF_REUSED",
      `el batch ${input.batch.id} no trae ninguna prueba propia: ${reused}`,
    );
  }
  // A batch that began before its base could be recorded is judged against the
  // credits and the live checkout alone: a base rebuilt now would be invented.
  const base = input.batch.base;
  if (base === undefined || input.scoped === null) return { ok: true, credit };
  const scoped = input.scoped;
  const changed = fresh.filter((source) => {
    const before = base[source];
    const now = scoped[source];
    return typeof before === "string" && typeof now === "string" && before !== now;
  });
  if (changed.length > 0) return { ok: true, credit };
  const since =
    input.batch.iteration === 1 ? "el inicio de la corrida" : "el cierre del batch anterior";
  const why = input.sources
    .map((source) => {
      if (base[source] === null || base[source] === undefined) {
        return `'${source}' no se pudo observar al empezar el batch`;
      }
      if (scoped[source] === null || scoped[source] === undefined) {
        return `'${source}' no se puede observar ahora`;
      }
      if (creditedBy.has(credit[source] as string)) {
        return `la prueba de '${source}' ya acreditó ${creditedBy.get(credit[source] as string)}`;
      }
      return `'${source}' no cambió`;
    })
    .join("; ");
  return refused(
    "PLAN_EXEC_BATCH_UNCHANGED",
    `el batch ${input.batch.id} no cambió su checkout desde ${since}: ${why}`,
  );
}

function validationOnlyCredit(
  input: BatchCreditInput,
  credit: Record<string, string>,
  recovery: string,
): ReturnType<typeof batchCreditVerdict> {
  if (input.validation_only_approved === true && input.batch.tasks.length === 0)
    return { ok: true, credit };
  return {
    ok: false,
    refusal: {
      message:
        "el lote sin cambios exige aprobación previa y ninguna tarea abierta al entrar ni ahora",
      detail: {
        code: "PLAN_VALIDATION_ONLY_NOT_APPROVED",
        action: recovery,
        outcome: "needs_input",
      },
    },
  };
}
