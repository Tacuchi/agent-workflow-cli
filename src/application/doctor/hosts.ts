import type { CliContext } from "../../cli/types.js";
import { HARNESSES, type HarnessId } from "../../domain/harnesses.js";
/**
 * Which hosts the run looks at — read off the catalog's own state report.
 *
 * `absent` means no trace of the host on this machine, and the spec is explicit
 * that its absence is not a warning: it is enumerated so the report is honest
 * about what it did not look at, and nothing more. Turning it into a finding is
 * how a doctor teaches people to ignore it.
 */
import type { HostStateReport } from "../self/host-states.js";
import { reportAllHostStates } from "../self/host-states.js";
import type { DoctorTargetHost } from "./types.js";

/** Catalog order, and every consumer of the report sorts by it. */
export const DOCTOR_HOST_ORDER: readonly HarnessId[] = HARNESSES.map((spec) => spec.id);

export interface DoctorHostSelection {
  /** Hosts that participate, in catalog order. */
  hosts: DoctorTargetHost[];
  /** Hosts with no trace here, enumerated and not diagnosed. */
  absent: HarnessId[];
  /** Every state the catalog reported, kept for the providers that need more than the view. */
  states: HostStateReport[];
  /**
   * Los nombres de `--only` que el catálogo NO declara.
   *
   * Se devuelven en vez de descartarse porque un filtro escrito mal filtra a
   * cero y el informe saldría sano sin haber mirado el host que se pidió.
   * `claude` es la trampa natural: es el id que el resto de los comandos toma
   * (`aw mcp setup --host claude`), pero el catálogo de hosts lo llama
   * `claude-code`.
   */
  unknownOnly: string[];
}

const PARTICIPATING = new Set(["ready", "installable", "residual-config"]);

export async function selectDoctorHosts(
  ctx: CliContext,
  options: { currentHost: HarnessId | null; only: readonly string[] },
): Promise<DoctorHostSelection> {
  const states = await reportAllHostStates(ctx);
  const only = new Set(options.only);
  const ordered = [...states].sort(
    (left, right) => DOCTOR_HOST_ORDER.indexOf(left.host) - DOCTOR_HOST_ORDER.indexOf(right.host),
  );

  const known = new Set<string>(DOCTOR_HOST_ORDER);
  const unknownOnly = [...new Set(options.only)].filter((name) => !known.has(name));

  const hosts: DoctorTargetHost[] = [];
  const absent: HarnessId[] = [];
  for (const state of ordered) {
    // `--only` restricts; `--host` does not. Two flags because "which host am I
    // on" and "which hosts do I care about" are different questions, and folding
    // them made the invoking host silently hide every other one.
    if (only.size > 0 && !only.has(state.host)) continue;
    if (!PARTICIPATING.has(state.status)) {
      absent.push(state.host);
      continue;
    }
    hosts.push(viewOf(state, options.currentHost));
  }
  return { hosts, absent, states: ordered, unknownOnly };
}

function viewOf(state: HostStateReport, currentHost: HarnessId | null): DoctorTargetHost {
  const spec = HARNESSES.find((candidate) => candidate.id === state.host);
  return {
    host: state.host,
    target: state.target,
    label: state.label,
    status: state.status,
    current: state.host === currentHost,
    runtime: { state: state.runtime.state, version: state.runtime.version },
    workline_installed: state.workline.installed,
    mcp_host: spec?.mcpHostId ?? null,
  };
}
