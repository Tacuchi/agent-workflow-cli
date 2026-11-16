export const RETIRED_MARKER_FILE = "workline.json";
export const RETIRED_MARKER_KEY = "workline";
export const RETIRED_HEADING = "Workline";
export const RETIRED_NOTE_SCHEMA = "workline.decision-note/v1";
export const RETIRED_INDEX_SCHEMA = "workline.decision-index/v1";
export const RETIRED_RECEIPT_KEY = "workline_version";

export function acceptsNoteSchema(value: unknown): boolean {
  return value === "agent-workflow.decision-note/v1" || value === RETIRED_NOTE_SCHEMA;
}

export function acceptsIndexSchema(value: unknown): boolean {
  return value === "agent-workflow.decision-index/v1" || value === RETIRED_INDEX_SCHEMA;
}
