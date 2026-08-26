import {
  type McpConnectionRef,
  type McpEntry,
  type McpHost,
  type McpWriteOpts,
  type McpWriteResult,
  buildMcpEntry,
} from "../domain/mcp-entry.js";
import type { EnvPort } from "../ports/env.js";
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
  /** First-write receipt when the CLI materialized an implicit workspace for removal. */
  materialization?: WorklineMaterialization;
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

  const removed: McpWriteResult[] = [];
  const skipped: McpWriteResult[] = [];
  const conflicts: McpWriteResult[] = [];
  const errors: McpErrorRecord[] = [];

  for (const host of input.hosts) {
    for (const connection of input.connections) {
      const entry: McpEntry = buildMcpEntry(connection.name, connection.dsnVar);
      try {
        const result = removeMcpEntry(host, entry, { scopeDir, kind: input.scope }, opts);
        if (result.action === "conflict") {
          conflicts.push(result);
        } else if (result.action === "skipped-idempotent") {
          skipped.push(result);
        } else {
          removed.push(result);
        }
      } catch (err) {
        errors.push(toErrorRecord(host, connection.name, scopeDir, err));
      }
    }
  }

  return {
    scope: input.scope,
    scope_dir: scopeDir,
    dry_run: Boolean(input.dryRun),
    removed,
    skipped,
    conflicts,
    errors,
  };
}
