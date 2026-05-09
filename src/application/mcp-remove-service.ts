import { homedir } from "node:os";
import { resolve } from "node:path";
import {
  type McpEntry,
  type McpHost,
  type McpInstance,
  type McpWriteOpts,
  type McpWriteResult,
  buildMcpEntry,
} from "../domain/mcp-entry.js";
import type { EnvPort } from "../ports/env.js";
import { McpWriterError, removeMcpEntry } from "./mcp-host-writer.js";

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
  errors: { host: McpHost; instance: McpInstance; target: string; message: string }[];
}

export interface McpRemoveRefusal {
  ok: false;
  error: string;
  hint: string;
  exitCode: 2;
}

export function runMcpRemove(
  env: EnvPort,
  input: McpRemoveInput,
): McpRemoveResult | McpRemoveRefusal {
  if (input.scope === "global" && !input.force && !input.dryRun) {
    return {
      ok: false,
      error: "global_requires_force",
      hint: "Tocar '~/.claude.json' o '~/.codex/config.toml' afecta TODOS los proyectos. Reintentá con --force o usá --dry-run para previsualizar.",
      exitCode: 2,
    };
  }

  const scopeDir = resolveScopeDir(env, input);
  const opts: McpWriteOpts = {
    dryRun: input.dryRun ?? false,
    force: input.force ?? false,
  };

  const removed: McpWriteResult[] = [];
  const skipped: McpWriteResult[] = [];
  const errors: McpRemoveResult["errors"] = [];

  for (const host of input.hosts) {
    for (const instance of input.instances) {
      removeOne(host, instance, scopeDir, input.scope, opts, removed, skipped, errors);
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

function removeOne(
  host: McpHost,
  instance: McpInstance,
  scopeDir: string,
  scope: "workspace" | "global",
  opts: McpWriteOpts,
  removed: McpWriteResult[],
  skipped: McpWriteResult[],
  errors: McpRemoveResult["errors"],
): void {
  const entry: McpEntry = buildMcpEntry(instance);
  try {
    const result = removeMcpEntry(host, entry, { scopeDir, kind: scope }, opts);
    if (result.action === "skipped-idempotent") {
      skipped.push(result);
    } else {
      removed.push(result);
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
): McpRemoveResult["errors"][number] {
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

function resolveScopeDir(env: EnvPort, input: McpRemoveInput): string {
  if (input.scope === "global") return homedir();
  if (input.workspace) return resolve(input.workspace);
  return resolve(env.cwd());
}
