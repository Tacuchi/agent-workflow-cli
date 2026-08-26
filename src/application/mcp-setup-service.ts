import {
  type McpConnectionRef,
  type McpEntry,
  type McpHost,
  type McpWriteOpts,
  type McpWriteResult,
  buildMcpEntry,
} from "../domain/mcp-entry.js";
import type { EnvPort } from "../ports/env.js";
import { writeMcpEntry } from "./mcp-host-writer.js";
import {
  type McpErrorRecord,
  type McpScopeInput,
  type McpScopeRefusal,
  buildGlobalRefusal,
  resolveScopeDir,
  toErrorRecord,
} from "./mcp-scope-common.js";
import type { WorklineMaterialization } from "./workspace-materialization-service.js";

export type McpSetupInput = McpScopeInput & {
  hosts: McpHost[];
  connections: McpConnectionRef[];
  dryRun?: boolean;
  /** The narrow, observed action that authorizes a global host-config write. */
  globalApproval?: "explicit-cli-force" | "explicit-self-action";
};

export interface McpSetupResult {
  scope: "workspace" | "global";
  scope_dir: string;
  dry_run: boolean;
  applied: McpWriteResult[];
  skipped: McpWriteResult[];
  /** Same-named entries with a different generated shape; nothing was written. */
  conflicts: McpWriteResult[];
  errors: McpErrorRecord[];
  /** First-write receipt when the CLI materialized an implicit workspace for setup. */
  materialization?: WorklineMaterialization;
}

export function runMcpSetup(env: EnvPort, input: McpSetupInput): McpSetupResult | McpScopeRefusal {
  if (input.scope === "global" && input.globalApproval === undefined && !input.dryRun) {
    return buildGlobalRefusal(input.hosts);
  }

  const scopeDir = resolveScopeDir(env, input);
  const opts: McpWriteOpts = {
    dryRun: input.dryRun ?? false,
  };

  const applied: McpWriteResult[] = [];
  const skipped: McpWriteResult[] = [];
  const conflicts: McpWriteResult[] = [];
  const errors: McpErrorRecord[] = [];

  for (const host of input.hosts) {
    for (const connection of input.connections) {
      const entry: McpEntry = buildMcpEntry(connection.name, connection.dsnVar);
      try {
        const result = writeMcpEntry(host, entry, { scopeDir, kind: input.scope }, opts);
        if (result.action === "conflict") {
          conflicts.push(result);
        } else if (result.action === "skipped-idempotent") {
          skipped.push(result);
        } else {
          applied.push(result);
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
    applied,
    skipped,
    conflicts,
    errors,
  };
}
