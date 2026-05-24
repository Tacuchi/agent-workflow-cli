// Tipos compartidos del shell TUI — origen único para la lista de tabs,
// el contexto de workspace y el keymap global.
//
// Antes vivían en `components/sidebar.tsx`. Con la migración a "palette como
// home" (session089) la sidebar fue eliminada y los tipos quedan acá, neutros.

export type TabId = "status" | "workflow" | "project" | "mcp" | "skills";

export interface TabConfig {
  id: TabId;
  key: string;
  label: string;
  badge?: string;
  alert?: boolean;
}

export interface WorkspaceContext {
  modeLabel: string;
  branchLabel: string;
  sessionsLabel: string;
}

export interface KeymapEntry {
  key: string;
  action: string;
}
