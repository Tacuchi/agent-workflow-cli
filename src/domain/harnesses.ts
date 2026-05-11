import type { McpHost } from "./mcp-entry.js";

export type Harness = "claude-code" | "codex" | "warp" | "oz" | "unknown";

// Canonical key used as TARGET_ROOTS key in install-skill (Phase 2 wires this up)
export type InstallTarget = "claude" | "codex" | "agents" | "warp" | "oz";

export type HarnessChannel = "stable" | "preview";

// Platform-specific global MCP config paths. `~` is a placeholder expanded at runtime.
export interface HarnessGlobalMcpPaths {
  darwin: { stable: string; preview?: string };
  linux: { stable: string; preview?: string };
  win32: { stable: string; preview?: string };
}

export interface HarnessSpec {
  id: Exclude<Harness, "unknown">;
  // Env vars (any one present → this harness). Checked first-match in order.
  envMarkers: readonly string[];
  // TERM_PROGRAM value that also triggers detection (e.g. "WarpTerminal")
  termProgramMatch?: string;
  // null → harness does not write an MCP config file (e.g. Oz emits via --mcp flag)
  mcpHostId: McpHost | null;
  // Absolute-path template for global MCP config, by platform + channel
  globalMcpPaths?: HarnessGlobalMcpPaths;
  // Relative path from project root for project-scoped MCP config
  projectMcpPath?: string;
  // Relative path to plugin manifest from project root; null = no manifest
  pluginManifest: string | null;
  // Subdirectory name under project root for hooks; null = no hooks
  pluginHooksDir: string | null;
  // Directories where skills are auto-discovered (relative to project root)
  skillsDirs: readonly string[];
  // Primary install destination used by install-skill
  installTarget: InstallTarget;
}

export const HARNESSES: readonly HarnessSpec[] = [
  {
    id: "claude-code",
    envMarkers: ["CLAUDECODE", "CLAUDE_PLUGIN_ROOT", "CLAUDE_AGENT_ID"],
    mcpHostId: "claude",
    globalMcpPaths: {
      darwin: { stable: "~/.claude.json" },
      linux: { stable: "~/.claude.json" },
      win32: { stable: "~/.claude.json" },
    },
    projectMcpPath: ".mcp.json",
    pluginManifest: ".claude-plugin/plugin.json",
    pluginHooksDir: "hooks",
    skillsDirs: [".claude/skills"],
    installTarget: "claude",
  },
  {
    id: "codex",
    envMarkers: ["CODEX_HOME", "CODEX_CLI", "CODEX_RUNTIME"],
    mcpHostId: "codex",
    globalMcpPaths: {
      darwin: { stable: "~/.codex/config.toml" },
      linux: { stable: "~/.codex/config.toml" },
      win32: { stable: "~/.codex/config.toml" },
    },
    projectMcpPath: ".codex/config.toml",
    pluginManifest: ".codex-plugin/plugin.json",
    pluginHooksDir: "codex-hooks",
    skillsDirs: [".codex/skills"],
    installTarget: "codex",
  },
  {
    // Detection: OZ_RUN_ID takes priority over warp markers to handle overlap.
    // Keep oz before warp in the array so first-match detection picks oz first
    // when both OZ_RUN_ID and TERM_PROGRAM=WarpTerminal are set.
    id: "oz",
    envMarkers: ["OZ_RUN_ID"],
    mcpHostId: null, // Oz does not write a config file; emits JSON for --mcp flag
    pluginManifest: null,
    pluginHooksDir: null,
    skillsDirs: [".agents/skills"],
    installTarget: "oz",
  },
  {
    id: "warp",
    envMarkers: ["WARP_IS_LOCAL_SHELL_SESSION"],
    termProgramMatch: "WarpTerminal",
    mcpHostId: "warp",
    globalMcpPaths: {
      // DEC-W3: Warp uses .mcp.json (JSON), not settings.toml, for MCP config.
      darwin: { stable: "~/.warp/.mcp.json", preview: "~/.warp-preview/.mcp.json" },
      linux: {
        stable: "~/.config/warp-terminal/.mcp.json",
        preview: "~/.config/warp-terminal-preview/.mcp.json",
      },
      win32: {
        stable: "%LOCALAPPDATA%/warp/Warp/config/.mcp.json",
        preview: "%LOCALAPPDATA%/warp/WarpPreview/config/.mcp.json",
      },
    },
    projectMcpPath: ".warp/.mcp.json",
    pluginManifest: null, // DEC-W2: no plugin manifest convention for Warp
    pluginHooksDir: null, // DEC-W4: no hooks system in Warp/Oz
    // Warp auto-discovers skills from all these dirs; primary install target is .warp/skills
    skillsDirs: [".warp/skills", ".agents/skills", ".claude/skills", ".codex/skills"],
    installTarget: "warp",
  },
] as const satisfies readonly HarnessSpec[];

/**
 * Resolves the global MCP config path for a harness spec.
 * Expands %LOCALAPPDATA% on win32. Does NOT expand `~` (caller uses homedir()).
 */
export function resolveGlobalMcpRawPath(
  spec: HarnessSpec,
  platform: NodeJS.Platform = process.platform,
  channel: HarnessChannel = "stable",
): string | null {
  if (!spec.globalMcpPaths) return null;
  const byPlatform =
    platform === "darwin"
      ? spec.globalMcpPaths.darwin
      : platform === "linux"
        ? spec.globalMcpPaths.linux
        : spec.globalMcpPaths.win32;
  return (channel === "preview" ? byPlatform.preview : null) ?? byPlatform.stable;
}

/** Returns the HarnessSpec for a given McpHost id, or null. */
export function harnessForMcpHost(host: McpHost): HarnessSpec | null {
  return HARNESSES.find((h) => h.mcpHostId === host) ?? null;
}

/** Returns the HarnessSpec for a given harness id, or null. */
export function harnessById(id: Exclude<Harness, "unknown">): HarnessSpec | null {
  return HARNESSES.find((h) => h.id === id) ?? null;
}
