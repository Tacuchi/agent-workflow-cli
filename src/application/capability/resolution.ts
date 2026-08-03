/**
 * What will actually run, and who gets credit for it.
 *
 * The resolution answers three questions that used to have no answer at all:
 * whether the capability is available, whether an improvement contributes, and —
 * when one does — WHICH exact instance, pinned so it cannot change mid-
 * conversation. Everything here is built so that the honest answer is always
 * reachable:
 *
 * - **No improvement is the ordinary case, not a degradation.** A machine with
 *   nothing extra installed runs the floor and reports `ready`. Calling that
 *   "degraded" would make the normal state look broken and hide the real one.
 * - **A degradation names its cause and its loss, and attributes nothing.** When
 *   a selection cannot be identified, the run does not guess who helped; it says
 *   what it could not verify.
 * - **A floor is what keeps a missing skill from blocking a flow.** A capability
 *   a core gate needs declares `floor.builtin`; one that does not may be
 *   `unavailable`, and then it blocks ITS operations and nothing else.
 */

import type {
  CapabilityDescriptor,
  CapabilityOperation,
} from "../../domain/capability/descriptor.js";
import type { Degradation, SelectedInstance } from "../../domain/capability/protocol.js";
import type { CapabilityBindingPolicy } from "../../domain/skills.js";
import type { CapabilityInventory, InstalledCapability } from "./installed-inventory.js";
import { findInstalled } from "./installed-inventory.js";

/**
 * A contributor as the HOST declared it. Data to verify, never an instruction:
 * the host decides selection and order, and this layer decides whether what it
 * named can be identified and speaks the contract.
 */
export interface HostContributor {
  name: string;
  /** 1-based position in the host's own selection. */
  order: number;
  version?: string | null;
  digest?: string | null;
  /** Which installed copy answered, when the same name exists under several roots. */
  locator?: string | null;
}

export interface HostSelection {
  contributors: HostContributor[];
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
  /** Whether the built-in floor is what produces the result. */
  floor: boolean;
  selection: SelectedInstance[];
  degradations: Degradation[];
  operations: OperationAvailability[];
  reason: string | null;
  action: string | null;
}

export interface ResolveCapabilityInput {
  descriptor: CapabilityDescriptor;
  binding: CapabilityBindingPolicy;
  inventory: CapabilityInventory;
  /** What the host says contributed, if it says anything at all. */
  hostSelection?: HostSelection | null;
  /** Narrows the compatibility check to the operation being invoked. */
  operation?: string | null;
}

export function resolveCapability(input: ResolveCapabilityInput): CapabilityResolution {
  const { descriptor, binding } = input;
  const operations = availability(descriptor, binding);

  if (binding.state === "off") {
    return {
      capability: descriptor.name,
      state: "disabled",
      // The operations `off` leaves alive still run on the floor. Reporting
      // `floor: false` here would say nothing implements `validate`, which is
      // exactly the consumption `off` is required to preserve.
      floor: descriptor.floor.builtin && operations.some((o) => o.available),
      selection: [],
      degradations: [],
      operations,
      reason: binding.reason,
      action: `para reactivarla, quitá el binding o ponelo en '${descriptor.name}'`,
    };
  }

  if (binding.state === "misconfigured") {
    return degradeToFloor(input, operations, {
      cause: "invalid_binding",
      loss: binding.reason ?? "el binding no selecciona una instancia identificable",
      action: binding.action,
    });
  }

  const contributors = input.hostSelection?.contributors ?? [];
  if (descriptor.floor.improvements === "none" || contributors.length === 0) {
    // Nothing extra selected. Not a loss — there was nothing to lose.
    return floorOnly(descriptor, operations);
  }

  const verified = verifyContributors(input, contributors);
  if (verified.degradation !== null) {
    return degradeToFloor(input, operations, {
      cause: verified.degradation.cause,
      loss: verified.degradation.loss,
      action: verified.degradation.action,
    });
  }

  return {
    capability: descriptor.name,
    state: "ready",
    floor: false,
    selection: verified.selection,
    degradations: [],
    operations,
    reason: null,
    action: null,
  };
}

