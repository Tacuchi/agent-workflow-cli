import type {
  CapabilityDescriptor,
  CapabilityOperation,
} from "../../domain/capability/descriptor.js";
import type { Degradation, SelectedInstance } from "../../domain/capability/protocol.js";
import type { CapabilityBindingPolicy } from "../../domain/skills.js";
/** Resolve Workline's own floor against a host declaration for THIS attempt. */
import { semanticDigest } from "../semantic-operation/protocol.js";

/** The host names the contributor before it authors or produces effects. */
export interface HostContributor {
  name: string;
  order: number;
  digest: string;
  version?: string | null;
  locator?: string | null;
  metadata_source: "host" | "contributor";
  improves: { capability: string; operations: string[]; contract_version: number };
}

export interface HostSelection {
  /** A host-owned attempt token, sealed by a pre-content stage. */
  token: string;
  contributors: HostContributor[];
  /** Host-native selection event predating the candidate; required without a Workline pin. */
  preflight?: { stage: "before_contribution"; selection_digest: string };
}

export type CapabilityReadiness =
  | "ready"
  | "degraded"
  | "disabled"
  | "misconfigured"
  | "unavailable";

export interface OperationAvailability {
  operation: string;
  available: boolean;
  reason: string | null;
}

export interface CapabilityResolution {
  capability: string;
  state: CapabilityReadiness;
  floor: boolean;
  /** Credited only after a contribution passes the operation's validators. */
  selection: SelectedInstance[];
  /** Provisional selection: metadata alone has no receipt credit. */
  candidates: SelectedInstance[];
  degradations: Degradation[];
  operations: OperationAvailability[];
  reason: string | null;
  action: string | null;
}

export interface ResolveCapabilityInput {
  descriptor: CapabilityDescriptor;
  binding: CapabilityBindingPolicy;
  hostSelection?: HostSelection | null;
  operation?: string | null;
}

export function resolveCapability(input: ResolveCapabilityInput): CapabilityResolution {
  const { descriptor, binding } = input;
  const operations = descriptor.operations.map((op) => operationState(op, binding));
  if (binding.state === "off") {
    return {
      capability: descriptor.name,
      state: "disabled",
      floor: descriptor.floor.builtin && operations.some((op) => op.available),
      selection: [],
      candidates: [],
      degradations: [],
      operations,
      reason: binding.reason,
      action: `para reactivarla, quitá el binding o ponelo en '${descriptor.name}'`,
    };
  }
  if (binding.state === "misconfigured") {
    return degrade(
      descriptor,
      operations,
      "invalid_binding",
      binding.reason ?? "binding no aplicable",
      binding.action,
    );
  }
  const host = input.hostSelection;
  if (descriptor.floor.improvements === "none" || host == null) {
    return floorOnly(descriptor, operations);
  }
  const problem = identify(host, descriptor, input.operation ?? null);
  if (problem !== null)
    return degrade(descriptor, operations, problem.cause, problem.loss, problem.action);
  if (host.contributors.length === 0) return floorOnly(descriptor, operations);
  return {
    ...floorOnly(descriptor, operations),
    candidates: host.contributors.map((c) => ({
      name: c.name,
      scope: "host",
      locator: c.locator ?? "host-native",
      version: c.version ?? null,
      digest: c.digest,
      order: c.order,
    })),
  };
}

function operationState(
  op: CapabilityOperation,
  binding: CapabilityBindingPolicy,
): OperationAvailability {
  return binding.state === "off" && op.off === "blocked"
    ? {
        operation: op.name,
        available: false,
        reason: "la capacidad está en off y esta operación queda bloqueada",
      }
    : { operation: op.name, available: true, reason: null };
}

function floorOnly(
  descriptor: CapabilityDescriptor,
  operations: OperationAvailability[],
): CapabilityResolution {
  if (descriptor.floor.builtin) {
    return {
      capability: descriptor.name,
      state: "ready",
      floor: true,
      selection: [],
      candidates: [],
      degradations: [],
      operations,
      reason: null,
      action: null,
    };
  }
  const reason = `'${descriptor.name}' es una capacidad sin floor y no hay contribución conformante`;
  return {
    capability: descriptor.name,
    state: "unavailable",
    floor: false,
    selection: [],
    candidates: [],
    degradations: [],
    operations: operations.map((op) => ({ ...op, available: false, reason })),
    reason,
    action: "aportá una contribución compatible en este intento o dejá de invocar esa feature",
  };
}

type Cause = Degradation["cause"];
interface Problem {
  cause: Cause;
  loss: string;
  action: string;
}

