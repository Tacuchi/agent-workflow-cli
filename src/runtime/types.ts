export interface SlashCommandHints {
  migrate?: string;
}

export interface AgentWorkflowRuntimeConfig {
  packageName: string;
  binName: string;
  envOverride: string;
  /** Optional human-readable name (e.g., "Acme Workflow"). Default: namespace. */
  displayName?: string;
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
  slashCommands?: SlashCommandHints;
}

export const DEFAULT_RUNTIME_CONFIG: AgentWorkflowRuntimeConfig = {
  packageName: "@tacuchi/agent-workflow-cli",
  binName: "agent-workflow",
  envOverride: "AW_AGENT_WORKFLOW_BIN",
  displayName: "agent-workflow",
};
