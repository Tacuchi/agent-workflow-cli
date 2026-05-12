import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { runHarness } from "../../application/dev-only-services.js";
import { DbhubLauncherError, runDbhubLauncher } from "../../application/mcp-dbhub-launcher.js";
import { runMcpDoctor } from "../../application/mcp-doctor-service.js";
import { runMcpRemove } from "../../application/mcp-remove-service.js";
import { runMcpSetup } from "../../application/mcp-setup-service.js";
import {
  type WarpPostInstallHint,
  buildWarpPostInstallHint,
  formatWarpPostInstallHint,
} from "../../application/mcp-warp-postinstall-hint.js";
import {
  resolveWarpGlobalMcpPath,
  resolveWarpProjectMcpPath,
} from "../../application/multiroot/warp.js";
import { HARNESSES } from "../../domain/harnesses.js";
import {
  DEFAULT_MCP_INSTANCES,
  type McpHost,
  type McpInstance,
  mcpEntryNameFor,
  validateDsnVarName,
  validateMcpInstance,
} from "../../domain/mcp-entry.js";
import type { CommandResult, ExitCode } from "../../domain/types.js";
import type { ParsedArgs } from "../parser.js";
import type { QtcCommand } from "../registry.js";
import type { CliContext } from "../types.js";

// File-writing hosts derived from registry (excludes oz which has no file writer)
const FILE_HOSTS: readonly McpHost[] = HARNESSES.filter((h) => h.mcpHostId !== null).map(
  (h) => h.mcpHostId as McpHost,
);
const HOST_VALUES: ReadonlySet<string> = new Set([...FILE_HOSTS, "both", "all"]);

export const mcpCommand: QtcCommand = {
  name: "mcp",
  describe:
    "MCP server tooling. Subcomandos: dbhub <instance> | setup/remove/doctor [--host h] [--instance i] [--workspace dir] [--global] [--dry-run] [--force] | warp-status.",
  async execute(args: ParsedArgs, ctx: CliContext): Promise<CommandResult> {
    const subcommand = args.rest[0];
    if (subcommand === "dbhub") return runDbhubSub(args, ctx);
    if (subcommand === "setup") return runSetupSub(args, ctx);
    if (subcommand === "remove") return runRemoveSub(args, ctx);
    if (subcommand === "doctor") return runDoctorSub(args, ctx);
    if (subcommand === "warp-status") return runWarpStatusSub(args, ctx);
    return {
      ok: false,
      error: {
        code: "INVALID_INPUT",
        message:
          "mcp requiere subcomando: dbhub <instance> | setup | remove | doctor | warp-status",
      },
      exitCode: 1,
    };
  },
};

async function runDbhubSub(args: ParsedArgs, ctx: CliContext): Promise<CommandResult> {
  const instance = args.rest[1];
  if (!instance) {
    return {
      ok: false,
      error: {
        code: "INVALID_INPUT",
        message: "mcp dbhub requiere nombre de conexión. Ej: cert, prod o reporting",
      },
      exitCode: 1,
    };
  }
  try {
    const result = await runDbhubLauncher({
      instance,
      deps: {
        env: { ...process.env },
        paths: ctx.paths,
        platform: process.platform,
      },
    });
    return { ok: true, data: undefined, exitCode: clampExit(result.exitCode) };
  } catch (err) {
    if (err instanceof DbhubLauncherError) {
      return {
        ok: false,
        error: { code: "DBHUB_LAUNCHER_FAILED", message: err.message },
        exitCode: 1,
      };
    }
    throw err;
  }
}

