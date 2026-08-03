/**
 * How a flow composes a capability without handing over its own lifecycle.
 *
 * A flow reaches the SAME dispatcher, builder, handlers and receipt the direct
 * wrapper reaches. What changes is who owns the conversation: the capability
 * hands back requirements, output, validations, gaps and a receipt; the FLOW
 * turns a `needs_input` into its own structured-choice, keeps its session, its
 * gates, its references and its publication, and decides when it is done.
 *
 * The map below is the whole authorization. It is exhaustive and it is DATA:
 *
 * - **SPEC REFINE** authors — `create`, `update`, `validate`.
 * - **PLAN NEW / PLAN REFINE** may revise the design their plan closes over —
 *   `update`, `validate` — but never start one from nothing.
 * - **PLAN EXEC / QUICK** only `validate`, and then consume the package inside
 *   their own lifecycle. There is deliberately no sixth `consume` operation:
 *   consuming is what the FLOW does with a validated package, not something it
 *   asks the capability to do for it.
 *
 * Entries are `capability.operation`, so a second capability adds its own rows
 * and the flows that do not consume it are untouched — a table, never a branch.
 */

import type { CapabilityRequest, DurableReference } from "../../domain/capability/protocol.js";
import type { CapabilityFailure } from "../../domain/capability/protocol.js";
import type { DesignPackageEntry } from "../design/design-index-service.js";
import { resolveDesignPackage } from "../design/design-index-service.js";
import type { DesignIndex } from "../design/design-index-service.js";
import {
  type DispatchContext,
  type DispatchInput,
  type DispatchResult,
  dispatchCapability,
} from "./dispatcher.js";

export const WORKLINE_FLOWS = [
  "spec-refine",
  "plan-new",
  "plan-refine",
  "plan-exec",
  "quick",
] as const;

export type WorklineFlow = (typeof WORKLINE_FLOWS)[number];

export const COMPOSED_OPERATIONS: Readonly<Record<WorklineFlow, readonly string[]>> = {
  "spec-refine": ["design.create", "design.update", "design.validate"],
  "plan-new": ["design.update", "design.validate"],
  "plan-refine": ["design.update", "design.validate"],
  "plan-exec": ["design.validate"],
  quick: ["design.validate"],
};

export function composedOperationsOf(flow: WorklineFlow): readonly string[] {
  return COMPOSED_OPERATIONS[flow];
}

export function mayCompose(flow: WorklineFlow, capability: string, operation: string): boolean {
  return COMPOSED_OPERATIONS[flow].includes(`${capability}.${operation}`);
}

export interface ComposeInput extends Omit<DispatchInput, "route" | "flow"> {
  flow: WorklineFlow;
}

/**
 * THE composed adapter. Every flow goes through it, and it refuses anything the
 * map does not authorize instead of improvising a wider surface.
 *
 * `route` and `flow` are forced here rather than accepted from the caller: a
 * flow that could declare itself `direct` would be a flow that escapes its own
 * boundary, and the receipt would name the wrong caller.
 */
export async function composeCapability(
  input: ComposeInput,
  ctx: DispatchContext,
): Promise<DispatchResult> {
  const operation = input.operation ?? input.parent?.operation ?? null;
  if (operation === null) {
    return {
      ok: false,
      failure: {
        code: "CAPABILITY_COMPOSE_OPERATION_MISSING",
        message: `'${input.flow}' tiene que nombrar la operación que compone`,
        action: `usá una de: ${composedOperationsOf(input.flow).join(", ")}`,
      },
    };
  }
  if (!mayCompose(input.flow, input.capability, operation)) {
    return {
      ok: false,
      failure: {
        code: "CAPABILITY_COMPOSE_NOT_ALLOWED",
        message: `'${input.flow}' no compone '${input.capability}.${operation}'`,
        action: `desde este flow solo: ${composedOperationsOf(input.flow).join(", ") || "(ninguna)"}`,
      },
    };
  }
  return dispatchCapability({ ...input, route: "compose", flow: input.flow }, ctx);
}

/**
 * What a flow may NOT do to a capability's verdict.
 *
 * Adding a gate of its own is legitimate — a flow knows things the capability
 * does not. Lowering one is not: accepting an output the capability judged
 * invalid would make the capability's validation decorative, and the flow would
 * be publishing something nothing vouched for.
 */
export interface FlowGate {
  id: string;
  passed: boolean;
}

export type GateComposition =
  | { ok: true; gates: FlowGate[] }
  | { ok: false; failure: CapabilityFailure };

export function composeGates(
  attempt: DispatchResult,
  flowGates: readonly FlowGate[],
): GateComposition {
  if (!attempt.ok) return { ok: false, failure: attempt.failure };
  const capabilityGates: FlowGate[] = attempt.attempt.receipt.validations.map((v) => ({
    id: v.id,
    passed: v.passed,
  }));
  const overridden = flowGates.filter((g) =>
    capabilityGates.some((c) => c.id === g.id && !c.passed && g.passed),
  );
  if (overridden.length > 0) {
    return {
      ok: false,
      failure: {
        code: "CAPABILITY_GATE_LOWERED",
        message: `el flow declara en verde una validación que la capacidad reprobó: ${overridden
          .map((g) => g.id)
          .join(", ")}`,
        action: "corregí el output, o sumá un gate propio en vez de reescribir el ajeno",
      },
    };
  }
  return { ok: true, gates: [...capabilityGates, ...flowGates] };
}

export type Adoption =
  | { ok: true; reference: DurableReference; entry: DesignPackageEntry }
  | { ok: false; failure: CapabilityFailure };

/**
 * Adopt an output that the DIRECT route produced, by exact reference.
 *
 * The identity, the revision and the digest are what get checked; the locator is
 * a hint that may have gone stale without costing anything. Nothing is recreated
 * and nothing is converted — a flow that rebuilt the package would produce a
 * second artifact claiming to be the first, and the two would drift the moment
 * either changed.
 */
export function adoptDurableReference(reference: DurableReference, index: DesignIndex): Adoption {
  const entry = resolveDesignPackage(index, reference.id);
  if (entry === null) {
    return {
      ok: false,
      failure: {
        code: "CAPABILITY_ADOPTION_NOT_FOUND",
        message: `no hay ningún package con identidad ${reference.id}`,
        action: "revisá que el output directo se haya publicado en este workspace",
      },
    };
  }
  if (reference.revision !== null && entry.current_baseline?.revision !== reference.revision) {
    return {
      ok: false,
      failure: {
        code: "CAPABILITY_ADOPTION_REVISION_MISMATCH",
        message: `${reference.id} está en r${entry.current_baseline?.revision ?? "—"} y la referencia dice r${reference.revision}`,
        action: "adoptá la revisión vigente, o volvé a referenciar la que corresponde",
      },
    };
  }
  if (entry.current_baseline !== null && entry.current_baseline.digest !== reference.digest) {
    return {
      ok: false,
      failure: {
        code: "CAPABILITY_ADOPTION_DIGEST_MISMATCH",
        message: `${reference.id} ya no tiene los bytes que la referencia sella`,
        action: "re-resolvé la referencia: lo publicado cambió después de producirla",
      },
    };
  }
  // Same identity, same revision, same digest: adopted as it is.
  return { ok: true, reference, entry };
}

/** The request a flow passes on, unchanged — proof it shared, not re-derived. */
export function composedRequestOf(result: DispatchResult): CapabilityRequest | null {
  return result.ok ? result.attempt.request : null;
}
