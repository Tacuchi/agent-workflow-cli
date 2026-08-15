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
import { SOURCE_BOUNDED_EVIDENCE } from "../source-boundary.js";
import type { FlowExecutionResult } from "./answer.js";
import type { DelegatedAction } from "./authority.js";

export interface ExecutionRefusal {
  message: string;
  detail: { code: string; action: string; outcome?: CapabilityOutcome };
}

export function executionVerdict(
  result: FlowExecutionResult | null,
  action: DelegatedAction | null,
  declared: readonly EffectClass[],
  checkoutStates: readonly CheckoutState[] | null = null,
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
  if (action.evidence.includes(SOURCE_BOUNDED_EVIDENCE)) {
    const validation = result.validations.find((item) => item.id === SOURCE_BOUNDED_EVIDENCE);
    const proof = validateCheckoutProof(validation?.proof, checkoutStates);
    if (proof !== null) {
      return {
        message: proof.message,
        detail: { code: proof.code, action: action.recovery, outcome: "needs_input" },
      };
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
