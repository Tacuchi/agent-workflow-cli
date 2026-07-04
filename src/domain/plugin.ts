import type { Harness } from "./harnesses.js";
import type { SessionType } from "./types.js";

// Re-export the canonical harness union (single source: domain/harnesses.ts) so
// the public API surface and PluginContext.harness stay aligned with the host
// registry.
export type { Harness };

export interface PluginContext {
  type?: SessionType;
  pluginName: string;
  pluginVersion: string;
  pluginRoot?: string;
  compatRange?: string;
  harness?: Harness;
}
