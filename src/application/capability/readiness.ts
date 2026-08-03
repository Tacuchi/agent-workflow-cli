/**
 * What can be invoked here, in what state, and what to do about it.
 *
 * The check this replaces compared names and emitted advice. Readiness answers
 * the question a person actually has — "can I use this right now, and if not,
 * why?" — and every state carries its evidence and one next action, because a
 * status with neither is a puzzle rather than a diagnosis.
 *
 * Two things are deliberately kept apart:
 *
 * - **Per exposure.** The direct entrypoint and the composed route fail
 *   independently. A foreign skill squatting the wrapper's name breaks `direct`
 *   and leaves `compose` running on the floor; collapsing them into one state
 *   would hide half of that.
 * - **Per operation.** `off` blocks four operations of `design` and keeps
 *   `validate` alive. One state for the capability cannot express that.
 *
 * The invocation form is read from `HARNESSES` and never inferred. A host with
 * no verified form says so instead of borrowing another host's syntax.
 */

import { join } from "node:path";
import type {
  CapabilityDescriptor,
  CapabilityExposure,
} from "../../domain/capability/descriptor.js";
import { HARNESSES, type HarnessInvocation } from "../../domain/harnesses.js";
import { classifyCapabilityBinding } from "../../domain/skills.js";
import type { EnvPort } from "../../ports/env.js";
import type { FileSystemPort } from "../../ports/file-system.js";
import type { PathsService } from "../paths-service.js";
import { resolveSkills } from "../skills-resolver-service.js";
import { capabilityHandler, registeredCapabilities } from "./dispatcher.js";
import { buildCapabilityInventory } from "./installed-inventory.js";
import type { CapabilityInventory } from "./installed-inventory.js";
import { type CapabilityReadiness as ResolutionState, resolveCapability } from "./resolution.js";
import { inspectCapabilityDirVia } from "./wrapper.js";

export type ReadinessState = ResolutionState;

export interface ReadinessVerdict {
  state: ReadinessState;
  /** The observable behind the state. Never a restatement of the state itself. */
  reason: string | null;
  action: string | null;
}

export interface OperationReadiness extends ReadinessVerdict {
  operation: string;
  exposure: readonly CapabilityExposure[];
  workspace: string;
  effects: string[];
}

export interface ExactInstance {
  name: string;
  scope: string;
  locator: string;
  version: string | null;
  digest: string;
}

export interface EligibleImprovement {
  name: string;
  digest: string | null;
  improves: string | null;
  eligible: boolean;
  why: string | null;
}

export interface InvocationProjection {
  host: string;
  kind: HarnessInvocation["kind"] | "unavailable";
  /** The literal form, with `<name>` already substituted. Null when unavailable. */
  form: string | null;
  note: string;
}

export interface CapabilityReadinessReport extends ReadinessVerdict {
  capability: string;
  contract_version: number;
  purpose: string;
  exposure: readonly CapabilityExposure[];
  floor: { builtin: boolean; kind: string; running: boolean };
  /** The exact instance an improvement contributed, or null when the floor ran. */
  instance: ExactInstance | null;
  invocation: InvocationProjection;
  exposures: Record<CapabilityExposure, ReadinessVerdict>;
  operations: OperationReadiness[];
  improvements: EligibleImprovement[];
}

export interface ReadinessInput {
  fs: FileSystemPort;
  env: EnvPort;
  paths: PathsService;
  /** Host id, as detected. Decides which invocation form is real here. */
  host: string;
}

export async function capabilityReadiness(
  input: ReadinessInput,
): Promise<CapabilityReadinessReport[]> {
  const skills = await resolveSkills(input.fs, input.paths);
  const inventory = await buildCapabilityInventory(input.fs, input.env);
  const reports: CapabilityReadinessReport[] = [];

  for (const name of registeredCapabilities()) {
    const handler = capabilityHandler(name);
    if (handler === null) continue;
    const slot = skills.skills[name as keyof typeof skills.skills];
    const binding =
      slot === undefined
        ? { state: "floor_and_improvements" as const, reason: null, action: null }
        : classifyCapabilityBinding(slot, name);
    const resolution = resolveCapability({ descriptor: handler.descriptor, binding, inventory });
    reports.push(
      await reportFor(input, handler.descriptor, resolution, inventory, {
        state: resolution.state,
        reason: resolution.reason,
        action: resolution.action,
      }),
    );
  }
  return reports;
}