function availability(
  descriptor: CapabilityDescriptor,
  binding: CapabilityBindingPolicy,
): OperationAvailability[] {
  return descriptor.operations.map((op) => operationState(op, binding));
}

function operationState(
  op: CapabilityOperation,
  binding: CapabilityBindingPolicy,
): OperationAvailability {
  if (binding.state === "off" && op.off === "blocked") {
    return {
      operation: op.name,
      available: false,
      // `off` is not reverted by a host, a wrapper or a legacy name; the only
      // way back is the binding itself.
      reason: "la capacidad está en off y esta operación queda bloqueada",
    };
  }
  return { operation: op.name, available: true, reason: null };
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
      degradations: [],
      operations,
      reason: null,
      action: null,
    };
  }
  // Feature-only with nothing installed. It blocks ITS operations — the flows
  // that never asked for it keep working, which is the whole isolation rule.
  return {
    capability: descriptor.name,
    state: "unavailable",
    floor: false,
    selection: [],
    degradations: [],
    operations: operations.map((o) => ({
      operation: o.operation,
      available: false,
      reason: `'${descriptor.name}' no tiene floor incorporado y no hay ninguna instancia conformante`,
    })),
    reason: `'${descriptor.name}' es una capacidad sin floor y no hay implementación instalada`,
    action: `instalá una skill conformante con '${descriptor.name}' o dejá de invocar esa feature`,
  };
}

interface DegradationSeed {
  cause: Degradation["cause"];
  loss: string;
  action: string | null;
}

/**
 * Fall back — but only where falling back is safe.
 *
 * With a built-in floor the run continues and the receipt carries the cause and
 * the loss. Without one there is nothing safe to fall to, so the resolution says
 * `misconfigured` instead of quietly producing a lesser result under the same
 * name.
 */
function degradeToFloor(
  input: ResolveCapabilityInput,
  operations: OperationAvailability[],
  seed: DegradationSeed,
): CapabilityResolution {
  const { descriptor } = input;
  const degradations: Degradation[] = [{ cause: seed.cause, loss: seed.loss }];
  const declared = descriptor.degradations.some((d) => d.cause === seed.cause);

  if (!descriptor.floor.builtin || !declared) {
    return {
      capability: descriptor.name,
      state: "misconfigured",
      floor: false,
      selection: [],
      degradations,
      operations: operations.map((o) => ({ ...o, available: false, reason: seed.loss })),
      reason: seed.loss,
      action: seed.action ?? `revisá la configuración de '${descriptor.name}'`,
    };
  }

  return {
    capability: descriptor.name,
    state: "degraded",
    floor: true,
    // Empty on purpose: the whole point of the degradation is that nothing
    // verifiable contributed, so nothing gets credit.
    selection: [],
    degradations,
    operations,
    reason: seed.loss,
    action: seed.action ?? "corré la operación con el floor o corregí la selección",
  };
}

interface VerifiedSelection {
  selection: SelectedInstance[];
  degradation: DegradationSeed | null;
}

function verifyContributors(
  input: ResolveCapabilityInput,
  contributors: HostContributor[],
): VerifiedSelection {
  const selection: SelectedInstance[] = [];
  const ordered = [...contributors].sort((a, b) => a.order - b.order);

  for (const contributor of ordered) {
    const installed = findInstalled(input.inventory, contributor.name);
    const problem = identify(input, contributor, installed);
    if (problem !== null) return { selection: [], degradation: problem };

    const instance = installed as InstalledCapability;
    const location =
      instance.locations.find((l) => l.skillDir === contributor.locator) ?? instance.locations[0];
    selection.push({
      name: instance.name,
      scope: location?.scope ?? "",
      locator: location?.skillDir ?? "",
      version: instance.version,
      digest: instance.digest as string,
      order: contributor.order,
    });
  }
  return { selection, degradation: null };
}

