import type { SessionState, SessionType } from "./types.js";

export type TaskStatus = "open" | "closed";

/**
 * Lightweight descriptor of an internal session. Sessions are created by loops
 * (Layer 2) and carry a {@link SessionType} (research|refine|exec|quick).
 */
export interface SessionRef {
  name: string;
  folder: string;
  path: string;
  type?: SessionType;
  state: SessionState;
  date?: string;
  summary?: string;
}

export interface TaskItem {
  n: number;
  status: TaskStatus;
  text: string;
}
