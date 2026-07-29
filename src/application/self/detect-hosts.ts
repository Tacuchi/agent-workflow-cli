import type { CliContext } from "../../cli/types.js";
import type { CommandResult } from "../../domain/types.js";
import {
  type HostStateReport,
  type SharedDestinationReport,
  reportAllHostStates,
  reportSharedDestinations,
} from "./host-states.js";

export type { HostStateReport, SharedDestinationReport };

export interface SelfDetectHostsData {
  hosts: HostStateReport[];
  /** `~/.agents/skills` and friends: install destinations, never hosts. */
  shared_destinations: SharedDestinationReport[];
  /** Hosts actually present on this machine (runtime answers, or a CLI-less host has its config). */
  detected_count: number;
  /** Hosts with the Workline bundle installed. */
  installed_count: number;
  /** Hosts whose config dir survives with no runtime behind it. */
  residual_count: number;
  summary: string;
}

/**
 * Reports every host with its four observable states and the evidence for each.
 *
 * It answers with the catalog, not with guesses: it no longer counts the shared
 * `agents` dir as a host, no longer invents a `~/.oz` that no host ever creates,
 * and no longer depends on env markers — a host that exports none (Kimi Code) is
 * still detected through its binary and its config dir.
 */
export async function selfDetectHosts(
  ctx: CliContext,
): Promise<CommandResult<SelfDetectHostsData>> {
  const [hosts, sharedDestinations] = await Promise.all([
    reportAllHostStates(ctx),
    reportSharedDestinations(ctx),
  ]);

  const detectedCount = hosts.filter(
    (h) => h.status === "ready" || h.status === "installable",
  ).length;
  const installedCount = hosts.filter((h) => h.workline.installed).length;
  const residualCount = hosts.filter((h) => h.status === "residual-config").length;

  return {
    ok: true,
    data: {
      hosts,
      shared_destinations: sharedDestinations,
      detected_count: detectedCount,
      installed_count: installedCount,
      residual_count: residualCount,
      summary: buildSummary(hosts.length, detectedCount, installedCount, residualCount),
    },
    exitCode: 0,
  };
}

function buildSummary(
  total: number,
  detected: number,
  installed: number,
  residual: number,
): string {
  if (detected === 0) {
    const tail =
      residual > 0
        ? ` ${residual} config dir(s) left behind with no runtime — see each host's advice.`
        : "";
    return `No host runtime detected out of ${total} in the catalog.${tail} Shared skills dirs are listed apart and never count as hosts.`;
  }
  const tail = residual > 0 ? ` ${residual} with residual config only.` : "";
  return `${detected}/${total} hosts present; Workline installed in ${installed}.${tail} Shared skills dirs are listed apart and never count as hosts.`;
}
