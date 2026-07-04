export interface McpGuardSqlPatterns {
  toolPattern: string; // regex source (string) — matched against full tool name
  serverPattern: string; // regex source (string) — used in error message extraction
}

export interface McpGuards {
  sqlMutation?: McpGuardSqlPatterns;
}

export interface SlashCommandHints {
  migrate?: string;
}

export interface AgentWorkflowRuntimeConfig {
  packageName: string;
  binName: string;
  envOverride: string;
  /** Optional human-readable name (e.g., "Acme Workflow"). Default: namespace. */
  displayName?: string;
  /** PreToolUse guard configurations. Empty = guard disabled. */
  mcpGuards?: McpGuards;
  /** MCP servers expected by this namespace (used by plugin-doctor). Empty = no MCP expectations. */
  expectedMcpServers?: string[];
  /** Hint strings that reference slash commands. Used in error messages. */
  slashCommands?: SlashCommandHints;
}

export type RuntimeSource = "env" | "user-config" | "default";

export interface ResolvedRuntime {
  packageName: string;
  binName: string;
  source: RuntimeSource;
  configPath?: string;
  /** Extended fields (only populated when sourced from a config file that includes them). */
  displayName?: string;
  mcpGuards?: McpGuards;
  expectedMcpServers?: string[];
  slashCommands?: SlashCommandHints;
}

export const DEFAULT_RUNTIME_CONFIG: AgentWorkflowRuntimeConfig = {
  packageName: "@tacuchi/agent-workflow-cli",
  binName: "agent-workflow",
  envOverride: "AW_AGENT_WORKFLOW_BIN",
  displayName: "agent-workflow",
};
