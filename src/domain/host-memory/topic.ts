/**
 * Whether a piece of host memory is about Workline.
 *
 * A note's type cannot tell (most Workline learnings are filed as `project`), so
 * the test is what the text names: the tool, its command family, its hub
 * folder, or a real `aw` command. Checking `aw <x>` against the installed command
 * table keeps an unrelated "aw" out.
 */
const MARKERS: readonly RegExp[] = [
  /\bworkline\b/i,
  /agent-workflow/i,
  /\/w:[a-z]/,
  /\.workflow\//,
];
/** An `aw <token>` mention, the whole token captured so `aw hasOwnProperty` is not read as `aw has`. */
export const AW_COMMAND_MENTION = /\baw\s+([A-Za-z][\w-]*)/g;

export function isWorklineTopic(text: string, commands: ReadonlySet<string>): boolean {
  if (MARKERS.some((marker) => marker.test(text))) return true;
  for (const match of text.matchAll(AW_COMMAND_MENTION)) {
    if (commands.has(match[1] ?? "")) return true;
  }
  return false;
}
