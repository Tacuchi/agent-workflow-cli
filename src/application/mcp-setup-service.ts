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
  namespace?: string;
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
  /** Secret-free descriptor receipts registered after successful host writes. */
  receipts?: Array<{
    host: string;
    instance: string;
    descriptor_digest: string;
    reload_required: true;
  }>;
  /** Launchability evidence from the exact persisted descriptor. */
  launch_probes?: Array<{
    host: McpHost;
    instance: string;
    outcome: "passed" | "failed";
    phase: "spawn" | "initialize" | "initialized" | "tools/list" | "tools/call";
    code?: string;
  }>;
  /** Native host CLI visibility checks for Claude and Codex after global setup. */
  native_checks?: Array<{
    host: "claude" | "codex";
    instance: string;
    outcome: "passed" | "failed";
    code?: "HOST_BINARY_MISSING" | "HOST_NATIVE_CHECK_FAILED" | "HOST_ENTRY_NOT_VISIBLE";
  }>;
  /** First-write receipt when the CLI materialized an implicit workspace for setup. */
  materialization?: WorklineMaterialization;
}

interface SetupBuckets {
  applied: McpWriteResult[];
  skipped: McpWriteResult[];
  conflicts: McpWriteResult[];
  errors: McpErrorRecord[];
}

export function runMcpSetup(env: EnvPort, input: McpSetupInput): McpSetupResult | McpScopeRefusal {
  if (input.scope === "global" && input.globalApproval === undefined && !input.dryRun) {
    return buildGlobalRefusal(input.hosts);
  }

  const scopeDir = resolveScopeDir(env, input);
  const opts: McpWriteOpts = {
    dryRun: input.dryRun ?? false,
  };

  const buckets: SetupBuckets = { applied: [], skipped: [], conflicts: [], errors: [] };

  for (const host of input.hosts) {
    for (const connection of input.connections) {
      applySetupEntry(host, connection, input, scopeDir, opts, buckets);
    }
  }

  return {
    scope: input.scope,
    scope_dir: scopeDir,
    dry_run: Boolean(input.dryRun),
    ...buckets,
  };
}

function applySetupEntry(
  host: McpHost,
  connection: McpConnectionRef,
  input: McpSetupInput,
  scopeDir: string,
  opts: McpWriteOpts,
  buckets: SetupBuckets,
): void {
  const entry = setupEntry(host, connection, input);
  try {
    const result = writeMcpEntry(host, entry, { scopeDir, kind: input.scope }, opts);
    addSetupWrite(result, buckets);
    reportSetupWriteIssue(result, host, connection, entry, scopeDir, input.scope, buckets.errors);
  } catch (err) {
    buckets.errors.push(toErrorRecord(host, connection.name, scopeDir, err));
  }
}

function setupEntry(host: McpHost, connection: McpConnectionRef, input: McpSetupInput): McpEntry {
  return buildMcpEntry(connection.name, connection.dsnVar, {
    host,
    scope: input.scope,
    ...(input.namespace === undefined ? {} : { namespace: input.namespace }),
  });
}

function addSetupWrite(result: McpWriteResult, buckets: SetupBuckets): void {
  if (result.action === "conflict") buckets.conflicts.push(result);
  else if (result.action === "skipped-idempotent") buckets.skipped.push(result);
  else buckets.applied.push(result);
}

function reportSetupWriteIssue(
  result: McpWriteResult,
  host: McpHost,
  connection: McpConnectionRef,
  entry: McpEntry,
  scopeDir: string,
  scope: McpSetupInput["scope"],
  errors: McpErrorRecord[],
): void {
  if (result.partial !== undefined) {
    errors.push({
      host,
      instance: connection.name,
      target: result.partial.target,
      message: result.partial.message,
    });
    return;
  }
  if (result.action !== "written" || readBackMatches(host, entry, scopeDir, scope, connection))
    return;
  errors.push({
    host,
    instance: connection.name,
    target: result.target,
    message: "La entrada MCP escrita no coincidió al leerla de vuelta; no recargues el host.",
  });
}

function readBackMatches(
  host: McpHost,
  entry: McpEntry,
  scopeDir: string,
  scope: McpSetupInput["scope"],
  connection: McpConnectionRef,
): boolean {
  try {
    const snapshot = readMcpEntry(host, scopeDir, entry.name, scope);
    return classifyMcpEntry(host, snapshot, entry, connection).state === "current";
  } catch {
    return false;
  }
}
