import { gateFlags } from "../../src/cli/commands/unknown-flags.js";
import type { ParsedArgs } from "../../src/cli/parser.js";
import type { CliCommand } from "../../src/cli/registry.js";
import type { CliContext } from "../../src/cli/types.js";
import type { CommandResult } from "../../src/domain/types.js";

/**
 * A command as the dispatcher runs it: the flag gate first, `execute` only when
 * it lets the invocation through. main.ts runs the CLI on import, so tests of a
 * refusal go through this instead of calling `execute` directly.
 */
export async function dispatch<O>(
  command: CliCommand<O>,
  args: ParsedArgs,
  ctx: CliContext,
): Promise<CommandResult<O>> {
  const gate = gateFlags(command as CliCommand, args);
  if (gate.kind === "refuse") return gate.result as CommandResult<O>;
  return command.execute(args, ctx);
}
