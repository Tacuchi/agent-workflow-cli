import {
  type McpConnectionRef,
  type McpEntry,
  type McpHost,
  type McpWriteOpts,
  type McpWriteResult,
  buildMcpEntry,
} from "../domain/mcp-entry.js";
import type { EnvPort } from "../ports/env.js";
import { classifyMcpEntry } from "./mcp-entry-classification.js";
import { readMcpEntry } from "./mcp-host-reader.js";
import { removeMcpEntry } from "./mcp-host-writer.js";
import {
  type McpErrorRecord,
  type McpScopeInput,
  type McpScopeRefusal,
  buildGlobalRefusal,
  resolveScopeDir,
  toErrorRecord,
} from "./mcp-scope-common.js";
import type { WorklineMaterialization } from "./workspace-materialization-service.js";

export type McpRemoveInput = McpScopeInput & {
  hosts: McpHost[];
  connections: McpConnectionRef[];
  namespace?: string;
  dryRun?: boolean;
  /** The narrow, observed action that authorizes a global host-config write. */
  globalApproval?: "explicit-cli-force" | "explicit-self-action";
};

export interface McpRemoveResult {
  scope: "workspace" | "global";
  scope_dir: string;
  dry_run: boolean;
  removed: McpWriteResult[];
  skipped: McpWriteResult[];
  /** Same-named entries with a different generated shape; nothing was removed. */
  conflicts: McpWriteResult[];
  errors: McpErrorRecord[];
  /** Successful descriptor removals that still require the host to reload. */
  reload_required?: McpRemovalReloadRequirement[];
  /** First-write receipt when the CLI materialized an implicit workspace for removal. */
  materialization?: WorklineMaterialization;
}

export interface McpRemovalReloadRequirement {
  host: McpHost;
  instance: string;
  reload_required: true;
  next_step: string;
}

interface RemoveBuckets {
  removed: McpWriteResult[];
  skipped: McpWriteResult[];
  conflicts: McpWriteResult[];
  errors: McpErrorRecord[];
}

export function runMcpRemove(
  env: EnvPort,
  input: McpRemoveInput,
): McpRemoveResult | McpScopeRefusal {
  if (input.scope === "global" && input.globalApproval === undefined && !input.dryRun) {
    return buildGlobalRefusal(input.hosts);
  }

  const scopeDir = resolveScopeDir(env, input);
  const opts: McpWriteOpts = {
    dryRun: input.dryRun ?? false,
  };

  const buckets: RemoveBuckets = { removed: [], skipped: [], conflicts: [], errors: [] };

  for (const host of input.hosts) {
    for (const connection of input.connections) {
      removeEntry(host, connection, input, scopeDir, opts, buckets);
    }
  }

  const reloadRequired = reloadRequirements(buckets.removed, input.connections);

  return {
    scope: input.scope,
    scope_dir: scopeDir,
    dry_run: Boolean(input.dryRun),
    ...buckets,
    ...(reloadRequired.length === 0 ? {} : { reload_required: reloadRequired }),
  };
}

function removeEntry(
  host: McpHost,
  connection: McpConnectionRef,
  input: McpRemoveInput,
  scopeDir: string,
  opts: McpWriteOpts,
  buckets: RemoveBuckets,
): void {
  const entry = removeEntryDescriptor(host, connection, input);
  try {
    const result = removeMcpEntry(
      host,
      entry,
      { scopeDir, kind: input.scope },
      removalOptions(host, entry, connection, scopeDir, input.scope, opts),
    );
    addRemoveWrite(result, buckets);
    reportRemovePartial(result, host, connection, buckets.errors);
  } catch (err) {
    buckets.errors.push(toErrorRecord(host, connection.name, scopeDir, err));
  }
}

/**
 * Retiring a published descriptor is safe only after its full stored shape was
 * classified as Workline-owned. The writer repeats the exact comparison when
 * it writes, so an external change between this read and the mutation remains
 * a conflict instead of becoming an overwrite.
 */
function removalOptions(
  host: McpHost,
  entry: McpEntry,
  connection: McpConnectionRef,
  scopeDir: string,
  scope: McpRemoveInput["scope"],
  opts: McpWriteOpts,
): McpWriteOpts {
  const snapshot = readMcpEntry(host, scopeDir, entry.name, scope);
  const classification = classifyMcpEntry(host, snapshot, entry, connection);
  if (classification.state !== "known-legacy" || classification.legacy === undefined) return opts;
  return { ...opts, replaceLegacy: classification.legacy };
}

function removeEntryDescriptor(
  host: McpHost,
  connection: McpConnectionRef,
  input: McpRemoveInput,
): McpEntry {
  return buildMcpEntry(connection.name, connection.dsnVar, {
    host,
    scope: input.scope,
    ...(input.namespace === undefined ? {} : { namespace: input.namespace }),
  });
}

function addRemoveWrite(result: McpWriteResult, buckets: RemoveBuckets): void {
  if (result.action === "conflict") buckets.conflicts.push(result);
  else if (result.action === "skipped-idempotent") buckets.skipped.push(result);
  else buckets.removed.push(result);
}

function reportRemovePartial(
  result: McpWriteResult,
  host: McpHost,
  connection: McpConnectionRef,
  errors: McpErrorRecord[],
): void {
  if (result.partial === undefined) return;
  errors.push({
    host,
    instance: connection.name,
    target: result.partial.target,
    message: result.partial.message,
  });
}

function reloadRequirements(
  writes: readonly McpWriteResult[],
  connections: readonly McpConnectionRef[],
): McpRemovalReloadRequirement[] {
  return writes.flatMap((write) => {
    if (write.action !== "removed" || write.partial !== undefined) return [];
    const connection = connections.find((candidate) => candidate.name === write.name);
    if (connection === undefined) return [];
    return [
      {
        host: write.host,
        instance: connection.name,
        reload_required: true as const,
        next_step: reloadInstruction(write.host),
      },
    ];
  });
}

function reloadInstruction(host: McpHost): string {
  switch (host) {
    case "claude":
      return "Abrí /mcp y elegí Reconnect, o iniciá una sesión nueva.";
    case "codex":
      return "Abrí /mcp y elegí Restart.";
    default:
      return "Recargá o reiniciá el host para retirar la tool de la sesión actual.";
  }
}
