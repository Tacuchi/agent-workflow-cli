import type { PathsService } from "../application/paths-service.js";
import type { EnvPort } from "../ports/env.js";
import type { FileSystemPort } from "../ports/file-system.js";
import {
  type AgentWorkflowRuntimeConfig,
  DEFAULT_RUNTIME_CONFIG,
  type ResolvedRuntime,
  type SlashCommandHints,
} from "./types.js";

export interface RuntimeConfigServiceOptions {
  coreConfigPath?: string;
}

export class RuntimeConfigService {
  constructor(
    private readonly fs: FileSystemPort,
    private readonly env: EnvPort,
    private readonly paths: PathsService,
    private readonly options: RuntimeConfigServiceOptions = {},
  ) {}

  async resolveRuntime(): Promise<ResolvedRuntime> {
    const fromEnv = this.resolveFromEnv();
    if (fromEnv) {
      return fromEnv;
    }

    const userConfigPath = this.userConfigPath();
    const fromUserConfig = await this.tryReadConfig(userConfigPath, "user-config");
    if (fromUserConfig) {
      return fromUserConfig;
    }

    const coreConfigPath = this.options.coreConfigPath;
    if (coreConfigPath) {
      const fromCoreConfig = await this.tryReadConfig(coreConfigPath, "core-config");
      if (fromCoreConfig) {
        return fromCoreConfig;
      }
    }

    return {
      packageName: DEFAULT_RUNTIME_CONFIG.packageName,
      binName: DEFAULT_RUNTIME_CONFIG.binName,
      source: "default",
    };
  }

  private resolveFromEnv(): ResolvedRuntime | undefined {
    const override = this.env.get(DEFAULT_RUNTIME_CONFIG.envOverride);
    if (!override || override.trim().length === 0) {
      return undefined;
    }
    return {
      packageName: DEFAULT_RUNTIME_CONFIG.packageName,
      binName: override.trim(),
      source: "env",
    };
  }

  private userConfigPath(): string {
    return this.paths.userRuntimeJson();
  }

  private async tryReadConfig(
    path: string,
    source: "user-config" | "core-config",
  ): Promise<ResolvedRuntime | undefined> {
    if (!(await this.fs.exists(path))) {
      return undefined;
    }
    const raw = await this.fs.readText(path);
    const parsed = parseConfig(raw, path);
    const resolved: ResolvedRuntime = {
      packageName: parsed.packageName,
      binName: parsed.binName,
      source,
      configPath: path,
    };
    if (parsed.displayName !== undefined) resolved.displayName = parsed.displayName;
    if (parsed.mcpGuards !== undefined) resolved.mcpGuards = parsed.mcpGuards;
    if (parsed.expectedMcpServers !== undefined) {
      resolved.expectedMcpServers = parsed.expectedMcpServers;
    }
    if (parsed.slashCommands !== undefined) resolved.slashCommands = parsed.slashCommands;
    return resolved;
  }
}

function parseConfig(raw: string, path: string): AgentWorkflowRuntimeConfig {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Invalid JSON in runtime config ${path}: ${(err as Error).message}`);
  }
  if (!isRecord(json)) {
    throw new Error(`Runtime config ${path} must be a JSON object`);
  }
  const packageName = requireString(json, "packageName", path);
  const binName = requireString(json, "binName", path);
  const envOverride = requireString(json, "envOverride", path);

  const config: AgentWorkflowRuntimeConfig = { packageName, binName, envOverride };
  if (typeof json.schemaVersion === "number") {
    config.schemaVersion = json.schemaVersion;
  }
  if (typeof json.displayName === "string" && json.displayName.length > 0) {
    config.displayName = json.displayName;
  }
  const mcpGuards = parseMcpGuards(json.mcpGuards);
  if (mcpGuards) config.mcpGuards = mcpGuards;
  const expectedMcpServers = parseExpectedMcpServers(json.expectedMcpServers);
  if (expectedMcpServers) config.expectedMcpServers = expectedMcpServers;
  const slashCommands = parseSlashCommands(json.slashCommands);
  if (slashCommands) config.slashCommands = slashCommands;
  return config;
}

function parseMcpGuards(value: unknown): AgentWorkflowRuntimeConfig["mcpGuards"] | undefined {
  if (!isRecord(value)) return undefined;
  const sql = value.sqlMutation;
  if (
    isRecord(sql) &&
    typeof sql.toolPattern === "string" &&
    typeof sql.serverPattern === "string"
  ) {
    return {
      sqlMutation: { toolPattern: sql.toolPattern, serverPattern: sql.serverPattern },
    };
  }
  return undefined;
}

function parseExpectedMcpServers(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter((s): s is string => typeof s === "string");
}

function parseSlashCommands(value: unknown): SlashCommandHints | undefined {
  if (!isRecord(value)) return undefined;
  const hints: SlashCommandHints = {};
  for (const key of ["migrate", "projectInit", "resume", "session"] as const) {
    const v = value[key];
    if (typeof v === "string") hints[key] = v;
  }
  return hints;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireString(obj: Record<string, unknown>, key: string, path: string): string {
  const value = obj[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Runtime config ${path} missing or invalid string field '${key}'`);
  }
  return value.trim();
}