async function reportFor(
  input: ReadinessInput,
  descriptor: CapabilityDescriptor,
  resolution: ReturnType<typeof resolveCapability>,
  inventory: CapabilityInventory,
  verdict: ReadinessVerdict,
): Promise<CapabilityReadinessReport> {
  const direct = await directVerdict(input, descriptor, verdict);
  return {
    capability: descriptor.name,
    contract_version: descriptor.contract_version,
    purpose: descriptor.purpose,
    exposure: descriptor.exposure,
    ...verdict,
    floor: {
      builtin: descriptor.floor.builtin,
      kind: descriptor.floor.kind,
      running: resolution.floor,
    },
    instance:
      resolution.selection[0] === undefined
        ? null
        : {
            name: resolution.selection[0].name,
            scope: resolution.selection[0].scope,
            locator: resolution.selection[0].locator,
            version: resolution.selection[0].version,
            digest: resolution.selection[0].digest,
          },
    invocation: invocationFor(input.host, descriptor.name),
    exposures: {
      direct: descriptor.exposure.includes("direct")
        ? direct
        : { state: "unavailable", reason: "la capacidad no expone la ruta directa", action: null },
      compose: descriptor.exposure.includes("compose")
        ? verdict
        : {
            state: "unavailable",
            reason: "la capacidad no expone la ruta compuesta",
            action: null,
          },
    },
    operations: descriptor.operations.map((op) => {
      const availability = resolution.operations.find((o) => o.operation === op.name);
      const blocked = availability !== undefined && !availability.available;
      return {
        operation: op.name,
        exposure: op.exposure,
        workspace: op.workspace,
        effects: op.effects.map((e) => e.class),
        // The capability being `disabled` does NOT make the operation `off`
        // spared disabled too: saying so would erase exactly the consumption
        // `off` is required to preserve.
        state: blocked ? ("disabled" as const) : availableState(verdict, resolution.floor),
        reason: blocked ? availability.reason : verdict.reason,
        action: blocked ? (resolution.action ?? null) : verdict.action,
      };
    }),
    improvements: inventory.capabilities
      .filter((c) => c.name !== descriptor.name)
      .map((c) => eligibility(c, descriptor)),
  };
}

/**
 * The direct route lives or dies by a real directory on disk.
 *
 * A capability can be perfectly resolved and still be unreachable directly
 * because nobody installed the wrapper — or because someone else's skill holds
 * the name. Both are states of the ENTRYPOINT, not of the capability, so they
 * are reported here and nowhere else.
 */
async function directVerdict(
  input: ReadinessInput,
  descriptor: CapabilityDescriptor,
  verdict: ReadinessVerdict,
): Promise<ReadinessVerdict> {
  const harness = HARNESSES.find((h) => h.id === input.host);
  if (harness === undefined || harness.invocation === null) {
    return {
      state: "unavailable",
      reason: `no hay una forma de invocación verificada para el host '${input.host}'`,
      action: "usá la ruta compuesta desde un flow, o instalá en un host soportado",
    };
  }
  const root = join(input.env.homeDir(), ...(harness.skillsDirs[0]?.split("/") ?? []));
  const ownership = await inspectCapabilityDirVia(input.fs, join(root, descriptor.name));
  if (ownership.state === "foreign") {
    return {
      state: "misconfigured",
      reason: ownership.why,
      action: `renombrá o quitá esa skill y reinstalá con 'aw self install-skill'`,
    };
  }
  if (ownership.state === "absent") {
    return {
      state: "unavailable",
      reason: `no hay un wrapper '${descriptor.name}' instalado en ${root}`,
      action: "instalalo con 'aw self install-skill'",
    };
  }
  return verdict;
}

/** What an AVAILABLE operation's state is when the capability itself is off. */
function availableState(verdict: ReadinessVerdict, floorRunning: boolean): ReadinessState {
  if (verdict.state !== "disabled") return verdict.state;
  return floorRunning ? "ready" : "unavailable";
}

function invocationFor(host: string, name: string): InvocationProjection {
  const harness = HARNESSES.find((h) => h.id === host);
  const invocation = harness?.invocation ?? null;
  if (invocation === null) {
    return {
      host,
      kind: "unavailable",
      form: null,
      // Saying "unavailable" is the honest answer. Printing another host's
      // syntax would send a person to type something that does nothing.
      note: `no hay una forma de invocación verificada para '${host}'`,
    };
  }
  return {
    host,
    kind: invocation.kind,
    form: invocation.template.replace("<name>", name),
    note: invocation.note,
  };
}

function eligibility(
  installed: CapabilityInventory["capabilities"][number],
  descriptor: CapabilityDescriptor,
): EligibleImprovement {
  const improves = installed.descriptor?.compatibility.improves ?? null;
  if (installed.state === "misconfigured") {
    return {
      name: installed.name,
      digest: null,
      improves: null,
      eligible: false,
      why: installed.failure?.message ?? "instancia no identificable",
    };
  }
  if (improves === null || improves.capability !== descriptor.name) {
    return {
      name: installed.name,
      digest: installed.digest,
      improves: improves?.capability ?? null,
      eligible: false,
      why: `no declara mejorar '${descriptor.name}'`,
    };
  }
  if (improves.contract_version !== descriptor.contract_version) {
    return {
      name: installed.name,
      digest: installed.digest,
      improves: improves.capability,
      eligible: false,
      why: `habla la versión de contrato ${improves.contract_version}`,
    };
  }
  return {
    name: installed.name,
    digest: installed.digest,
    improves: improves.capability,
    eligible: true,
    why: null,
  };
}
