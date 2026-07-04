import {
  type McpEntry,
  type McpHost,
  type McpInstance,
  type McpWriteOpts,
  type McpWriteResult,
  buildMcpEntry,
} from "../domain/mcp-entry.js";
import type { EnvPort } from "../ports/env.js";
import { removeMcpEntry } from "./mcp-host-writer.js";
import {
  type McpErrorRecord,
  type McpScopeRefusal,
  buildGlobalRefusal,
  resolveScopeDir,
  toErrorRecord,
} from "./mcp-scope-common.js";

export interface McpRemoveInput {
  hosts: McpHost[];
  instances: McpInstance[];
  scope: "workspace" | "global";
  workspace?: string;
  dryRun?: boolean;
  force?: boolean;
}

export interface McpRemoveResult {
  scope: "workspace" | "global";
  scope_dir: string;
  dry_run: boolean;
  removed: McpWriteResult[];
  skipped: McpWriteResult[];
  errors: McpErrorRecord[];
}

export function runMcpRemove(
  env: EnvPort,
  input: McpRemoveInput,
): McpRemoveResult | McpScopeRefusal {
  if (input.scope === "global" && !input.force && !input.dryRun) {
    return buildGlobalRefusal(input.hosts);
  }

  const scopeDir = resolveScopeDir(env, input);
  const opts: McpWriteOpts = {
    dryRun: input.dryRun ?? false,
    force: input.force ?? false,
  };

  const removed: McpWriteResult[] = [];
  const skipped: McpWriteResult[] = [];
  const errors: McpErrorRecord[] = [];

  for (const host of input.hosts) {
    for (const instance of input.instances) {
      const entry: McpEntry = buildMcpEntry(instance);
      try {
        const result = removeMcpEntry(host, entry, { scopeDir, kind: input.scope }, opts);
        if (result.action === "skipped-idempotent") {
          skipped.push(result);
        } else {
          removed.push(result);
        }
      } catch (err) {
        errors.push(toErrorRecord(host, instance, scopeDir, err));
      }
    }
  }

  return {
    scope: input.scope,
    scope_dir: scopeDir,
    dry_run: Boolean(input.dryRun),
    removed,
    skipped,
    errors,
  };
}