async function runSetupSub(args: ParsedArgs, ctx: CliContext): Promise<CommandResult> {
  const hosts = resolveHosts(args, ctx);
  if (!("value" in hosts)) return hosts;
  const instances = resolveInstances(args);
  if (!("value" in instances)) return instances;
  const dsnVars = resolveDsnVars(args, instances.value);
  if (!("value" in dsnVars)) return dsnVars;

  const workspace = args.values.get("workspace");
  const scope: "workspace" | "global" = args.flags.has("--global") ? "global" : "workspace";
  const result = runMcpSetup(ctx.env, {
    hosts: hosts.value,
    instances: instances.value,
    scope,
    ...(workspace !== undefined ? { workspace } : {}),
    dryRun: args.flags.has("--dry-run"),
    force: args.flags.has("--force"),
    ...(dsnVars.value !== undefined ? { dsnVars: dsnVars.value } : {}),
  });

  if ("ok" in result) {
    return {
      ok: false,
      error: {
        code: "GLOBAL_REQUIRES_FORCE",
        message: result.hint,
      },
      data: result,
      exitCode: result.exitCode,
    };
  }

  const hasErrors = result.errors.length > 0;
  const warpHints = !hasErrors
    ? buildWarpHintsFor(hosts.value, instances.value, scope, ctx, workspace)
    : [];
  return {
    ok: !hasErrors,
    data: { ...result, ...(warpHints.length > 0 ? { warp_hints: warpHints } : {}) },
    ...(hasErrors
      ? {
          error: {
            code: "MCP_SETUP_PARTIAL",
            message: `${result.errors.length} error(es) durante setup; ver data.errors`,
          },
        }
      : {}),
    exitCode: hasErrors ? 1 : 0,
  };
}

function buildWarpHintsFor(
  hosts: McpHost[],
  instances: McpInstance[],
  scope: "workspace" | "global",
  ctx: CliContext,
  workspace: string | undefined,
): WarpPostInstallHint[] {
  if (!hosts.includes("warp")) return [];
  const file =
    scope === "global"
      ? (resolveWarpGlobalMcpPath() ?? "~/.warp/.mcp.json")
      : resolveWarpProjectMcpPath(resolve(workspace ?? ctx.env.cwd()));
  return instances.map((instance) =>
    buildWarpPostInstallHint(mcpEntryNameFor(instance), scope, file),
  );
}

async function runWarpStatusSub(_args: ParsedArgs, ctx: CliContext): Promise<CommandResult> {
  const projectFile = resolveWarpProjectMcpPath(resolve(ctx.env.cwd()));
  const globalFile = resolveWarpGlobalMcpPath() ?? `${homedir()}/.warp/.mcp.json`;
  const sources = [
    { scope: "workspace" as const, file: projectFile },
    { scope: "global" as const, file: globalFile },
  ];
  const reports = sources.map(({ scope, file }) => {
    const exists = existsSync(file);
    const servers = exists ? readMcpServersFromFile(file) : [];
    const hint = buildWarpPostInstallHint(servers[0] ?? "<server>", scope, file);
    return { scope, file, exists, servers, hint, hint_formatted: formatWarpPostInstallHint(hint) };
  });
  const anyDetected = reports.some((r) => r.exists);
  return {
    ok: true,
    data: {
      reports,
      summary: anyDetected
        ? "Archivos .warp/.mcp.json detectados. Activá 'File-based MCP Servers' en Warp Settings si todavía no lo hiciste."
        : "No se encontró .warp/.mcp.json en cwd ni en home. Primero registrá una conexión con 'agent-workflow mcp setup --host warp'.",
    },
    exitCode: 0,
  };
}

function readMcpServersFromFile(file: string): string[] {
  try {
    const text = readFileSync(file, "utf-8");
    if (text.trim().length === 0) return [];
    const parsed = JSON.parse(text) as { mcpServers?: Record<string, unknown> };
    if (!parsed.mcpServers || typeof parsed.mcpServers !== "object") return [];
    return Object.keys(parsed.mcpServers);
  } catch {
    return [];
  }
}

async function runRemoveSub(args: ParsedArgs, ctx: CliContext): Promise<CommandResult> {
  const hosts = resolveHosts(args, ctx);
  if (!("value" in hosts)) return hosts;
  const instances = resolveInstances(args);
  if (!("value" in instances)) return instances;

  const workspace = args.values.get("workspace");
  const result = runMcpRemove(ctx.env, {
    hosts: hosts.value,
    instances: instances.value,
    scope: args.flags.has("--global") ? "global" : "workspace",
    ...(workspace !== undefined ? { workspace } : {}),
    dryRun: args.flags.has("--dry-run"),
    force: args.flags.has("--force"),
  });

  if ("ok" in result) {
    return {
      ok: false,
      error: {
        code: "GLOBAL_REQUIRES_FORCE",
        message: result.hint,
      },
      data: result,
      exitCode: result.exitCode,
    };
  }

  const hasErrors = result.errors.length > 0;
  return {
    ok: !hasErrors,
    data: result,
    ...(hasErrors
      ? {
          error: {
            code: "MCP_REMOVE_PARTIAL",
            message: `${result.errors.length} error(es) durante remove; ver data.errors`,
          },
        }
      : {}),
    exitCode: hasErrors ? 1 : 0,
  };
}

