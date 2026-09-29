import { createHash } from "node:crypto";

/** Exact identity of Workline's previously generated OpenCode plugin. */
export const OPENCODE_PLUGIN_FILE = "agent-workflow.js";
export const OPENCODE_PLUGIN_MARKER = "// agent-workflow (Workline) — generated plugin";
/** SHA-256 of the complete 26.0.0 module generated from the bundled hook template. */
const OWNED_PLUGIN_26 = "3462d53387247420bf8543896aa5ea8fdd3784667cb7b5d4b8f1f5eceb8beb59";

/** Retire only the module Workline generated, never one that occupies its path. */
export function isOurOpencodePlugin(source: string): boolean {
  return (
    source.startsWith(OPENCODE_PLUGIN_MARKER) &&
    createHash("sha256").update(source, "utf8").digest("hex") === OWNED_PLUGIN_26
  );
}

/** Drop only the old module's entry; preserve every other plugin. */
export function undeclareOpencodePlugin(
  config: Record<string, unknown>,
  pluginPath: string,
): { value: Record<string, unknown>; removed: boolean } {
  const declared = Array.isArray(config.plugin) ? config.plugin : null;
  if (declared === null || !declared.includes(pluginPath)) return { value: config, removed: false };
  const kept = declared.filter((entry) => entry !== pluginPath);
  if (kept.length > 0) return { value: { ...config, plugin: kept }, removed: true };
  const { plugin: _dropped, ...rest } = config;
  return { value: rest, removed: true };
}
