import type { Flow, Phase, SessionState } from "./types.js";

export type Modalidad = "technical" | "data" | "incident" | "tecnica" | "datos" | "incidente";
export type Tipo = "project" | "system" | "proyecto" | "sistema" | "feature" | "refactor" | "chore";
export type TaskStatus = "open" | "closed";

export interface SessionRef {
  code: string;
  flow: Flow;
  name: string;
  folder: string;
  path: string;
  state: SessionState;
  phase: Phase;
  date?: string;
  summary?: string;
}

export interface HandoffRef {
  flow: Flow;
  code: string;
  folder?: string;
  deliverableName?: string;
  deliverableExists?: boolean;
}

export interface ObjectiveData {
  session: string;
  code: string;
  flow: Flow;
  modalidad?: Modalidad;
  tipo?: Tipo;
  brief: string;
  criteriosAceptacion: string[];
  fuentesMencionadas: string[];
  origen?: HandoffRef;
}

export interface TaskItem {
  n: number;
  status: TaskStatus;
  text: string;
}