async function runDoctorSub(args: ParsedArgs, ctx: CliContext): Promise<CommandResult> {
  const hosts = resolveHosts(args, ctx);
  if (!("value" in hosts)) return hosts;
  const instances = resolveInstances(args);
  if (!("value" in instances)) return instances;
  const dsnVars = resolveDsnVars(args, instances.value);
  if (!("value" in dsnVars)) return dsnVars;

  const workspace = args.values.get("workspace");
  const data = runMcpDoctor(ctx.env, ctx.paths, {
    hosts: hosts.value,
    instances: instances.value,
    scope: args.flags.has("--global") ? "global" : "workspace",
    ...(workspace !== undefined ? { workspace } : {}),
    ...(dsnVars.value !== undefined ? { dsnVars: dsnVars.value } : {}),
  });

  const okCount = data.summary.ok;
  const total = data.reports.length;
  const allOk = okCount === total;
  return {
    ok: allOk,
    data,
    ...(allOk
      ? {}
      : {
          error: {
            code: "MCP_DOCTOR_DRIFT",
            message: `${total - okCount}/${total} entradas con drift (ver data.reports)`,
          },
        }),
    exitCode: allOk ? 0 : 1,
  };
}

function resolveHosts(args: ParsedArgs, ctx: CliContext): { value: McpHost[] } | CommandResult {
  const flag = args.values.get("host");
  if (flag === undefined) {
    const harness = runHarness((k) => ctx.env.get(k));
    if (harness.harness === "claude-code") return { value: ["claude"] };
    if (harness.harness === "codex") return { value: ["codex"] };
    if (harness.harness === "warp") return { value: ["warp"] };
    return { value: [...FILE_HOSTS] };
  }
  if (!HOST_VALUES.has(flag)) {
    const validList = [...FILE_HOSTS, "both", "all"].join(" | ");
    return {
      ok: false,
      error: {
        code: "INVALID_INPUT",
        message: `--host inválido: '${flag}'. Valores válidos: ${validList}`,
      },
      exitCode: 1,
    };
  }
  if (flag === "both" || flag === "all") return { value: [...FILE_HOSTS] };
  return { value: [flag as McpHost] };
}

function resolveInstances(args: ParsedArgs): { value: McpInstance[] } | CommandResult {
  const flag = args.values.get("instance");
  if (flag === undefined) return { value: [...DEFAULT_MCP_INSTANCES] };
  if (flag === "both") return { value: [...DEFAULT_MCP_INSTANCES] };
  const validation = validateMcpInstance(flag);
  if (!validation.ok) {
    return {
      ok: false,
      error: {
        code: "INVALID_INPUT",
        message: `--instance inválido: '${flag}'. ${validation.error}`,
      },
      exitCode: 1,
    };
  }
  return { value: [validation.value] };
}

function resolveDsnVars(
  args: ParsedArgs,
  instances: McpInstance[],
): { value: Record<string, string> | undefined } | CommandResult {
  const flag = args.values.get("dsn-var");
  if (flag === undefined) return { value: undefined };
  if (instances.length !== 1) {
    return {
      ok: false,
      error: {
        code: "INVALID_INPUT",
        message: "--dsn-var requiere una sola conexión. Pasá también --instance <nombre>",
      },
      exitCode: 1,
    };
  }
  const validation = validateDsnVarName(flag);
  if (!validation.ok) {
    return {
      ok: false,
      error: {
        code: "INVALID_INPUT",
        message: validation.error,
      },
      exitCode: 1,
    };
  }
  const instance = instances[0];
  if (instance === undefined) return { value: undefined };
  return { value: { [instance]: validation.value } };
}

function clampExit(code: number): ExitCode {
  if (code === 0) return 0;
  if (code === 2) return 2;
  return 1;
}
