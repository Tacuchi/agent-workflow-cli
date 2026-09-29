/**
 * The typed form of an error's next action (spec 061 AC-05).
 *
 * `data.action` stays the text a person reads. Beside it the CLI publishes
 * `data.next_step`: the one command that is the next step, runnable as written,
 * or the alternatives when more than one exit is valid. A step the CLI does not
 * know gets no `next_step` at all rather than an invented one.
 */
export type NextStep = { command: string } | { alternatives: string[] };

/** A quoted `aw …` span, or a text that is itself an `aw …` invocation. */
const QUOTED = /[`']((?:aw) [^`']+)[`']/g;

/** A command still holding a placeholder is a shape, not something to run. */
function runnable(command: string): boolean {
  return !/<[^>]+>/.test(command) && !/\[[^\]]*\]/.test(command);
}

/**
 * The one runnable `aw` command an action text names, or null.
 *
 * Only an action naming exactly ONE command yields it: two quoted commands are
 * as often steps to run in order as they are alternatives, and a text cannot
 * say which, so neither is derived. A command still holding a placeholder is a
 * shape and yields nothing.
 */
export function commandIn(action: string): string | null {
  const found = [...action.matchAll(QUOTED)].map((match) => (match[1] ?? "").trim());
  if (found.length === 0 && action.trim().startsWith("aw ")) {
    found.push(action.trim().replace(/[.;:]+$/, ""));
  }
  const [only] = found;
  return found.length === 1 && only !== undefined && runnable(only) ? only : null;
}

/** One command, the alternatives, or nothing: never a guess between two exits. */
export function nextStepOf(commands: readonly string[]): NextStep | null {
  if (commands.length === 0) return null;
  if (commands.length === 1) return { command: commands[0] as string };
  return { alternatives: [...commands] };
}
