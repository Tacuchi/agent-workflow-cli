import { RETIRED_TOPIC_MARKER } from "../retired-name.js";

/**
 * Whether a piece of host memory is about agent-workflow.
 *
 * A note's type cannot tell (most agent-workflow learnings are filed as `project`), so
 * the test is what the text names: the tool, its command family, its hub
 * folder, or a real `aw` command. Checking `aw <x>` against the installed command
 * table keeps an unrelated "aw" out.
 */
const MARKERS: readonly RegExp[] = [
  RETIRED_TOPIC_MARKER,
  /agent-workflow/i,
  /\/w:[a-z]/,
  /\.workflow\//,
];
/** An `aw <token>` mention, the whole token captured so `aw hasOwnProperty` is not read as `aw has`. */
export const AW_COMMAND_MENTION = /\baw\s+([A-Za-z][\w-]*)/g;

export function isAgentWorkflowTopic(text: string, commands: ReadonlySet<string>): boolean {
  if (MARKERS.some((marker) => marker.test(text))) return true;
  for (const match of text.matchAll(AW_COMMAND_MENTION)) {
    if (commands.has(match[1] ?? "")) return true;
  }
  return false;
}
