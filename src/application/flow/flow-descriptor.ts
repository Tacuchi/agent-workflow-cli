import { CORRELATIVE_SOURCE } from "../../domain/correlative.js";
import { WORKLINE_FLOWS, type WorklineFlow } from "../capability/compose.js";

/**
 * A session name without its leading correlative: `028-x-plan-exec` → `x-plan-exec`.
 *
 * Shared by the folder claim and the input derivation because both read the same
 * descriptor: if only one of them normalized, a `--name 028-x-plan-exec` would
 * land in folder `007-x-plan-exec` while its document was looked up under the
 * slug `028-x`.
 */
export function sessionDescriptor(name: string): string {
  return name.replace(new RegExp(`^${CORRELATIVE_SOURCE}-`), "");
}

/**
 * The flow a descriptor names — `<slug>-<flow>` — or null for any other name.
 *
 * Reading it here is not inference: the doctrine tells every flow to open its
 * session with exactly that descriptor, so the name IS the declaration. Longest
 * suffix first, so `-plan-exec` is never read as some shorter flow.
 */
export function flowOfDescriptor(name: string): WorklineFlow | null {
  const descriptor = sessionDescriptor(name);
  const flows = [...WORKLINE_FLOWS].sort((a, b) => b.length - a.length);
  const flow = flows.find((candidate) => descriptor.endsWith(`-${candidate}`));
  return flow !== undefined && descriptor.length > flow.length + 1 ? flow : null;
}

/**
 * The exact command that adopts a session's run: its flow comes from its name.
 * A session whose name declares no flow keeps the placeholder, because which
 * flow it runs is not the CLI's to guess.
 */
export function adoptionCommand(session: string): string {
  const flow = flowOfDescriptor(session) ?? "<flow>";
  return `aw flow advance --session ${session} --flow ${flow} --adopt`;
}
