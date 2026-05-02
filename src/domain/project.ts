import type { Phase } from "./types.js";

export type WorkspaceMode = "project" | "hub";

export interface SourceRef {
  alias: string;
  path: string;
  mainBranch: string;
}

export interface SessionStatus {
  folder: string;
  phase: Phase;
  branches: string[];
}

export interface ProjectBlock {
  proyecto: string;
  mode: WorkspaceMode;
  fuentes: SourceRef[];
  stack: Record<string, unknown>;
  sessions: SessionStatus[];
  workingBranches: Record<string, string>;
  lastActivity?: string;
}
