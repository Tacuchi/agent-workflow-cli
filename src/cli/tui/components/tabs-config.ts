// Tipos compartidos del shell TUI — origen único para la lista de tabs,
// el contexto de workspace y el keymap global.
//
// Antes vivían en `components/sidebar.tsx`. Con la migración a "palette como
// home" (session089) la sidebar fue eliminada y los tipos quedan acá, neutros.

export type TabId = "status" | "workflow" | "project" | "mcp" | "skills" | "config";

export interface TabConfig {
  id: TabId;
  key: string;
  label: string;
  badge?: string;
  alert?: boolean;
}

/** Lista canónica de tabs en orden de presentación + atajo numérico. */
export const TABS_LIST: readonly TabConfig[] = [
  { id: "status", key: "1", label: "Status" },
  { id: "workflow", key: "2", label: "Workflows" },
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
