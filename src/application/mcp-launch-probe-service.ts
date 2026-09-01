import { DATABASE_TOOL_DESCRIPTORS } from "../domain/database-tools.js";
import type { McpHost } from "../domain/mcp-entry.js";
import { classifyMcpEntry } from "./mcp-entry-classification.js";
import { readMcpEntry } from "./mcp-host-reader.js";
import { digestMcpReceiptDescriptor } from "./mcp-host-receipt-service.js";
import { openMcpHostReceiptService } from "./mcp-host-receipts.js";
import type { McpReceiptProbeTarget } from "./mcp-receipt-registration-service.js";
import type { McpErrorRecord } from "./mcp-scope-common.js";
import type { McpSetupResult } from "./mcp-setup-service.js";
import { runMcpStdioProbe } from "./mcp-stdio-probe.js";
import type { PathsService } from "./paths-service.js";

export interface McpLaunchProbeRecord {
  host: McpHost;
  instance: string;
  outcome: "passed" | "failed";
  phase: "spawn" | "initialize" | "initialized" | "tools/list" | "tools/call";
  code?: string;
}

export interface McpLaunchProbeBatch {
  probes: McpLaunchProbeRecord[];
  errors: McpErrorRecord[];
}

/**
 * Executes the descriptor read back from disk after a successful install. It
 * deliberately proves only launchability (initialize → initialized → tools/list),
 * never a live database connection or a host reload.
 */
export async function probePersistedMcpSetupEntries(
  paths: PathsService,
  result: McpSetupResult,
  additionalTargets: readonly McpReceiptProbeTarget[] = [],
): Promise<McpLaunchProbeBatch> {
  const probes: McpLaunchProbeRecord[] = [];
  const errors: McpErrorRecord[] = [];
  // Only global descriptors have the absolute command/entrypoint guarantee
  // that this lifecycle probe proves. Workspace descriptors are deliberately
  // portable and PATH-dependent, so their doctor state remains actionable.
  if (result.dry_run || result.scope !== "global") return { probes, errors };
  const receipts = openMcpHostReceiptService(paths);

  const targets = dedupeProbeTargets(additionalTargets);

  for (const target of targets) {
    const snapshot = readProbeSnapshot(target, result.scope_dir, result.scope);
    if (snapshot === undefined || !isCurrentProbeDescriptor(target, snapshot)) {
      probes.push({
        host: target.host,
        instance: target.instance,
        outcome: "failed",
        phase: "spawn",
        code: "DESCRIPTOR_READBACK_MISMATCH",
      });
      errors.push(probeError(target.host, target.instance, target.target));
      continue;
    }
    const receipt = await receipts.find({
      host: target.host,
      scope: result.scope,
      connection: target.instance,
    });
    let descriptorDigest: string | undefined;
    try {
      descriptorDigest = digestMcpReceiptDescriptor({
        command: snapshot.command,
        args: snapshot.args,
      });
    } catch {
      descriptorDigest = undefined;
    }
    if (descriptorDigest === undefined || receipt?.descriptor_digest !== descriptorDigest) {
      probes.push({
        host: target.host,
        instance: target.instance,
        outcome: "failed",
        phase: "spawn",
        code: "DESCRIPTOR_READBACK_MISMATCH",
      });
      errors.push(probeError(target.host, target.instance, target.target));
      continue;
    }
    const probe = await runMcpStdioProbe({
      descriptor: {
        command: snapshot.command,
        args: snapshot.args,
        ...(snapshot.env === undefined ? {} : { env: snapshot.env }),
      },
      mode: "launch",
      expectedTools: DATABASE_TOOL_DESCRIPTORS,
    });
    if (!probe.ok) {
      probes.push({
        host: target.host,
        instance: target.instance,
        outcome: "failed",
        phase: probe.phase,
        code: probe.code,
      });
      errors.push(probeError(target.host, target.instance, target.target));
      await recordProbe(
        receipts,
        result.scope_dir,
        result.scope,
        target,
        descriptorDigest,
        "failed",
        probe.phase,
      );
      continue;
    }
    probes.push({
      host: target.host,
      instance: target.instance,
      outcome: "passed",
      phase: "tools/list",
    });
    await recordProbe(
      receipts,
      result.scope_dir,
      result.scope,
      target,
      descriptorDigest,
      "passed",
      "tools/list",
    );
  }
  return { probes, errors };
}

function readProbeSnapshot(
  target: McpReceiptProbeTarget,
  scopeDir: string,
  scope: "workspace" | "global",
): ReturnType<typeof readMcpEntry> | undefined {
  try {
    return readMcpEntry(target.host, scopeDir, target.instance, scope);
  } catch {
    return undefined;
  }
}

function isCurrentProbeDescriptor(
  target: McpReceiptProbeTarget,
  snapshot: ReturnType<typeof readMcpEntry>,
): snapshot is ReturnType<typeof readMcpEntry> & { command: string; args: string[] } {
  if (target.entry === undefined || snapshot.command === undefined || snapshot.args === undefined) {
    return false;
  }
  // The DSN variable is irrelevant when the entry is current; it is only used
  // to recognize an old DBHub shape, which is deliberately not launchable.
  return (
    classifyMcpEntry(target.host, snapshot, target.entry, {
      name: target.instance,
      dsnVar: "",
    }).state === "current"
  );
}

function dedupeProbeTargets(targets: readonly McpReceiptProbeTarget[]): McpReceiptProbeTarget[] {
  const byIdentity = new Map<string, McpReceiptProbeTarget>();
  for (const target of targets) {
    byIdentity.set(`${target.host}:${target.instance}`, target);
  }
  return [...byIdentity.values()];
}

async function recordProbe(
  receipts: ReturnType<typeof openMcpHostReceiptService>,
  scopeDir: string,
  scope: "workspace" | "global",
  target: McpReceiptProbeTarget,
  descriptorDigest: string,
  outcome: "passed" | "failed",
  phase: McpLaunchProbeRecord["phase"],
): Promise<void> {
  try {
    const snapshot = readMcpEntry(target.host, scopeDir, target.instance, scope);
    if (!isCurrentProbeDescriptor(target, snapshot)) return;
    const identity = { host: target.host, scope, connection: target.instance };
    const receipt = await receipts.find(identity);
    if (receipt?.descriptor_digest !== descriptorDigest) return;
    await receipts.recordLaunchProbe({ ...identity, descriptorDigest, outcome, phase });
  } catch {
    // The config write remains truthful; doctor can re-run the probe if receipt
    // persistence was busy. Never expose child stderr or descriptor details.
  }
}

function probeError(host: McpHost, instance: string, target: string): McpErrorRecord {
  return {
    host,
    instance,
    target,
    message: "El descriptor MCP se escribió, pero no completó initialize → tools/list.",
  };
}
