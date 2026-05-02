export interface AgentWorkflowRuntimeConfig {
  packageName: string;
  binName: string;
  envOverride: string;
}

export type RuntimeSource = "env" | "user-config" | "core-config" | "default";

export interface ResolvedRuntime {
  packageName: string;
  binName: string;
  source: RuntimeSource;
  configPath?: string;
}

export const DEFAULT_RUNTIME_CONFIG: AgentWorkflowRuntimeConfig = {
  packageName: "@tacuchi/agent-workflow",
  binName: "agent-workflow",
  envOverride: "QTC_AGENT_WORKFLOW_BIN",
};