function identify(
  host: HostSelection,
  descriptor: CapabilityDescriptor,
  operation: string | null,
): Problem | null {
  const fail = (cause: Cause, loss: string): Problem => ({
    cause,
    loss,
    action: "pedí al host selección identificable y compatible antes de contribuir",
  });
  if (
    typeof host.token !== "string" ||
    host.token.trim().length === 0 ||
    !Array.isArray(host.contributors)
  ) {
    return fail(
      "opaque_selection",
      "el host no fijó una selección identificable antes de contribuir",
    );
  }
  if (
    host.preflight !== undefined &&
    (typeof host.preflight !== "object" ||
      host.preflight === null ||
      host.preflight.stage !== "before_contribution" ||
      host.preflight.selection_digest !==
        semanticDigest({ token: host.token, contributors: host.contributors }))
  )
    return fail("opaque_selection", "el evento pre-efecto del host no sella esta selección");
  const seen = new Set<string>();
  for (const [index, contributor] of host.contributors.entries()) {
    if (
      typeof contributor !== "object" ||
      contributor === null ||
      typeof contributor.name !== "string" ||
      !contributor.name.trim() ||
      contributor.name !== contributor.name.trim() ||
      seen.has(contributor.name) ||
      contributor.order !== index + 1 ||
      typeof contributor.digest !== "string" ||
      !/^[a-f0-9]{64}$/i.test(contributor.digest) ||
      !["host", "contributor"].includes(contributor.metadata_source) ||
      (contributor.version != null && typeof contributor.version !== "string") ||
      (contributor.locator != null && typeof contributor.locator !== "string")
    )
      return fail(
        "opaque_selection",
        "la selección contiene identidad, orden o digest opacos/duplicados",
      );
    seen.add(contributor.name);
    const improves = contributor.improves;
    if (
      !improves ||
      improves.capability !== descriptor.name ||
      improves.contract_version !== descriptor.contract_version ||
      !Array.isArray(improves.operations) ||
      !improves.operations.every((entry) => typeof entry === "string" && entry.trim().length > 0) ||
      (operation !== null && !improves.operations.includes(operation))
    )
      return fail(
        "incompatible_improvement",
        `'${contributor.name}' no declara compatibilidad con ${descriptor.name}.${operation ?? "*"} v${descriptor.contract_version}`,
      );
  }
  return null;
}

function degrade(
  descriptor: CapabilityDescriptor,
  operations: OperationAvailability[],
  cause: Cause,
  loss: string,
  action: string | null,
): CapabilityResolution {
  const floor =
    descriptor.floor.builtin && descriptor.degradations.some((entry) => entry.cause === cause);
  return {
    capability: descriptor.name,
    state: floor ? "degraded" : "misconfigured",
    floor,
    selection: [],
    candidates: [],
    degradations: [{ cause, loss }],
    operations: floor
      ? operations
      : operations.map((op) => ({ ...op, available: false, reason: loss })),
    reason: loss,
    action: action ?? "corré la operación con el floor o corregí la selección",
  };
}

export function degradeContribution(
  resolved: CapabilityResolution,
  loss: string,
): CapabilityResolution {
  return {
    ...resolved,
    state: "degraded",
    floor: true,
    selection: [],
    // Even without credit, a selected candidate stays pinned through apply.
    candidates: resolved.candidates,
    degradations: [...resolved.degradations, { cause: "opaque_selection", loss }],
    reason: loss,
    action: "aportá evidencia de contenido validado en el intento, o usá el floor",
  };
}

export interface SelectionPin {
  capability: string;
  contract_version: number;
  floor: boolean;
  token: string | null;
  selection_digest: string | null;
  instances: Array<{ name: string; digest: string; order: number }>;
}

export function pinSelection(
  resolution: CapabilityResolution,
  descriptor: CapabilityDescriptor,
  hostSelection: HostSelection | null = null,
): SelectionPin {
  return {
    capability: resolution.capability,
    contract_version: descriptor.contract_version,
    floor: resolution.floor,
    token: resolution.candidates.length ? (hostSelection?.token ?? null) : null,
    selection_digest: resolution.candidates.length ? semanticDigest(hostSelection) : null,
    instances: resolution.candidates.map((s) => ({
      name: s.name,
      digest: s.digest,
      order: s.order,
    })),
  };
}

export type PinCheck = { ok: true } | { ok: false; degradation: Degradation; action: string };

export function checkPin(
  pin: SelectionPin,
  hostSelection: HostSelection | null,
  descriptor?: CapabilityDescriptor,
): PinCheck {
  if (
    typeof pin !== "object" ||
    pin === null ||
    !Array.isArray(pin.instances) ||
    (descriptor !== undefined &&
      (pin.capability !== descriptor.name || pin.contract_version !== descriptor.contract_version))
  )
    return {
      ok: false,
      degradation: {
        cause: "digest_changed",
        loss: "el pin de capacidad no corresponde al contrato de este intento",
      },
      action: "reenviá el pin íntegro de la selección anterior",
    };
  if (
    pin.instances.length === 0
      ? hostSelection == null || hostSelection.contributors.length === 0
      : hostSelection != null &&
        pin.token === hostSelection.token &&
        pin.selection_digest === semanticDigest(hostSelection)
  )
    return { ok: true };
  return {
    ok: false,
    degradation: {
      cause: "digest_changed",
      loss: "la selección del host cambió desde la fijación previa del intento",
    },
    action: "iniciá otra invocación con selección fijada antes de contribuir",
  };
}
