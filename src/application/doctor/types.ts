import type { CliContext } from "../../cli/types.js";
import type {
  DoctorCategory,
  DoctorCoverage,
  DoctorFinding,
  DoctorHostView,
} from "../../domain/doctor/model.js";
/**
 * What a provider receives and what it owes back.
 *
 * A provider NEVER re-diagnoses: it calls the application function that already
 * knows how to look — `selfDoctor`, `reportAllHostStates`, `runMcpDoctor`,
 * `runHostDoctor`, `runVisibilityDoctor`, `capabilityReadiness` — and translates
 * its vocabulary into the common model. Keeping that rule in the contract is the
 * point: a second implementation of "is this MCP ours" is how two surfaces of
 * one CLI end up disagreeing about the same file.
 */
import type { HarnessId } from "../../domain/harnesses.js";
import type { HostStateReport } from "../self/host-states.js";

export interface DoctorTargetHost extends DoctorHostView {
  /** Whether this host takes MCP through a config file this CLI can read. */
  mcp_host: string | null;
}

export interface DoctorProviderInput {
  ctx: CliContext;
  /** Hosts that participate: `ready`, `installable` and `residual-config`. */
  hosts: readonly DoctorTargetHost[];
  /**
   * Every state the catalog reported, absent hosts included.
   *
   * Passed rather than re-read: `reportAllHostStates` probes each runtime with a
   * 2.5s ceiling, and a second pass would double the cost of the whole
   * diagnostic phase to learn what the run already knows.
   */
  hostStates: readonly HostStateReport[];
  /** The host the run was invoked from — highlighted, never a filter. */
  currentHost: HarnessId | null;
  workspaceDir: string;
  /** The native MCP inspection was declined: coverage says `skipped`, not `checked`. */
  skipNative: boolean;
}

export interface DoctorProviderOutput {
  coverage: DoctorCoverage[];
  findings: DoctorFinding[];
}

export interface DoctorProvider {
  category: DoctorCategory;
  run(input: DoctorProviderInput): Promise<DoctorProviderOutput>;
}

/** `checked` carries no reason; everything else must say why. */
export function coverage(
  category: DoctorCategory,
  host: string,
  state: DoctorCoverage["state"],
  reason: string | null = null,
): DoctorCoverage {
  return { category, host, state, reason };
}
