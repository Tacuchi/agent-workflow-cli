export const RETIRED_MARKER_FILE = "workline.json";
export const RETIRED_MARKER_KEY = "workline";
export const RETIRED_HEADING = "Workline";
export const RETIRED_NOTE_SCHEMA = "workline.decision-note/v1";
export const RETIRED_INDEX_SCHEMA = "workline.decision-index/v1";
export const RETIRED_MANAGED_BLOCK_BEGIN =
  "# >>> agent-workflow (Workline) managed hooks — do not edit inside this block >>>";
export const RETIRED_MANAGED_BLOCK_END = "# <<< agent-workflow (Workline) managed hooks <<<";
export const RETIRED_TOPIC_MARKER = /\bworkline\b/i;

export function isRetiredManagedHookMarker(line: string): boolean {
  return line === RETIRED_MANAGED_BLOCK_BEGIN || line === RETIRED_MANAGED_BLOCK_END;
}

export function acceptsNoteSchema(value: unknown): boolean {
  return value === "agent-workflow.decision-note/v1" || value === RETIRED_NOTE_SCHEMA;
}

export function acceptsIndexSchema(value: unknown): boolean {
  return value === "agent-workflow.decision-index/v1" || value === RETIRED_INDEX_SCHEMA;
}
