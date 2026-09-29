import type { CheckoutProof } from "../source-boundary.js";
import type { EffectClass } from "./effects.js";

/** Shared flow result and attempt shapes, retained for existing sealed runs. */
export interface CapabilityFailure {
  code: string;
  message: string;
  action: string;
  violations?: {
    code: string;
    field: string;
    expected?: string;
    received?: string;
    message: string;
  }[];
}

export const CAPABILITY_OUTCOMES = [
  "completed",
  "needs_input",
  "blocked",
  "failed",
  "cancelled",
] as const;
export type CapabilityOutcome = (typeof CAPABILITY_OUTCOMES)[number];

export interface DurableReference {
  id: string;
  revision: number | null;
  digest: string;
  locator: string;
}

export const COMPLETENESS_VALUES = ["complete", "partial"] as const;
export type Completeness = (typeof COMPLETENESS_VALUES)[number];

export interface OperationOutput {
  value: unknown | null;
  reference: DurableReference | null;
  completeness: Completeness | null;
}

export interface ValidationOutcome {
  id: string;
  passed: boolean;
  detail: string | null;
  proof?: CheckoutProof;
}

export interface EffectLedger {
  planned: EffectClass[];
  approved: EffectClass[];
  applied: EffectClass[];
}

/** An old run may carry these causes; a new flow does not select external improvements. */
export interface Degradation {
  cause: "opaque_selection" | "incompatible_improvement" | "invalid_binding" | "digest_changed";
  loss: string;
}

export type AttemptIdentity = {
  invocation_id: string;
  attempt: number;
  request_digest: string;
  parent_request_digest: string | null;
};

export type AttemptRecord =
  | { ok: true; kind: "new" | "retry" }
  | { ok: false; failure: CapabilityFailure };

/** The sealed flow attempt chain: a resend is not a new answer. */
export class AttemptLedger {
  private readonly seen = new Map<string, Map<number, string>>();

  record(request: AttemptIdentity): AttemptRecord {
    const attempts = this.seen.get(request.invocation_id) ?? new Map<number, string>();
    const known = attempts.get(request.attempt);
    if (known !== undefined) {
      if (known === request.request_digest) return { ok: true, kind: "retry" };
      return {
        ok: false,
        failure: {
          code: "CAPABILITY_ATTEMPT_DIVERGED",
          message: `el intento ${request.attempt} ya existe con otro contenido`,
          action: "para pedir algo distinto usá el attempt siguiente, no el mismo número",
        },
      };
    }
    const highest = Math.max(0, ...attempts.keys());
    if (request.attempt !== highest + 1) {
      return {
        ok: false,
        failure: {
          code: "CAPABILITY_ATTEMPT_OUT_OF_SEQUENCE",
          message: `llegó el intento ${request.attempt} y el anterior registrado es ${highest}`,
          action: `enviá el intento ${highest + 1}`,
        },
      };
    }
    if (
      request.attempt > 1 &&
      attempts.get(request.attempt - 1) !== request.parent_request_digest
    ) {
      return {
        ok: false,
        failure: {
          code: "CAPABILITY_PARENT_NOT_IMMEDIATE",
          message: "el request padre no es el intento inmediatamente anterior",
          action: `enlazá el intento ${request.attempt} con el digest del intento ${request.attempt - 1}`,
        },
      };
    }
    attempts.set(request.attempt, request.request_digest);
    this.seen.set(request.invocation_id, attempts);
    return { ok: true, kind: "new" };
  }
}
