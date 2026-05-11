import { homedir } from "node:os";
import { resolve } from "node:path";
import { HARNESSES } from "../domain/harnesses.js";
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
import { McpWriterError, writeMcpEntry } from "./mcp-host-writer.js";

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
  errors: { host: McpHost; instance: McpInstance; target: string; message: string }[];
}

export interface McpSetupRefusal {
  ok: false;
  error: string;
  hint: string;
  exitCode: 2;
}

export function runMcpSetup(env: EnvPort, input: McpSetupInput): McpSetupResult | McpSetupRefusal {
  if (input.scope === "global" && !input.force && !input.dryRun) {
    return {
      ok: false,
      error: "global_requires_force",
      hint: buildGlobalHint(input.hosts),
      exitCode: 2,
    };
  }

  const scopeDir = resolveScopeDir(env, input);
  const opts: McpWriteOpts = {
    dryRun: input.dryRun ?? false,
    force: input.force ?? false,
  };

  const applied: McpWriteResult[] = [];
  const skipped: McpWriteResult[] = [];
  const errors: McpSetupResult["errors"] = [];

  for (const host of input.hosts) {
    for (const instance of input.instances) {
      applyOne(
        host,
        instance,
        scopeDir,
        input.scope,
        opts,
        input.dsnVars,
        applied,
        skipped,
        errors,
      );
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

function applyOne(
  host: McpHost,
  instance: McpInstance,
  scopeDir: string,
  scope: "workspace" | "global",
  opts: McpWriteOpts,
  dsnVars: Record<string, string> | undefined,
  applied: McpWriteResult[],
  skipped: McpWriteResult[],
  errors: McpSetupResult["errors"],
): void {
  const entry: McpEntry = buildMcpEntry(instance, dsnVars?.[normalizeMcpInstance(instance)]);
  try {
    const result = writeMcpEntry(host, entry, { scopeDir, kind: scope }, opts);
    if (result.action === "skipped-idempotent") {
      skipped.push(result);
    } else {
      applied.push(result);
    }
  } catch (err) {
    errors.push(toErrorRecord(host, instance, scopeDir, err));
  }
}

function toErrorRecord(
  host: McpHost,
  instance: McpInstance,
  scopeDir: string,
  err: unknown,
): McpSetupResult["errors"][number] {
  if (err instanceof McpWriterError) {
    return {
      host,
      instance,
      target: err.target,
      message: `${err.message}${err.cause ? ` (${err.cause})` : ""}`,
    };
  }
  return { host, instance, target: scopeDir, message: (err as Error).message };
}

function resolveScopeDir(env: EnvPort, input: McpSetupInput): string {
  if (input.scope === "global") return homedir();
  if (input.workspace) return resolve(input.workspace);
  return resolve(env.cwd());
}

function buildGlobalHint(hosts: McpHost[]): string {
  const paths = HARNESSES.filter((h) => hosts.includes(h.mcpHostId as McpHost))
    .map((h) => h.globalMcpPaths?.darwin.stable)
    .filter((p): p is string => p !== undefined);
  const files = paths.length > 0 ? paths.join(", ") : "archivos de config globales";
  return `Tocar ${files} afecta TODOS los proyectos. Reintentá con --force o usá --dry-run para previsualizar.`;
}