/** Everything that can stop a declared contributor from being a real one. */
function identify(
  input: ResolveCapabilityInput,
  contributor: HostContributor,
  installed: InstalledCapability | null,
): DegradationSeed | null {
  if (installed === null) {
    return {
      cause: "opaque_selection",
      loss: `el host declaró '${contributor.name}' y no hay ninguna instancia instalada con ese nombre`,
      action: "instalá la skill declarada, o quitala de la selección del host",
    };
  }
  if (installed.state === "misconfigured" || installed.digest === null) {
    return {
      cause: "opaque_selection",
      loss:
        installed.failure?.message ?? `'${contributor.name}' no identifica una instancia exacta`,
      action: installed.failure?.action ?? "dejá una sola instalación de ese nombre",
    };
  }
  // Equivalent replicas are the same BYTES, not the same install. A name-only
  // selection among several roots still cannot say which copy answered, and
  // picking the first would be exactly the silent precedence there must not be.
  const locators = installed.locations.map((l) => l.skillDir);
  if (locators.length > 1 && !locators.includes(contributor.locator ?? "")) {
    return {
      cause: "opaque_selection",
      loss: `'${contributor.name}' está instalada en ${locators.length} raíces y la selección no dice cuál contribuyó`,
      action: `declará el locator de la instancia (${locators.join(", ")}), o dejá una sola instalación`,
    };
  }
  if (contributor.digest != null && contributor.digest !== installed.digest) {
    return {
      cause: "digest_changed",
      loss: `'${contributor.name}' cambió de bytes entre la selección del host y el inventario`,
      action: "volvé a resolver la capacidad: la instancia dejó de ser la que se fijó",
    };
  }
  return compatible(input, contributor, installed);
}

/**
 * Installed is not compatible. The claim has to come from the improvement's own
 * descriptor and has to match the capability being resolved — the operation
 * included, because improving `render` says nothing about `create`.
 */
function compatible(
  input: ResolveCapabilityInput,
  contributor: HostContributor,
  installed: InstalledCapability,
): DegradationSeed | null {
  const improves = installed.descriptor?.compatibility.improves ?? null;
  const reject = (why: string): DegradationSeed => ({
    cause: "incompatible_improvement",
    loss: `'${contributor.name}' ${why}`,
    action: `corregí 'compatibility.improves' de '${contributor.name}', o sacala de la selección`,
  });

  if (improves === null) {
    return reject(`no declara mejorar a '${input.descriptor.name}'`);
  }
  if (improves.capability !== input.descriptor.name) {
    return reject(`declara mejorar a '${improves.capability}', no a '${input.descriptor.name}'`);
  }
  if (improves.contract_version !== input.descriptor.contract_version) {
    return reject(
      `habla la versión de contrato ${improves.contract_version} y esta capacidad es la ${input.descriptor.contract_version}`,
    );
  }
  const operation = input.operation ?? null;
  if (operation !== null && !improves.operations.includes(operation)) {
    return reject(`no declara mejorar la operación '${operation}'`);
  }
  return null;
}

/**
 * The pin: what was resolved, frozen for the whole invocation.
 *
 * A conversation spans several attempts, and between two of them a skill can be
 * updated, moved or removed. Without a pin the second attempt would silently run
 * against different bytes than the first while the receipt kept naming the
 * original — the exact "changing selection" the contract refuses to treat as an
 * improvement.
 */
export interface SelectionPin {
  capability: string;
  contract_version: number;
  floor: boolean;
  instances: Array<{ name: string; digest: string; order: number }>;
}

export function pinSelection(
  resolution: CapabilityResolution,
  descriptor: CapabilityDescriptor,
): SelectionPin {
  return {
    capability: resolution.capability,
    contract_version: descriptor.contract_version,
    floor: resolution.floor,
    instances: resolution.selection.map((s) => ({
      name: s.name,
      digest: s.digest,
      order: s.order,
    })),
  };
}

export type PinCheck = { ok: true } | { ok: false; degradation: Degradation; action: string };

export function checkPin(pin: SelectionPin, inventory: CapabilityInventory): PinCheck {
  for (const instance of pin.instances) {
    const installed = findInstalled(inventory, instance.name);
    if (installed?.digest === instance.digest) continue;
    return {
      ok: false,
      degradation: {
        cause: "digest_changed",
        loss: `'${instance.name}' ya no son los bytes que se fijaron al empezar la invocación`,
      },
      action: "volvé a empezar la invocación: la selección fijada dejó de existir tal cual",
    };
  }
  return { ok: true };
}
