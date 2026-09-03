/**
 * What an invocation dispatches to — the whole decision, as data.
 *
 * It lives apart from `main.ts` because that module runs the CLI on import, so
 * anything decided inside it can only be read as text. The precedence between
 * the global alias and the interactive menu is the part that matters: with no
 * command and a TTY the menu opens, so a flag consulted AFTER that check would
 * never fire on the surface people actually type it on. Encoding the order here
 * means the order is something a test can exercise instead of something a
 * reader has to trust — and it leaves the dispatcher with no ordering of its
 * own to get wrong.
 */
import { shouldShowInteractiveMenu } from "./interactive-menu.js";

export type DispatchPlan =
  /** Open the TUI: no command, a terminal, and no help asked for. */
  | { kind: "menu" }
  /** Print the command list: no command and no terminal to open a menu in. */
  | { kind: "global-help" }
  /** Run this command — named, never a literal the dispatcher chooses. */
  | { kind: "command"; name: string; help: boolean };

export interface DispatchInput {
  command: string | undefined;
  flags: ReadonlySet<string>;
  isTTY: boolean;
  hasHelp: boolean;
}

/**
 * The global flags that ARE a command when nothing else is in front of them.
 *
 * A table rather than a chain of ifs, so adding one is a row and the precedence
 * against the menu stays a single fact. The flag is spelled with its dashes
 * because that is how the parser stores a boolean flag.
 */
const GLOBAL_ALIASES: ReadonlyMap<string, string> = new Map([["--doctor", "doctor"]]);

export function planDispatch(input: DispatchInput): DispatchPlan {
  const alias = resolveGlobalAlias(input);
  if (alias !== undefined) return { kind: "command", name: alias, help: input.hasHelp };
  if (shouldShowInteractiveMenu(input)) return { kind: "menu" };
  if (input.command === undefined) return { kind: "global-help" };
  return { kind: "command", name: input.command, help: input.hasHelp };
}

/**
 * The alias a bare invocation carries, or `undefined`.
 *
 * With an explicit command in front it is NOT an alias: it stays an unknown flag
 * of that command, which is what the commands calling `reviewFlags` report.
 */
export function resolveGlobalAlias(input: DispatchInput): string | undefined {
  if (input.command !== undefined) return undefined;
  for (const [flag, command] of GLOBAL_ALIASES) {
    if (input.flags.has(flag)) return command;
  }
  return undefined;
}
