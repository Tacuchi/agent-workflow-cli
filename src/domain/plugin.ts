import type { SessionType } from "./types.js";

export type Harness = "codex" | "claude" | "unknown";

export interface PluginContext {
  type?: SessionType;
  pluginName: string;
  pluginVersion: string;
  pluginRoot?: string;
  compatRange?: string;
  harness?: Harness;
}
