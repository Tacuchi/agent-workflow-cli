import {
  type McpEntry,
  type McpHost,
  type McpInstance,
  type McpWriteOpts,
  type McpWriteResult,
  buildMcpEntry,
  normalizeMcpInstance,
} from "../domain/mcp-entry.js";
import type { EnvPort } from "../ports/env.js";
import { writeMcpEntry } from "./mcp-host-writer.js";
import {
  type McpErrorRecord,
  type McpScopeRefusal,
  buildGlobalRefusal,
  resolveScopeDir,
  toErrorRecord,
} from "./mcp-scope-common.js";

export interface McpSetupInput {
  hosts: McpHost[];
  instances: McpInstance[];
  scope: "workspace" | "global";
  workspace?: string;
  dryRun?: boolean;
  force?: boolean;
  dsnVars?: Record<string, string>;
}

export interface McpSetupResult {
  scope: "workspace" | "global";
  scope_dir: string;
  dry_run: boolean;
  applied: McpWriteResult[];
  skipped: McpWriteResult[];
  errors: McpErrorRecord[];
}

export function runMcpSetup(env: EnvPort, input: McpSetupInput): McpSetupResult | McpScopeRefusal {
  if (input.scope === "global" && !input.force && !input.dryRun) {
    return buildGlobalRefusal(input.hosts);
  }

  const scopeDir = resolveScopeDir(env, input);
  const opts: McpWriteOpts = {
    dryRun: input.dryRun ?? false,
    force: input.force ?? false,
  };

  const applied: McpWriteResult[] = [];
  const skipped: McpWriteResult[] = [];
  const errors: McpErrorRecord[] = [];

  for (const host of input.hosts) {
    for (const instance of input.instances) {
      const entry: McpEntry = buildMcpEntry(
        instance,
        input.dsnVars?.[normalizeMcpInstance(instance)],
      );
      try {
        const result = writeMcpEntry(host, entry, { scopeDir, kind: input.scope }, opts);
        if (result.action === "skipped-idempotent") {
          skipped.push(result);
        } else {
          applied.push(result);
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
    applied,
    skipped,
    errors,
  };
}
