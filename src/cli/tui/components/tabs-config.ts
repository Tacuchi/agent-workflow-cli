// Shared types of the TUI shell — single source for the tab list, the
// workspace context and the global keymap.

export type TabId = "status" | "workflow" | "project" | "mcp" | "skills" | "config";

export interface TabConfig {
  id: TabId;
  key: string;
  label: string;
  badge?: string;
  alert?: boolean;
}

/** Canonical tab list in presentation order + numeric shortcut. */
export const TABS_LIST: readonly TabConfig[] = [
  { id: "status", key: "1", label: "Status" },
  { id: "workflow", key: "2", label: "Workline" },
  { id: "project", key: "3", label: "Project" },
  { id: "mcp", key: "4", label: "MCP" },
  { id: "skills", key: "5", label: "Skills" },
  { id: "config", key: "6", label: "Config" },
] as const;

export interface WorkspaceContext {
  branchLabel: string;
  sessionsLabel: string;
}

export interface KeymapEntry {
  key: string;
  action: string;
}
