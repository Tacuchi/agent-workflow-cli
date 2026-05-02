import type { Flow, Phase } from "./types.js";

export type Harness = "codex" | "claude" | "unknown";

export interface PluginContext {
  flow: Flow;
  pluginName: string;
  pluginVersion: string;
  pluginRoot?: string;
  compatRange?: string;
  harness?: Harness;
}

export interface WorkflowDescriptor {
  flow: Flow;
  plugin: string;
  skillPath?: string;
  sessionArgs: Record<string, string>;
  artifactsByPhase: Partial<Record<Phase, string>>;
  skillsByPhase: Partial<Record<Phase, string>>;
  refsFormat: Record<string, string>;
  resumeCounters: Record<string, string>;
}
