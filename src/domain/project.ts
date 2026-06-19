export type WorkspaceMode = "project" | "hub";

export interface SourceRef {
  alias: string;
  path: string;
  mainBranch: string;
}

export interface ProjectBlock {
  proyecto: string;
  mode: WorkspaceMode;
  fuentes: SourceRef[];
  stack: Record<string, unknown>;
  workingBranches: Record<string, string>;
  lastActivity?: string;
}
